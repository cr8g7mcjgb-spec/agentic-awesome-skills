/**
 * Reading the formats Korean reference material actually ships in.
 *
 * Most of what is worth pulling - past exam papers, agency reports, notices -
 * is a PDF, an HWP, or a scan, none of which the HTML reader can touch.
 *
 * Nothing here uses a library. That is not thrift for its own sake: pdf.js is
 * 1.5 MB, and a Worker that large can no longer be deployed by pasting it into
 * the Cloudflare editor, which is the only deploy route this project has. So
 * each format uses something already present at the edge:
 *
 *   HWPX  - a zip of XML, opened with the built-in DecompressionStream
 *   PDF   - its own Flate streams first, then r.jina.ai, the keyless reader
 *           already used as a fallback for HTML
 *   image - handed to the model as an image; no extraction at all
 *
 * Measured against real Korean PDFs found through Naver (see
 * scripts/probe_pdf.py): r.jina.ai returned Korean text for 3 of 4, while raw
 * stream extraction managed 1 of 4 because Korean PDFs usually encode text as
 * font glyph ids that need the file's own ToUnicode map to become letters.
 * Hence the order, and hence the confidence gate on the raw route.
 */

import { NaverError, htmlToText } from "./naver.js";
import { extractPdfText } from "./pdf.js";

export const MOBILE_UA =
  "Mozilla/5.0 (Linux; Android 14; SM-S928N) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/126.0.6478.122 Mobile Safari/537.36";

// A Worker has a memory ceiling and the model has a context one. Refuse early
// with the size rather than dying halfway through a 60 MB scan.
const MAX_BYTES = 12 * 1024 * 1024;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
// Past this, downloading the PDF to try the local route is wasted work - hand
// the URL straight to the reader, which fetches it itself.
const RAW_ROUTE_LIMIT = 6 * 1024 * 1024;

const EXT = /\.(pdf|hwpx?|jpe?g|png|gif|webp|bmp)(?:$|[?#])/i;
const HANGUL = /[가-힣]/g;

/** What a URL and its response headers say the file is. */
export function detectKind(url, contentType = "") {
  const ct = contentType.toLowerCase();
  if (ct.includes("application/pdf")) return "pdf";
  if (ct.includes("hwpml") || ct.includes("x-hwp")) return "hwp";
  if (ct.startsWith("image/")) return "image";

  const m = String(url).match(EXT);
  if (!m) return null;
  const ext = m[1].toLowerCase();
  if (ext === "pdf") return "pdf";
  if (ext === "hwpx") return "hwpx";
  if (ext === "hwp") return "hwp";
  return "image";
}

async function fetchBinary(url, referer, { maxBody = MAX_BYTES } = {}) {
  const resp = await fetch(url, {
    headers: {
      "User-Agent": MOBILE_UA,
      "Accept-Language": "ko-KR,ko;q=0.9",
      Accept: "*/*",
      ...(referer ? { Referer: referer } : {}),
    },
    redirect: "follow",
  });

  if (resp.status === 403 || resp.status === 429) {
    throw new NaverError("BLOCKED", `파일 서버가 요청을 거부했습니다 (HTTP ${resp.status}).`, { url });
  }
  if (resp.status === 404) {
    throw new NaverError("NOT_FOUND", "파일이 존재하지 않습니다 (HTTP 404).", { url });
  }
  if (!resp.ok) {
    throw new NaverError("UPSTREAM", `파일을 받지 못했습니다 (HTTP ${resp.status}).`, { url });
  }

  const contentType = resp.headers.get("Content-Type") || "";
  const declared = Number(resp.headers.get("Content-Length") || 0);
  if (declared > maxBody) {
    // Reading a 10 MB body only to skip the local route wastes the Worker's
    // memory and the user's time. Let the caller decide with the size alone.
    resp.body?.cancel();
    return { buf: null, contentType, declared };
  }

  const buf = new Uint8Array(await resp.arrayBuffer());
  if (buf.byteLength > MAX_BYTES) {
    throw new NaverError(
      "TOO_LARGE",
      `파일이 ${(buf.byteLength / 1048576).toFixed(1)}MB로 너무 큽니다.`,
      { url, bytes: buf.byteLength }
    );
  }
  return { buf, contentType, declared };
}

/* ------------------------------------------------------------- inflate */

async function inflateRaw(bytes) {
  const stream = new Response(bytes).body.pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/* ------------------------------------------------------------------ HWPX */

/**
 * HWPX is a zip of XML. Rather than pull in a zip library, walk the local file
 * headers directly - the format is a handful of little-endian fields - and let
 * DecompressionStream do the only hard part.
 */
export async function readHwpxBytes(buf, url) {
  const files = unzipEntries(buf);
  const sections = Object.keys(files)
    .filter((n) => /Contents\/section\d*\.xml$/i.test(n))
    .sort();

  if (!sections.length) {
    throw new NaverError(
      "PARSE_FAILED",
      "HWPX 안에서 본문 파일(Contents/section*.xml)을 찾지 못했습니다.",
      { url, entries: Object.keys(files).slice(0, 12) }
    );
  }

  const parts = [];
  for (const name of sections) {
    const raw = files[name];
    let bytes;
    try {
      bytes = raw.method === 8 ? await inflateRaw(raw.data) : raw.data;
    } catch (e) {
      throw new NaverError("PARSE_FAILED", `HWPX 압축을 풀지 못했습니다: ${e.message}`, { url, name });
    }
    const xml = new TextDecoder().decode(bytes);
    // <hp:t> carries the runs of visible text; paragraphs end at </hp:p>.
    // Both are matched in one pass so the line breaks land between the runs
    // they separate instead of all collecting at the end.
    for (const m of xml.matchAll(/<hp:t[^>]*>([\s\S]*?)<\/hp:t>|<\/hp:p>/g)) {
      parts.push(m[1] === undefined ? "\n" : m[1]);
    }
    parts.push("\n");
  }

  const text = htmlToText(parts.join("")).trim();
  if (text.length < 20) {
    throw new NaverError("PARSE_FAILED", "HWPX를 열었지만 본문 텍스트가 비어 있습니다.", { url });
  }
  return { text, pages: sections.length, how: "hwpx-zip" };
}

/**
 * List a zip's entries from its central directory.
 *
 * Walking the local file headers instead looks simpler until a real file
 * arrives: a directory entry has a zero compressed size, and an entry written
 * with a data descriptor carries its sizes *after* the data, so both leave the
 * walk with nowhere to jump to. The central directory at the end of the file
 * holds every offset and size in one place, which is why it exists.
 */
export function unzipEntries(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  // The end-of-central-directory record sits within the last 64 KB, after a
  // trailing comment of unknown length - so it has to be searched backwards.
  let eocd = -1;
  const from = Math.max(0, buf.length - 66_000);
  for (let i = buf.length - 22; i >= from; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return {};

  const count = dv.getUint16(eocd + 10, true);
  let at = dv.getUint32(eocd + 16, true);
  const out = {};
  const dec = new TextDecoder();

  for (let n = 0; n < count && at + 46 <= buf.length; n++) {
    if (dv.getUint32(at, true) !== 0x02014b50) break;
    const method = dv.getUint16(at + 10, true);
    const compSize = dv.getUint32(at + 20, true);
    const nameLen = dv.getUint16(at + 28, true);
    const extraLen = dv.getUint16(at + 30, true);
    const commentLen = dv.getUint16(at + 32, true);
    const localAt = dv.getUint32(at + 42, true);
    const name = dec.decode(buf.subarray(at + 46, at + 46 + nameLen));

    // The local header repeats the name and extra fields, and its extra field
    // length can differ from the central one - so read it, do not assume it.
    if (localAt + 30 <= buf.length && dv.getUint32(localAt, true) === 0x04034b50) {
      const lNameLen = dv.getUint16(localAt + 26, true);
      const lExtraLen = dv.getUint16(localAt + 28, true);
      const dataAt = localAt + 30 + lNameLen + lExtraLen;
      out[name] = { method, data: buf.subarray(dataAt, dataAt + compSize) };
    }
    at += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/* ------------------------------------------------------------------- PDF */

/**
 * r.jina.ai renders the document and hands back text. No key, no account -
 * the same reader this server already falls back to for HTML pages.
 */
const PRIVATE_HOST =
  /^(?:localhost|127\.|0\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|\[?::1)/i;

export async function readPdfViaReader(url) {
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    /* handled below */
  }
  if (!host || PRIVATE_HOST.test(host)) {
    // Sending an internal address to an outside service would leak it and
    // could not work anyway - that host is not reachable from there.
    throw new NaverError("UPSTREAM", "외부 리더로 보낼 수 없는 주소입니다.", { url });
  }

  let resp;
  try {
    resp = await fetch(`https://r.jina.ai/${url}`, {
      headers: {
        "User-Agent": MOBILE_UA,
        "Accept-Language": "ko-KR,ko;q=0.9",
        Accept: "text/plain, text/markdown, */*",
      },
      // Measured: an 8 MB PDF timed out. Give up rather than hold the request.
      signal: AbortSignal.timeout(50_000),
    });
  } catch (e) {
    throw new NaverError("UPSTREAM", `PDF 리더가 응답하지 않았습니다 (${e.name}).`, { url });
  }

  if (resp.status === 429) {
    throw new NaverError(
      "BLOCKED",
      "PDF 리더(r.jina.ai)가 요청 한도에 걸렸습니다. 잠시 후 다시 시도하면 됩니다.",
      { url }
    );
  }
  if (!resp.ok) {
    throw new NaverError("UPSTREAM", `PDF 리더가 오류를 반환했습니다 (HTTP ${resp.status}).`, { url });
  }

  const raw = await resp.text();
  // The reader prefixes its own Title / URL Source / Published header block.
  const body = raw.replace(/^(?:Title|URL Source|Published Time|Markdown Content):.*\n/gm, "").trim();
  return body;
}

/**
 * PDF text by the cheapest route that actually works on this file.
 *
 * A scanned PDF yields nothing on either route, which reads as a broken
 * extractor unless the emptiness is named - so that case gets its own error.
 */
export async function readPdf(url, buf) {
  const trace = [];

  if (buf && buf.byteLength <= RAW_ROUTE_LIMIT) {
    try {
      const local = await extractPdfText(buf);
      // A page of pictures with no text operators is a scan, and that can be
      // seen in the file itself - no second opinion required.
      if (local.textOps === 0 && local.imageXObjects > 0) {
        throw new NaverError(
          "SCANNED_PDF",
          `이 PDF는 ${local.pages}쪽 전부가 글자 없는 이미지입니다. 스캔본이라 텍스트를 뽑을 수 없습니다.`,
          { url, images: local.imageXObjects, pages: local.pages }
        );
      }
      // Glyph ids now become characters through the file's own ToUnicode map,
      // so a clean result is the normal case rather than the lucky one. What
      // the check still catches is a font carrying no map at all, where the
      // bytes cannot be named and come out as noise.
      const clean = local.junk < Math.max(8, local.text.length / 40);
      const readable = clean && local.text.length >= 20 && (local.hangul >= 20 || local.hangul === 0);
      trace.push({
        route: "pdf-local",
        result: readable ? "ok" : "low-confidence",
        message:
          `${local.hangul} hangul, ${local.junk} junk, ${local.pages} pages, ` +
          `${local.mappedFonts} mapped fonts`,
      });
      if (readable) return { text: local.text, pages: local.pages, how: "pdf-local" };
    } catch (e) {
      if (e instanceof NaverError && e.kind === "SCANNED_PDF") throw e;
      trace.push({ route: "pdf-local", result: "failed", message: e.message });
    }
  } else {
    trace.push({ route: "pdf-local", result: "skipped", message: "파일이 커서 건너뜀" });
  }

  let viaReader = "";
  let readerFailed = null;
  try {
    viaReader = await readPdfViaReader(url);
    trace.push({ route: "jina-reader", result: viaReader ? "ok" : "empty", message: `${viaReader.length} chars` });
  } catch (e) {
    readerFailed = e;
    trace.push({ route: "jina-reader", result: "failed", message: e.message });
    if (e instanceof NaverError && e.kind === "BLOCKED") {
      e.detail = { ...(e.detail || {}), trace };
      throw e;
    }
  }

  if (viaReader.length > 200) {
    return { text: viaReader, pages: null, how: "jina-reader" };
  }

  // Only call it a scan when a route actually looked and found nothing. If the
  // reader never answered, the honest report is that we could not read it -
  // saying "this is a scan" would send the user off fixing the wrong thing.
  if (readerFailed) {
    throw new NaverError(
      "UPSTREAM",
      "이 PDF는 자체 추출로도, 외부 리더로도 읽지 못했습니다. 리더가 응답하지 않아 스캔본인지 여부는 확인되지 않았습니다.",
      { url, trace }
    );
  }

  throw new NaverError(
    "SCANNED_PDF",
    "이 PDF에서 텍스트를 찾지 못했습니다. 스캔 이미지로 만들어진 PDF일 가능성이 높습니다.",
    { url, trace }
  );
}

/* ------------------------------------------------------------------- HWP */

/**
 * Legacy .hwp is a compound-binary format with compressed record streams.
 * There is no small reader for it, and guessing at the bytes would produce
 * mojibake that looks like a parsing bug. Say what it is and what converts it.
 */
export function rejectHwp(url) {
  throw new NaverError(
    "UNSUPPORTED_FORMAT",
    "구버전 한글 파일(.hwp)은 읽을 수 없습니다. 한글에서 '다른 이름으로 저장 → HWPX' 또는 'PDF로 저장' 후 그 주소를 주세요.",
    { url }
  );
}

/* ----------------------------------------------------------------- image */

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** btoa() takes a binary string, and a big one blows the call stack. */
function toBase64(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
    out += B64[a >> 2];
    out += B64[((a & 3) << 4) | ((b || 0) >> 4)];
    out += b === undefined ? "=" : B64[((b & 15) << 2) | ((c || 0) >> 6)];
    out += c === undefined ? "=" : B64[c & 63];
  }
  return out;
}

/**
 * Images are handed to the model as an image block rather than run through
 * OCR. Korean OCR data alone is tens of megabytes - past the Worker limit -
 * and a model that can see the page reads tables, diagrams and layout that
 * OCR would flatten into a line of characters.
 */
export function readImage(buf, contentType, url) {
  if (buf.byteLength > MAX_IMAGE_BYTES) {
    throw new NaverError(
      "TOO_LARGE",
      `이미지가 ${(buf.byteLength / 1048576).toFixed(1)}MB로 너무 큽니다 (한도 ${MAX_IMAGE_BYTES / 1048576}MB).`,
      { url, bytes: buf.byteLength }
    );
  }
  const mime = contentType.split(";")[0].trim() || "image/jpeg";
  return { base64: toBase64(buf), mimeType: mime, bytes: buf.byteLength };
}

/* --------------------------------------------------------------- gateway */

/**
 * Fetch a file and return either extracted text or an image block.
 * `kind` is resolved from the response headers as well as the URL, because
 * download links routinely end in `?fileId=` with no extension at all.
 */
export async function readFile(url, { referer } = {}) {
  const { buf, contentType, declared } = await fetchBinary(url, referer, {
    maxBody: RAW_ROUTE_LIMIT,
  });
  let kind = detectKind(url, contentType);

  // Body skipped because the file is large. A PDF is still readable - the
  // reader fetches it itself - but nothing else here can work without bytes.
  if (!buf) {
    if (kind === "pdf") return { type: "text", ...(await readPdf(url, null)) };
    if (declared > MAX_BYTES) {
      throw new NaverError(
        "TOO_LARGE",
        `파일이 ${(declared / 1048576).toFixed(1)}MB로 너무 큽니다 (한도 ${MAX_BYTES / 1048576}MB).`,
        { url, bytes: declared }
      );
    }
    throw new NaverError(
      "TOO_LARGE",
      `이 형식은 ${(declared / 1048576).toFixed(1)}MB에서 처리할 수 없습니다.`,
      { url, bytes: declared }
    );
  }

  // Sniff the magic bytes when neither the URL nor the headers committed.
  if (!kind) {
    if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) kind = "pdf";
    else if (buf[0] === 0x50 && buf[1] === 0x4b) kind = "hwpx";      // zip container
    else if (buf[0] === 0xd0 && buf[1] === 0xcf) kind = "hwp";       // OLE compound
    else if (buf[0] === 0xff && buf[1] === 0xd8) kind = "image";
    else if (buf[0] === 0x89 && buf[1] === 0x50) kind = "image";
    else if (/^\s*<(?:!doctype|html|\?xml)/i.test(new TextDecoder().decode(buf.subarray(0, 200)))) {
      // A download link that turned out to be a web page. Say so instead of
      // refusing it - the caller has an HTML reader and can just use it.
      kind = "html";
    }
  }

  switch (kind) {
    case "pdf":   return { type: "text", ...(await readPdf(url, buf)) };
    case "hwpx":  return { type: "text", ...(await readHwpxBytes(buf, url)) };
    case "hwp":   return rejectHwp(url);
    case "image": return { type: "image", ...readImage(buf, contentType, url) };
    case "html":  return { type: "html" };
    default:
      throw new NaverError(
        "UNSUPPORTED_FORMAT",
        `이 파일 형식은 읽을 수 없습니다 (Content-Type: ${contentType || "없음"}).`,
        { url }
      );
  }
}

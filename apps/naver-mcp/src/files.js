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

async function fetchBinary(url, referer) {
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

  const declared = Number(resp.headers.get("Content-Length") || 0);
  if (declared > MAX_BYTES) {
    throw new NaverError(
      "TOO_LARGE",
      `파일이 ${(declared / 1048576).toFixed(1)}MB로 너무 큽니다 (한도 ${MAX_BYTES / 1048576}MB).`,
      { url, bytes: declared }
    );
  }

  const buf = new Uint8Array(await resp.arrayBuffer());
  if (buf.byteLength > MAX_BYTES) {
    throw new NaverError(
      "TOO_LARGE",
      `파일이 ${(buf.byteLength / 1048576).toFixed(1)}MB로 너무 큽니다.`,
      { url, bytes: buf.byteLength }
    );
  }
  return { buf, contentType: resp.headers.get("Content-Type") || "" };
}

/* ------------------------------------------------------------- inflate */

/** Raw DEFLATE, using the decompressor the runtime already ships. */
async function inflate(bytes) {
  const stream = new Response(bytes).body.pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

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
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const sections = [];
  let i = 0;

  while (i + 30 <= buf.length && dv.getUint32(i, true) === 0x04034b50) {
    const method = dv.getUint16(i + 8, true);
    const compSize = dv.getUint32(i + 18, true);
    const nameLen = dv.getUint16(i + 26, true);
    const extraLen = dv.getUint16(i + 28, true);
    const name = new TextDecoder().decode(buf.subarray(i + 30, i + 30 + nameLen));
    const dataStart = i + 30 + nameLen + extraLen;

    if (!compSize) break; // streamed entry - sizes live in the central directory
    if (/Contents\/section\d*\.xml$/i.test(name)) {
      const raw = buf.subarray(dataStart, dataStart + compSize);
      try {
        sections.push({ name, bytes: method === 8 ? await inflateRaw(raw) : raw });
      } catch (e) {
        throw new NaverError("PARSE_FAILED", `HWPX 압축을 풀지 못했습니다: ${e.message}`, { url, name });
      }
    }
    i = dataStart + compSize;
  }

  if (!sections.length) {
    throw new NaverError(
      "PARSE_FAILED",
      "HWPX 안에서 본문 파일(Contents/section*.xml)을 찾지 못했습니다.",
      { url }
    );
  }

  sections.sort((a, b) => a.name.localeCompare(b.name));
  const parts = [];
  for (const s of sections) {
    const xml = new TextDecoder().decode(s.bytes);
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

/* ------------------------------------------------------------------- PDF */

/** Undo the escapes PDF uses inside ( ) literal strings. */
function unescapePdfString(s) {
  return s.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_, esc) => {
    const simple = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\" };
    if (simple[esc] !== undefined) return simple[esc];
    return String.fromCharCode(parseInt(esc, 8));
  });
}

/**
 * Pull text out of a PDF's own content streams.
 *
 * This is free and instant when it works, which is why it runs first - but it
 * only works when the text was stored as characters. Korean PDFs commonly
 * store glyph ids instead, which come out as noise, so the caller checks the
 * confidence before trusting the result.
 */
export async function extractPdfStreams(buf) {
  const latin = new TextDecoder("latin1").decode(buf);
  const utf8 = new TextDecoder("utf-8", { fatal: false });
  const pieces = [];
  let streams = 0;

  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(latin)) !== null) {
    const start = m.index + m[0].length;
    const end = latin.indexOf("endstream", start);
    if (end < 0) continue;
    re.lastIndex = end;

    // The stream's dictionary sits just before it and says how it is encoded.
    const dict = latin.slice(Math.max(0, m.index - 400), m.index);
    if (/\/Image|\/DCTDecode|\/JPXDecode|\/CCITTFaxDecode/.test(dict)) continue;

    let bytes = buf.subarray(start, end);
    if (/\/FlateDecode/.test(dict)) {
      try {
        bytes = await inflate(bytes);
      } catch {
        continue; // a stream we cannot open is not a reason to abandon the file
      }
    }
    streams++;

    const text = utf8.decode(bytes);
    for (const t of text.matchAll(/\(((?:[^()\\]|\\[\s\S])*)\)\s*(?:Tj|TJ|'|")/g)) {
      pieces.push(unescapePdfString(t[1]));
    }
    // TJ takes an array of fragments with kerning numbers between them.
    for (const arr of text.matchAll(/\[((?:[^\][\\]|\\[\s\S])*)\]\s*TJ/g)) {
      for (const t of arr[1].matchAll(/\(((?:[^()\\]|\\[\s\S])*)\)/g)) {
        pieces.push(unescapePdfString(t[1]));
      }
    }
    pieces.push("\n");
  }

  const text = pieces.join("").replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  const hangul = (text.match(HANGUL) || []).length;
  // Glyph ids decoded as text show up as replacement characters and control
  // bytes. Counting them is how a real extraction is told from noise.
  const junk = (text.match(/[\uFFFD\u0000-\u0008\u000B\u000C\u000E-\u001F]/g) || []).length;
  return { text, hangul, junk, streams };
}

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
      const local = await extractPdfStreams(buf);
      // Trust it only when the text came out as letters. A Korean PDF whose
      // text is stored as glyph ids gives itself away: thousands of text
      // operators, a handful of Hangul characters. Either the Hangul is
      // clearly there, or there is none at all and the document is Latin.
      const clean = local.junk < Math.max(8, local.text.length / 40);
      const readable =
        clean &&
        local.text.length >= 20 &&
        (local.hangul >= 50 || local.hangul === 0);
      trace.push({
        route: "pdf-streams",
        result: readable ? "ok" : "low-confidence",
        message: `${local.hangul} hangul, ${local.junk} junk, ${local.streams} streams`,
      });
      if (readable) return { text: local.text, pages: local.streams, how: "pdf-streams" };
    } catch (e) {
      trace.push({ route: "pdf-streams", result: "failed", message: e.message });
    }
  } else {
    trace.push({ route: "pdf-streams", result: "skipped", message: "파일이 커서 건너뜀" });
  }

  let viaReader = "";
  try {
    viaReader = await readPdfViaReader(url);
    trace.push({ route: "jina-reader", result: viaReader ? "ok" : "empty", message: `${viaReader.length} chars` });
  } catch (e) {
    trace.push({ route: "jina-reader", result: "failed", message: e.message });
    if (e instanceof NaverError && e.kind === "BLOCKED") {
      e.detail = { ...(e.detail || {}), trace };
      throw e;
    }
  }

  if (viaReader.length > 200) {
    return { text: viaReader, pages: null, how: "jina-reader" };
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
  const { buf, contentType } = await fetchBinary(url, referer);
  let kind = detectKind(url, contentType);

  // Sniff the magic bytes when neither the URL nor the headers committed.
  if (!kind) {
    if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) kind = "pdf";
    else if (buf[0] === 0x50 && buf[1] === 0x4b) kind = "hwpx";      // zip container
    else if (buf[0] === 0xd0 && buf[1] === 0xcf) kind = "hwp";       // OLE compound
    else if (buf[0] === 0xff && buf[1] === 0xd8) kind = "image";
    else if (buf[0] === 0x89 && buf[1] === 0x50) kind = "image";
  }

  switch (kind) {
    case "pdf":   return { type: "text", ...(await readPdf(url, buf)) };
    case "hwpx":  return { type: "text", ...(await readHwpxBytes(buf, url)) };
    case "hwp":   return rejectHwp(url);
    case "image": return { type: "image", ...readImage(buf, contentType, url) };
    default:
      throw new NaverError(
        "UNSUPPORTED_FORMAT",
        `이 파일 형식은 읽을 수 없습니다 (Content-Type: ${contentType || "없음"}).`,
        { url }
      );
  }
}

/**
 * Reading the formats Korean reference material actually ships in.
 *
 * Most of what is worth pulling - past exam papers, agency reports, notices -
 * is a PDF, an HWP, or a scan. The HTML reader cannot touch any of them, so
 * each gets the treatment its format allows and says plainly when it cannot
 * be read rather than returning something that merely looks like text.
 */

import { extractText, getDocumentProxy } from "unpdf";
import { unzipSync, strFromU8 } from "fflate";
import { NaverError, htmlToText } from "./naver.js";

export const MOBILE_UA =
  "Mozilla/5.0 (Linux; Android 14; SM-S928N) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/126.0.6478.122 Mobile Safari/537.36";

// A Worker has a memory ceiling and the model has a context one. Refuse early
// with the size rather than dying halfway through a 60 MB scan.
const MAX_BYTES = 12 * 1024 * 1024;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

const EXT = /\.(pdf|hwpx?|jpe?g|png|gif|webp|bmp)(?:$|[?#])/i;

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

/* ------------------------------------------------------------------- PDF */

/**
 * A scanned PDF parses cleanly and yields almost nothing, which reads as a
 * broken extractor unless the emptiness is named. Compare text against page
 * count to tell "no text layer" apart from "failed to parse".
 */
export async function readPdf(buf, url) {
  let doc;
  try {
    doc = await getDocumentProxy(buf);
  } catch (e) {
    throw new NaverError("PARSE_FAILED", `PDF를 열지 못했습니다: ${e.message}`, { url });
  }

  const { totalPages, text } = await extractText(doc, { mergePages: true });
  const body = String(text || "").replace(/\n{3,}/g, "\n\n").trim();

  if (body.length < totalPages * 20) {
    throw new NaverError(
      "SCANNED_PDF",
      `이 PDF는 ${totalPages}쪽인데 글자가 ${body.length}자뿐입니다. 스캔 이미지로 만들어진 PDF라 텍스트를 뽑을 수 없습니다.`,
      { url, pages: totalPages, chars: body.length }
    );
  }
  return { text: body, pages: totalPages, how: "pdf-text-layer" };
}

/* ------------------------------------------------------------------ HWPX */

// HWPX is a zip of XML; section files hold the body text.
export function readHwpx(buf, url) {
  let files;
  try {
    files = unzipSync(buf);
  } catch (e) {
    throw new NaverError("PARSE_FAILED", `HWPX 압축을 풀지 못했습니다: ${e.message}`, { url });
  }

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
    const xml = strFromU8(files[name]);
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
  return { text, pages: sections.length, how: "hwpx-xml" };
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
    case "pdf":   return { type: "text", ...(await readPdf(buf, url)) };
    case "hwpx":  return { type: "text", ...readHwpx(buf, url) };
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

/**
 * Tiny documents built byte by byte, so the file tests do not depend on some
 * third party still hosting a sample PDF next year. Each one is the smallest
 * valid file of its format that carries text we can assert on.
 */

import { deflateSync } from "node:zlib";

/**
 * A one-page PDF with a real text layer and a correct xref table.
 *
 * Assembled as bytes rather than as a string so Korean text survives: offsets
 * in the xref table are byte offsets, and one Hangul character is three bytes.
 */
export function makePdf(text = "SUNEUNG KOREAN 1994-2026 PAST PAPERS", { compress = false } = {}) {
  const enc = new TextEncoder();
  const stream = `BT /F1 18 Tf 60 700 Td (${text}) Tj ET`;
  const objects = [
    "<</Type/Catalog/Pages 2 0 R>>",
    "<</Type/Pages/Kids[3 0 R]/Count 1>>",
    "<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]" +
      "/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>",
    "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
    null, // the content stream is spliced in below - it may be binary
  ];

  const streamBytes = compress ? deflateSync(enc.encode(stream)) : enc.encode(stream);
  const parts = [enc.encode("%PDF-1.4\n")];
  let at = parts[0].length;
  const offsets = [];

  objects.forEach((body, i) => {
    offsets.push(at);
    if (body === null) {
      // Real PDFs put a newline between the data and `endstream`. Keeping it
      // here is deliberate: a decompressor that rejects trailing bytes fails
      // on every genuine file, and the fixture has to be able to catch that.
      const head = enc.encode(
        `${i + 1} 0 obj\n<</Length ${streamBytes.length}` +
          `${compress ? "/Filter/FlateDecode" : ""}>>stream\n`
      );
      const tail = enc.encode("\nendstream\nendobj\n");
      parts.push(head, streamBytes, tail);
      at += head.length + streamBytes.length + tail.length;
      return;
    }
    const chunk = enc.encode(`${i + 1} 0 obj\n${body}\nendobj\n`);
    parts.push(chunk);
    at += chunk.length;
  });

  let tail = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) tail += `${String(off).padStart(10, "0")} 00000 n \n`;
  tail += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${at}\n%%EOF\n`;
  parts.push(enc.encode(tail));

  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let cursor = 0;
  for (const p of parts) { out.set(p, cursor); cursor += p.length; }
  return out;
}

/** An HWPX (zip of XML) whose section file carries Korean body text. */
export function makeHwpx(paragraphs = ["2026학년도 수능 국어 영역", "다음 글을 읽고 물음에 답하시오."]) {
  const body = paragraphs
    .map((p) => `<hp:p><hp:run><hp:t>${p}</hp:t></hp:run></hp:p>`)
    .join("");
  // Stored (uncompressed) entries, written by hand - the reader has to walk
  // the same local file headers a real HWPX uses, and this keeps the fixture
  // free of a zip dependency the Worker itself no longer has.
  return zipStored({
    // A directory entry, which has no data at all. Real HWPX files contain
    // these, and a reader that walks local headers stops dead on one.
    "Contents/": null,
    mimetype: "application/hwp+zip",
    "Contents/section0.xml":
      `<?xml version="1.0" encoding="UTF-8"?><hs:sec xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph">${body}</hs:sec>`,
  });
}

/**
 * A PDF shaped the way Korean documents actually are: a subset font, text
 * stored as glyph ids rather than characters, and a /ToUnicode CMap that says
 * what each id stands for. Without reading that CMap the bytes are unreadable,
 * which is exactly the case that used to be handed to an outside service.
 */
export function makeCidPdf(text = "다음 글을 읽고 물음에 답하시오.", { withTable = true, inheritResources = false } = {}) {
  const enc = new TextEncoder();
  const chars = [...text];

  // Glyph ids are arbitrary; a real subset font numbers them by order of use.
  const gid = new Map();
  chars.forEach((ch) => { if (!gid.has(ch)) gid.set(ch, gid.size + 1); });
  const hex = (n, w = 4) => n.toString(16).toUpperCase().padStart(w, "0");

  const bf = [...gid.entries()]
    .map(([ch, id]) => `<${hex(id)}> <${hex(ch.charCodeAt(0))}>`)
    .join("\n");
  const cmap =
    "/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n" +
    "1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n" +
    `${gid.size} beginbfchar\n${bf}\nendbfchar\n` +
    "endcmap CMapName currentdict /CMap defineresource pop end end";

  const shown = chars.map((ch) => hex(gid.get(ch))).join("");
  const content = `BT /F1 12 Tf 60 700 Td <${shown}> Tj ET`;

  const objects = [
    "<</Type/Catalog/Pages 2 0 R>>",
    inheritResources
      ? "<</Type/Pages/Kids[3 0 R]/Count 1/Resources<</Font<</F1 4 0 R>>>>>>"
      : "<</Type/Pages/Kids[3 0 R]/Count 1>>",
    inheritResources
      ? "<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 7 0 R>>"
      : "<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]" +
        "/Resources<</Font<</F1 4 0 R>>>>/Contents 7 0 R>>",
    "<</Type/Font/Subtype/Type0/BaseFont/BatangChe/Encoding/Identity-H" +
      "/DescendantFonts[5 0 R]" + (withTable ? "/ToUnicode 6 0 R" : "") + ">>",
    "<</Type/Font/Subtype/CIDFontType2/BaseFont/BatangChe/CIDSystemInfo" +
      "<</Registry(Adobe)/Ordering(Korea1)/Supplement 2>>>>",
    { stream: cmap },
    { stream: content },
  ];

  const parts = [enc.encode("%PDF-1.5\n")];
  let at = parts[0].length;
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(at);
    let chunk;
    if (typeof body === "object") {
      const data = enc.encode(body.stream);
      const head = enc.encode(`${i + 1} 0 obj\n<</Length ${data.length}>>stream\n`);
      const tail = enc.encode("\nendstream\nendobj\n");
      parts.push(head, data, tail);
      at += head.length + data.length + tail.length;
      return;
    }
    chunk = enc.encode(`${i + 1} 0 obj\n${body}\nendobj\n`);
    parts.push(chunk);
    at += chunk.length;
  });

  let tail = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) tail += `${String(off).padStart(10, "0")} 00000 n \n`;
  tail += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${at}\n%%EOF\n`;
  parts.push(enc.encode(tail));

  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let cursor = 0;
  for (const p of parts) { out.set(p, cursor); cursor += p.length; }
  return out;
}

/** A PDF that is a photograph of a page: an image, and no text operators. */
export function makeScannedPdf() {
  const enc = new TextEncoder();
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(60).fill(0x41), 0xff, 0xd9]);
  const head = enc.encode(
    "%PDF-1.4\n1 0 obj\n<</Type/Catalog/Pages 2 0 R>>\nendobj\n" +
      "2 0 obj\n<</Type/Pages/Kids[3 0 R]/Count 1>>\nendobj\n" +
      "3 0 obj\n<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]" +
      "/Resources<</XObject<</Im0 4 0 R>>>>/Contents 5 0 R>>\nendobj\n" +
      `4 0 obj\n<</Type/XObject/Subtype/Image/Width 8/Height 8/Filter/DCTDecode/Length ${jpeg.length}>>stream\n`
  );
  const mid = enc.encode("\nendstream\nendobj\n5 0 obj\n<</Length 26>>stream\nq 612 0 0 792 0 0 cm /Im0 Do Q\nendstream\nendobj\ntrailer\n<</Size 6/Root 1 0 R>>\n%%EOF\n");
  const out = new Uint8Array(head.length + jpeg.length + mid.length);
  out.set(head, 0);
  out.set(jpeg, head.length);
  out.set(mid, head.length + jpeg.length);
  return out;
}

/** A legacy .hwp: only the OLE compound-file signature is needed to identify it. */
export function makeHwp() {
  const buf = new Uint8Array(512);
  buf.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 0);
  return buf;
}

/** A 1x1 PNG - enough to prove the image path returns an image block. */
export function makePng() {
  const b64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  return new Uint8Array(Buffer.from(b64, "base64"));
}

/** Minimal ZIP writer: stored entries plus the central directory. */
function zipStored(files) {
  const enc = new TextEncoder();
  const local = [];
  const central = [];
  let offset = 0;

  for (const [name, text] of Object.entries(files)) {
    const nameBytes = enc.encode(name);
    const data = enc.encode(text ?? "");
    const crc = crc32(data);

    const lh = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lh.set(nameBytes, 30);
    local.push(lh, data);

    const ch = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    ch.set(nameBytes, 46);
    central.push(ch);
    offset += lh.length + data.length;
  }

  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, central.length, true);
  ev.setUint16(10, central.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const all = [...local, ...central, end];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of all) { out.set(p, at); at += p.length; }
  return out;
}

function crc32(bytes) {
  let c = ~0;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

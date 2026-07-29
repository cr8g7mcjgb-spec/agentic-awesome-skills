/**
 * Tiny documents built byte by byte, so the file tests do not depend on some
 * third party still hosting a sample PDF next year. Each one is the smallest
 * valid file of its format that carries text we can assert on.
 */

import { zipSync, strToU8 } from "fflate";

/** A one-page PDF with a real text layer and a correct xref table. */
export function makePdf(text = "SUNEUNG KOREAN 1994-2026 PAST PAPERS") {
  const stream = `BT /F1 18 Tf 60 700 Td (${text}) Tj ET`;
  const objects = [
    "<</Type/Catalog/Pages 2 0 R>>",
    "<</Type/Pages/Kids[3 0 R]/Count 1>>",
    "<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]" +
      "/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>",
    "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
    `<</Length ${stream.length}>>stream\n${stream}\nendstream`,
  ];

  let pdf = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;

  return new Uint8Array([...pdf].map((c) => c.charCodeAt(0)));
}

/** An HWPX (zip of XML) whose section file carries Korean body text. */
export function makeHwpx(paragraphs = ["2026학년도 수능 국어 영역", "다음 글을 읽고 물음에 답하시오."]) {
  const body = paragraphs
    .map((p) => `<hp:p><hp:run><hp:t>${p}</hp:t></hp:run></hp:p>`)
    .join("");
  return zipSync({
    mimetype: strToU8("application/hwp+zip"),
    "Contents/section0.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><hs:sec xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph">${body}</hs:sec>`
    ),
  });
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

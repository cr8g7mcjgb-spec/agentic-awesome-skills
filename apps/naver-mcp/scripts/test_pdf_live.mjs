/**
 * Run the shipped reader against real Korean PDFs found through Naver.
 *
 * The fixture tests prove the code does what I built it to do; they cannot
 * prove real files look like my fixtures. They did not: every compressed
 * stream was being lost, and no fixture noticed because none of them were
 * compressed. This finds actual documents and reports which route read each
 * one, so the split between local extraction and the reader is measured
 * rather than assumed.
 *
 * Exits non-zero only if no PDF could be read at all.
 */

import { readFile } from "../src/files.js";
import { naverWebSearch } from "../src/tools.js";

const HANGUL = /[가-힣]/g;

async function findPdfs(query, want = 4) {
  const listing = await naverWebSearch({ query, count: 30 });
  const links = [...listing.matchAll(/https?:\/\/\S+?\.pdf\b/gi)].map((m) => m[0]);
  return [...new Set(links)].slice(0, want);
}

const rows = [];

async function measure(url) {
  const started = Date.now();
  try {
    const res = await readFile(url, { referer: new URL(url).origin + "/" });
    const hangul = (res.text?.match(HANGUL) || []).length;
    rows.push({
      url,
      how: res.how,
      chars: res.text?.length || 0,
      hangul,
      ms: Date.now() - started,
    });
  } catch (e) {
    rows.push({ url, how: `FAILED (${e.kind || e.name})`, why: e.message?.slice(0, 70) });
  }
}

const QUERIES = [
  "수능 국어 영역 기출 문제지 pdf",
  "한국소비자원 피해 보고서 pdf",
  "국립국어원 보고서 pdf",
];

const found = [];
for (const q of QUERIES) {
  try {
    const hits = await findPdfs(q);
    console.log(`"${q}" → ${hits.length} PDF link(s)`);
    found.push(...hits);
  } catch (e) {
    console.log(`"${q}" → search failed: ${e.message}`);
  }
}

if (!found.length) {
  console.log("\nNo PDF links came back from Naver. Nothing was measured.");
  process.exit(1);
}

for (const url of [...new Set(found)].slice(0, 6)) {
  console.log(`\n--- ${url.slice(0, 100)}`);
  await measure(url);
  const r = rows[rows.length - 1];
  console.log(
    r.why
      ? `  ${r.how}: ${r.why}`
      : `  read via ${r.how} — ${r.chars.toLocaleString()} chars, ${r.hangul} hangul, ${r.ms}ms`
  );
}

console.log("\n" + "=".repeat(74));
const readable = rows.filter((r) => r.hangul > 50);
const local = readable.filter((r) => r.how === "pdf-local");
console.log(`PDFs read with Korean text : ${readable.length}/${rows.length}`);
console.log(`  ...without any outside service : ${local.length}`);
for (const r of rows) {
  console.log(`  ${String(r.how).padEnd(22)} ${r.hangul ?? "-"} hangul  ${r.url.slice(-52)}`);
}

// Reading nothing at all is the only outcome that should fail the build. A
// document the local route hands to the reader is working as designed.
process.exit(readable.length ? 0 : 1);

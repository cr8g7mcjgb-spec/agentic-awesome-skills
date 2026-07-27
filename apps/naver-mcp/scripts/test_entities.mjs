/**
 * Entity decoding, checked against the forms Naver actually emits.
 *
 * Naver's editor writes the hex form (&#x27;) far more often than the decimal
 * one, and a real post surfaced literal "&#x27;" in the output because only
 * decimals were handled.
 */

import { htmlToText, decodeEntities } from "../src/naver.js";

const APOS = String.fromCharCode(39);
const QUOT = String.fromCharCode(34);

const cases = [
  ["hex apostrophe", `&#x27;쯔양몇끼&#x27;`, `${APOS}쯔양몇끼${APOS}`],
  ["decimal apostrophe", `&#39;작은따옴표&#39;`, `${APOS}작은따옴표${APOS}`],
  ["hex curly quotes", `&#x201C;큰따옴표&#x201D;`, `“큰따옴표”`],
  ["uppercase hex", `&#X27;대문자&#X27;`, `${APOS}대문자${APOS}`],
  ["named entities", `&lt;태그&gt; &quot;인용&quot;`, `<태그> ${QUOT}인용${QUOT}`],
  ["nbsp becomes a space", `앞&nbsp;뒤`, `앞 뒤`],
  // "&amp;#x27;" is a literal "&#x27;" the author typed - decoding &amp; first
  // would turn it into an apostrophe and lose what they wrote.
  ["escaped ampersand is not double-decoded", `&amp;#x27; 는 그대로`, `&#x27; 는 그대로`],
  ["plain ampersand", `A&amp;B`, `A&B`],
  ["out-of-range codepoint is left alone", `&#x110000;`, `&#x110000;`],
];

let failures = 0;
for (const [label, input, want] of cases) {
  const got = htmlToText(input);
  const ok = got === want;
  if (!ok) failures++;
  console.log(`${ok ? "[PASS]" : "[FAIL]"} ${label}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
}

// decodeEntities is used for titles and must behave the same way.
const title = decodeEntities(`&#x27;제목&#x27; &amp; 부제`);
const wantTitle = `${APOS}제목${APOS} & 부제`;
const titleOk = title === wantTitle;
if (!titleOk) failures++;
console.log(`${titleOk ? "[PASS]" : "[FAIL]"} decodeEntities handles the same forms`);
if (!titleOk) console.log(`        want ${JSON.stringify(wantTitle)}\n        got  ${JSON.stringify(title)}`);

// Client-rendered sites must be refused by name, not read as a shell.
const { genericReadRoutes } = await import("../src/naver.js");
let cr = 0;
for (const [url, want] of [
  ["https://place.map.kakao.com/15582723", true],
  ["https://map.kakao.com/link/map/123", true],
  ["https://www.tmap.co.kr/anything", true],
  ["https://www.donga.com/news/article/all/1/1", false],
  ["https://www.kca.go.kr/home/main.do", false],
]) {
  let refused = false;
  try { genericReadRoutes(url); } catch (e) { refused = e.kind === "CLIENT_RENDERED"; }
  const ok = refused === want;
  if (!ok) cr++;
  console.log(`${ok ? "[PASS]" : "[FAIL]"} ${want ? "refuses" : "allows "} ${url}`);
}
failures += cr;

console.log(failures ? `\n${failures} check(s) failed.` : "\nAll entity and client-rendered checks passed.");
process.exit(failures ? 1 : 0);


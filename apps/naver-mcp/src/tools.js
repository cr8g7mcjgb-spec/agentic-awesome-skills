/**
 * The five MCP tools. Each returns markdown-ish plain text, and each failure
 * says whether Naver refused us or whether we simply could not parse what it
 * sent - those need different fixes, so they must not look alike.
 */

import {
  NaverError,
  blogReadRoutes,
  extractPostBody,
  extractTitle,
  extractDate,
  htmlToText,
  httpGet,
  parseBlogUrl,
  parseNewsUrl,
  parseCafeUrl,
  parseTistoryUrl,
  cafeReadRoutes,
  tistoryReadRoutes,
  genericReadRoutes,
  visitorReviewRoutes,
  readViaChain,
  sleep,
} from "./naver.js";

import { readFile, detectKind } from "./files.js";

const SEARCH_REFERER = "https://m.search.naver.com/";
const MAX_COUNT = 100;
const PAGE_SIZE = 30;

const clampCount = (n, dflt = 10) => {
  const v = Number.isFinite(Number(n)) ? Math.floor(Number(n)) : dflt;
  return Math.min(MAX_COUNT, Math.max(1, v));
};

// Long posts otherwise dominate the caller's context. Most posts land well
// under this, so the cap costs nothing in the common case.
const DEFAULT_MAX_CHARS = 8000;

/**
 * Trim body text to a character budget, cutting at a paragraph break so the
 * tail is not left mid-sentence. Truncation is always announced - silently
 * dropping half a post would let a caller summarise it as if it were whole.
 */
function capLength(text, maxChars) {
  const limit = Number.isFinite(Number(maxChars)) ? Math.floor(Number(maxChars)) : DEFAULT_MAX_CHARS;
  if (limit <= 0 || text.length <= limit) return { text, truncated: false };

  let cut = text.lastIndexOf("\n", limit);
  if (cut < limit * 0.6) cut = limit; // no usable break; take the hard cut
  const kept = text.slice(0, cut).trimEnd();
  return {
    text:
      `${kept}\n\n---\n[본문이 길어 ${kept.length}/${text.length}자만 표시했습니다. ` +
      `전체가 필요하면 max_chars 를 늘리거나 0(무제한)으로 호출하세요.]`,
    truncated: true,
  };
}


// UI chrome that appears as link text on result pages and is never a title.
const UI_NOISE = [
  "저장하기", "Keep에 저장", "Keep 바로가기", "공유하기", "더보기", "신고",
  "답글", "댓글", "관련글", "본문 보기", "바로가기", "옵션", "닫기", "열기",
  "길찾기", "예약", "전화",
];

const isNoise = (t) =>
  !t || t.length < 4 || t.length > 200 || UI_NOISE.some((n) => t.includes(n)) ||
  /^[\s·|\-—RE]*$/.test(t);

const cleanTitle = (raw) => {
  const t = htmlToText(raw).replace(/\s+/g, " ").trim();
  return isNoise(t) ? "" : t;
};

/**
 * Collect search hits, preferring anchors whose href is the result URL.
 *
 * The first occurrence of a result URL on the page is Keep's save button
 * (`data-url="…"`), whose only text is "문서 저장하기" — so anything that
 * searches by proximity to the URL finds the button, not the title. Matching
 * `<a href="…">` skips the button and lands on the real title anchor.
 *
 * A second pass over bare URLs then picks up anything that only appears in an
 * attribute, so coverage never drops below what a plain URL scan would find;
 * those hits simply carry no title.
 */
function collectHits(html, urlSource, into, want) {
  const { anchor, bare, key } = urlSource;

  anchor.lastIndex = 0;
  let m;
  while ((m = anchor.exec(html)) !== null) {
    const k = key(m);
    const prev = into.get(k);
    // Keep scanning once the quota is full: the real title for an already
    // collected URL often sits in a later anchor, and stopping here would
    // leave it blank. Only *new* keys are refused past the quota.
    if (!prev && into.size >= want) continue;
    const title = cleanTitle(m[m.length - 1]);
    // The same URL appears in several anchors ("더보기", the snippet, the
    // title). Let a later real title replace an earlier empty one instead of
    // letting whichever came first win.
    if (prev && (prev.title || !title)) continue;
    into.set(k, { title });
  }

  bare.lastIndex = 0;
  while ((m = bare.exec(html)) !== null && into.size < want) {
    const k = key(m);
    if (into.has(k)) continue;
    into.set(k, { title: "" });
  }
  return into;
}

/** Regexes for one result type: title-bearing anchors, then bare URLs. */
function urlSource(pattern, keyFn) {
  return {
    anchor: new RegExp(`<a\\b[^>]*\\bhref="(?:${pattern})[^"]*"[^>]*>([\\s\\S]{0,2500}?)</a>`, "gi"),
    bare: new RegExp(pattern, "gi"),
    key: keyFn,
  };
}

const BLOG_PATTERN = "https?://(?:m\\.)?blog\\.naver\\.com/([A-Za-z0-9_-]+)/(\\d{6,})";
const CAFE_PATTERN = "https?://cafe\\.naver\\.com/([A-Za-z0-9_-]+)/(\\d{2,})";
const NEWS_PATTERN = "https?://n\\.news\\.naver\\.com/(?:mnews/)?article/(\\d{3})/(\\d{10})";

const pairKey = (m) => `${m[1]}/${m[2]}`;

/* -------------------------------------------------------------- 1. blog search */

export async function naverBlogSearch({ query, count = 10, sort = "sim" }) {
  if (!query || !String(query).trim()) {
    throw new NaverError("BAD_INPUT", "query is required");
  }
  const want = clampCount(count);
  const byDate = sort === "date";
  const sortParam = byDate ? "&nso=so%3Add%2Cp%3Aall%2Ca%3Aall" : "";
  const src = urlSource(BLOG_PATTERN, pairKey);
  const seen = new Map();

  // Date sort widens the match rather than just reordering it: asking for
  // "10평 카페 인테리어" by date returned recent posts about air conditioners
  // and wedding halls. Naver's own parameters do not tighten it, so the
  // filtering happens here - keep only titles that carry a query word, and
  // page further to make up for what gets dropped.
  const keywords = byDate ? query.split(/\s+/).filter((t) => t.length >= 2) : [];
  const onTopic = (title) => !byDate || (title && keywords.some((k) => title.includes(k)));

  const overFetch = byDate ? want * 4 : want;

  for (let start = 1; start <= 91; start += PAGE_SIZE) {
    const url =
      `https://m.search.naver.com/search.naver?ssc=tab.m_blog.all&sm=mtb_jum` +
      `&query=${encodeURIComponent(query)}&start=${start}${sortParam}`;
    const html = await httpGet(url, { referer: SEARCH_REFERER });

    const before = seen.size;
    collectHits(html, src, seen, overFetch);
    if (seen.size === before) break; // page added nothing new

    const kept = [...seen.values()].filter((v) => onTopic(v.title)).length;
    if (kept >= want) break;
    await sleep(600); // be polite between pages
  }

  const items = [...seen.entries()]
    .filter(([, v]) => onTopic(v.title))
    .slice(0, want)
    .map(([key, v]) => ({ url: `https://m.blog.naver.com/${key}`, title: v.title }));

  if (!items.length) {
    throw new NaverError(
      "PARSE_FAILED",
      byDate
        ? `최신순 결과에 "${query}" 와 관련된 글이 없습니다. 정확도순(sort 생략)으로 다시 시도하세요.`
        : "Search page loaded but no blog posts were found in it.",
      { query, sort }
    );
  }

  const lines = items.map(
    (it, i) => `${i + 1}. ${it.title || "(제목 미확인)"}\n   ${it.url}`
  );
  return `"${query}" 블로그 검색 결과 ${items.length}건 (정렬: ${sort})\n\n${lines.join("\n")}`;
}

/* ---------------------------------------------------------------- 2. blog read */

export async function naverBlogRead({ url, max_chars }) {
  const ref = parseBlogUrl(url);
  if (!ref || !ref.logNo) {
    throw new NaverError(
      "BAD_INPUT",
      "Could not read a blogId/logNo out of that URL. Expected something like https://blog.naver.com/{blogId}/{logNo}.",
      { url }
    );
  }

  const routes = blogReadRoutes(ref.blogId, ref.logNo);
  const post = await readViaChain(routes, DEFAULT_BLOG_ORDER);

  const header = [
    post.title ? `# ${post.title}` : `# ${ref.blogId}/${ref.logNo}`,
    `출처: https://m.blog.naver.com/${ref.blogId}/${ref.logNo}`,
    post.date ? `작성일: ${post.date}` : null,
    `경로: ${post.route} (추출: ${post.strategy})`,
  ]
    .filter(Boolean)
    .join("\n");

  const body = capLength(post.text, max_chars);
  return `${header}\n\n---\n\n${body.text}`;
}

/**
 * Preference order measured by the step-0 probe. All four stay in the chain;
 * this only decides what is tried first.
 */
export const DEFAULT_BLOG_ORDER = ["direct-mobile", "pc-postview", "jina-reader", "rss"];

/* ------------------------------------------------------- 2b. any article read */

/** Header shared by every read tool, so the source link is never missing. */
function articleHeader({ title, fallback, source, date, route, strategy, extra }) {
  return [
    title ? `# ${title}` : `# ${fallback}`,
    `출처: ${source}`,
    date ? `작성일: ${date}` : null,
    extra || null,
    `경로: ${route} (추출: ${strategy})`,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Read a post from Naver blog, a public Naver cafe, Tistory, or another
 * ordinary blog host, picking the extractor from the URL.
 */
export async function readArticle({ url, max_chars }) {
  const raw = String(url || "").trim();
  if (!/^https?:\/\//i.test(raw)) {
    throw new NaverError("BAD_INPUT", "A full http(s):// URL is required.", { url: raw });
  }

  // Naver blog first - it has the richest chain and its own extractor.
  if (parseBlogUrl(raw)?.logNo) return naverBlogRead({ url: raw, max_chars });
  if (parseNewsUrl(raw)) return naverNewsRead({ url: raw, max_chars });

  const cafe = parseCafeUrl(raw);
  if (cafe) {
    const post = await readViaChain(cafeReadRoutes(cafe.cafeId, cafe.articleId));
    const source = `https://cafe.naver.com/${cafe.cafeId}/${cafe.articleId}`;
    return `${articleHeader({
      title: post.title,
      fallback: `${cafe.cafeId}/${cafe.articleId}`,
      source,
      date: post.date,
      route: post.route,
      strategy: post.strategy,
      extra: `카페: ${cafe.cafeId}`,
    })}\n\n---\n\n${capLength(post.text, max_chars).text}`;
  }

  const tistory = parseTistoryUrl(raw);
  if (tistory) {
    const post = await readViaChain(tistoryReadRoutes(tistory.host, tistory.path));
    const source = `https://${tistory.host}/${tistory.path}`;
    return `${articleHeader({
      title: post.title,
      fallback: tistory.host,
      source,
      date: post.date,
      route: post.route,
      strategy: post.strategy,
      extra: `사이트: ${tistory.host}`,
    })}\n\n---\n\n${capLength(post.text, max_chars).text}`;
  }

  // Search results link straight at PDFs and HWPs as often as at pages, and
  // running those through the HTML reader yields binary noise. Hand them off
  // rather than making the caller notice and pick a different tool.
  if (detectKind(raw)) return readFileUrl({ url: raw, max_chars });

  // Anything else - government sites, journals, ordinary news - reads through
  // the generic path. Naver's search links out to all of these, so refusing
  // unrecognised hosts would make search results unopenable.
  const post = await readViaChain(genericReadRoutes(raw));
  let host = raw;
  try {
    host = new URL(raw).hostname;
  } catch {
    /* keep the raw string */
  }
  return `${articleHeader({
    title: post.title,
    fallback: host,
    source: raw,
    date: post.date,
    route: post.route,
    strategy: post.strategy,
    extra: `사이트: ${host}`,
  })}\n\n---\n\n${capLength(post.text, max_chars).text}`;
}

/* ----------------------------------------------------------- 2d. file read */

/**
 * Read a PDF, HWPX, or image by URL.
 *
 * Returns text for documents and an image block for pictures, so the caller
 * gets whichever form the file can actually be understood in.
 */
export async function readFileUrl({ url, max_chars }) {
  const raw = String(url || "").trim();
  if (!/^https?:\/\//i.test(raw)) {
    throw new NaverError("BAD_INPUT", "A full http(s):// URL is required.", { url: raw });
  }

  let origin = null;
  try {
    origin = new URL(raw).origin + "/";
  } catch {
    /* referer is optional */
  }

  const res = await readFile(raw, { referer: origin });

  if (res.type === "image") {
    return {
      blocks: [
        { type: "text", text: `출처: ${raw}\n형식: 이미지 (${res.mimeType}, ${(res.bytes / 1024).toFixed(0)}KB)` },
        { type: "image", data: res.base64, mimeType: res.mimeType },
      ],
    };
  }

  const header = [
    `출처: ${raw}`,
    `형식: ${res.how.startsWith("pdf") ? "PDF" : "HWPX"} (${res.how})`,
  ].join("\n");
  return `${header}\n\n---\n\n${capLength(res.text, max_chars).text}`;
}

/* --------------------------------------------------- 2c. integrated web search */

// Naver's own assets and shortener links are not results.
const NOT_A_RESULT =
  /(?:^|\.)(?:naver\.net|pstatic\.net|nstatic\.net|naver\.com\/?$|nid\.naver|help\.naver|policy\.naver|adcr\.naver)/i;

/**
 * Search Naver's web tab, which reaches past blogs and news into government
 * sites, institutes and journals - the sources that make Naver worth querying
 * for Korean material in the first place.
 */
export async function naverWebSearch({ query, count = 10 }) {
  if (!query || !String(query).trim()) {
    throw new NaverError("BAD_INPUT", "query is required");
  }
  const want = clampCount(count);
  const seen = new Map();

  for (let start = 1; seen.size < want && start <= 31; start += 15) {
    const url =
      `https://m.search.naver.com/search.naver?ssc=tab.m_web.all&where=m_web` +
      `&query=${encodeURIComponent(query)}&start=${start}`;
    const html = await httpGet(url, { referer: SEARCH_REFERER });

    const re = /<a\b[^>]*\bhref="(https?:\/\/[^"]+)"[^>]*>([\s\S]{0,1200}?)<\/a>/gi;
    let m;
    const before = seen.size;
    while ((m = re.exec(html)) !== null && seen.size < want) {
      const link = m[1].replace(/&amp;/g, "&");
      let host;
      try {
        host = new URL(link).hostname;
      } catch {
        continue;
      }
      if (NOT_A_RESULT.test(host) || host.endsWith("search.naver.com")) continue;
      if (seen.has(link)) continue;
      const title = cleanTitle(m[2]);
      if (!title) continue; // chrome links carry no usable title
      seen.set(link, { title, host });
    }
    if (seen.size === before) break;
    if (seen.size < want) await sleep(600);
  }

  const items = [...seen.entries()].slice(0, want);
  if (!items.length) {
    throw new NaverError("PARSE_FAILED", "Web search loaded but no external results were found.", { query });
  }
  const lines = items.map(
    ([link, v], i) => `${i + 1}. ${v.title}\n   ${link}\n   (${v.host})`
  );
  return (
    `"${query}" 네이버 웹 검색 결과 ${items.length}건\n\n${lines.join("\n")}\n\n` +
    `(본문이 필요하면 read_article 에 위 URL을 넣으세요.)`
  );
}

/* -------------------------------------------------------------- 3. news search */

export async function naverNewsSearch({ query, count = 10 }) {
  if (!query || !String(query).trim()) {
    throw new NaverError("BAD_INPUT", "query is required");
  }
  const want = clampCount(count);
  const src = urlSource(NEWS_PATTERN, pairKey);
  const seen = new Map();

  for (let start = 1; seen.size < want && start <= 91; start += PAGE_SIZE) {
    const url =
      `https://m.search.naver.com/search.naver?ssc=tab.m_news.all&where=m_news` +
      `&query=${encodeURIComponent(query)}&start=${start}`;
    const html = await httpGet(url, { referer: SEARCH_REFERER });

    const before = seen.size;
    collectHits(html, src, seen, want);
    if (seen.size === before) break;
    if (seen.size < want) await sleep(600);
  }

  const items = [...seen.entries()].slice(0, want).map(([key, v]) => ({
    url: `https://n.news.naver.com/mnews/article/${key}`,
    title: v.title,
  }));
  if (!items.length) {
    throw new NaverError("PARSE_FAILED", "News search page loaded but no articles were found in it.", { query });
  }
  const lines = items.map((it, i) => `${i + 1}. ${it.title || "(제목 미확인)"}\n   ${it.url}`);
  return `"${query}" 뉴스 검색 결과 ${items.length}건\n\n${lines.join("\n")}`;
}

/* ---------------------------------------------------------------- 4. news read */

const NEWS_BODY = [
  /<article[^>]*id="dic_area"[^>]*>([\s\S]*?)<\/article>/i,
  /<div[^>]*id="dic_area"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i,
  /<div[^>]*id="newsct_article"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i,
  /<div[^>]*class="[^"]*newsct_article[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i,
];

export async function naverNewsRead({ url, max_chars }) {
  const ref = parseNewsUrl(url);
  if (!ref) {
    throw new NaverError(
      "BAD_INPUT",
      "Could not read oid/aid out of that URL. Expected https://n.news.naver.com/mnews/article/{oid}/{aid}.",
      { url }
    );
  }
  const target = `https://n.news.naver.com/mnews/article/${ref.oid}/${ref.aid}`;
  const html = await httpGet(target, { referer: SEARCH_REFERER });

  let body = "";
  for (const re of NEWS_BODY) {
    const m = html.match(re);
    if (m) {
      body = htmlToText(m[1]);
      if (body.length > 80) break;
    }
  }
  if (!body || body.length < 80) {
    throw new NaverError(
      "PARSE_FAILED",
      "Fetched the article page but no known body container matched.",
      { url: target, bytes: html.length }
    );
  }

  const title = extractTitle(html);
  const press =
    (html.match(/<meta[^>]+property="og:site_name"[^>]+content="([^"]+)"/i) || [])[1] || "";
  const date =
    (html.match(/<span[^>]*class="[^"]*media_end_head_info_datestamp_time[^"]*"[^>]*data-date-time="([^"]+)"/i) || [])[1] ||
    extractDate(html);

  const header = [
    title ? `# ${title}` : `# ${ref.oid}/${ref.aid}`,
    press ? `언론사: ${press}` : null,
    date ? `작성일: ${date}` : null,
    `출처: ${target}`,
  ]
    .filter(Boolean)
    .join("\n");

  return `${header}\n\n---\n\n${capLength(body, max_chars).text}`;
}

/* -------------------------------------------------------------- 5. cafe search */

export async function naverCafeSearch({ query, count = 10 }) {
  if (!query || !String(query).trim()) {
    throw new NaverError("BAD_INPUT", "query is required");
  }
  const want = clampCount(count);
  // Only public cafe article links; member-only boards are not reachable
  // without a login and are deliberately not attempted.
  const src = urlSource(CAFE_PATTERN, pairKey);
  const seen = new Map();

  for (let start = 1; seen.size < want && start <= 91; start += PAGE_SIZE) {
    const url =
      `https://m.search.naver.com/search.naver?ssc=tab.m_cafe.all&where=m_cafe` +
      `&query=${encodeURIComponent(query)}&start=${start}`;
    const html = await httpGet(url, { referer: SEARCH_REFERER });

    const before = seen.size;
    collectHits(html, src, seen, want);
    if (seen.size === before) break;
    if (seen.size < want) await sleep(600);
  }

  const items = [...seen.entries()].slice(0, want).map(([key, v]) => ({
    url: `https://cafe.naver.com/${key}`,
    cafe: key.split("/")[0],
    title: v.title,
  }));
  if (!items.length) {
    throw new NaverError(
      "PARSE_FAILED",
      "Cafe search page loaded but no public cafe posts were found. Member-only posts are not accessible without a login.",
      { query }
    );
  }
  const lines = items.map(
    (it, i) => `${i + 1}. ${it.title || "(제목 미확인)"}\n   카페: ${it.cafe}\n   ${it.url}`
  );
  return `"${query}" 카페 검색 결과 ${items.length}건 (공개글만)\n\n${lines.join("\n")}`;
}

/* --------------------------------------------------- 6b. restaurant reviews */

/** Find a place id for a name, from the integrated results page. */
async function findPlaceId(query) {
  const html = await httpGet(
    `https://m.search.naver.com/search.naver?query=${encodeURIComponent(query)}`,
    { referer: SEARCH_REFERER }
  );
  // Place cards appear only on the integrated page, not the web tab.
  const m =
    html.match(/(?:place|pcmap\.place)\.naver\.com\/(restaurant|place|accommodation)\/(\d+)/) ||
    html.match(/place\.naver\.com\/(?:restaurant|place)\/(\d+)/);
  if (!m) return null;
  return m.length > 2 ? { kind: m[1], id: m[2] } : { kind: "restaurant", id: m[1] };
}

/**
 * Everything known about one restaurant: the star-rated visitor reviews and
 * the blog write-ups, with the links to both.
 */
export async function naverRestaurantReviews({ query, count = 10 }) {
  if (!query || !String(query).trim()) {
    throw new NaverError("BAD_INPUT", "query is required (가게 이름)");
  }
  const want = clampCount(count);
  const place = await findPlaceId(query);

  const sections = [];
  let visitorLink = null;

  if (place) {
    visitorLink = `https://m.place.naver.com/${place.kind}/${place.id}/review/visitor`;
    try {
      const res = await readViaChain(visitorReviewRoutes(place.id, place.kind));
      const lines = res.reviews.slice(0, want).map((r, i) => {
        const meta = [r.rating ? `★${r.rating}` : null, r.author || null, r.date || null]
          .filter(Boolean)
          .join(" · ");
        return `${i + 1}. ${r.text}${meta ? `\n   (${meta})` : ""}`;
      });
      sections.push(
        `## 방문자 리뷰 ${lines.length}건\n출처: ${visitorLink}\n\n${lines.join("\n")}`
      );
    } catch (e) {
      // Say why rather than dropping the section silently.
      sections.push(
        `## 방문자 리뷰\n출처: ${visitorLink}\n\n[${e.kind || "ERROR"}] ${e.message}`
      );
    }
  }

  try {
    sections.push(`## 블로그 후기\n\n${await naverPlaceReviews({ query, count: want })}`);
  } catch (e) {
    sections.push(`## 블로그 후기\n\n[${e.kind || "ERROR"}] ${e.message}`);
  }

  if (!sections.length) {
    throw new NaverError("PARSE_FAILED", "No reviews of any kind were found.", { query });
  }

  const header = place
    ? `# "${query}" 리뷰 모음\n플레이스: https://m.place.naver.com/${place.kind}/${place.id}/home`
    : `# "${query}" 리뷰 모음\n(플레이스 항목을 찾지 못해 블로그 후기만 모았습니다.)`;

  return `${header}\n\n${sections.join("\n\n---\n\n")}`;
}

/* ------------------------------------------------------------ 6. place reviews */

export async function naverPlaceReviews({ query, count = 10 }) {
  if (!query || !String(query).trim()) {
    throw new NaverError("BAD_INPUT", "query is required");
  }
  const want = clampCount(count);

  // Place "blog reviews" are ordinary blog posts about the place, so the most
  // reliable route is the blog tab scoped by the place name plus 리뷰/후기.
  const src = urlSource(BLOG_PATTERN, pairKey);
  const seen = new Map();
  let html = "";

  for (let start = 1; seen.size < want && start <= 91; start += PAGE_SIZE) {
    const url =
      `https://m.search.naver.com/search.naver?ssc=tab.m_blog.all` +
      `&query=${encodeURIComponent(query + " 후기")}&start=${start}`;
    const page = await httpGet(url, { referer: SEARCH_REFERER });
    if (start === 1) html = page; // first page also carries the place cards

    const before = seen.size;
    collectHits(page, src, seen, want);
    if (seen.size === before) break;
    if (seen.size < want) await sleep(600);
  }

  const placeIds = [
    ...new Set(
      (html.match(/place\.naver\.com\/(?:restaurant|place)\/(\d+)/g) || []).map((s) =>
        s.replace(/\D+/g, "")
      )
    ),
  ].slice(0, 3);

  const items = [...seen.entries()].slice(0, want).map(([key, v]) => ({
    url: `https://m.blog.naver.com/${key}`,
    title: v.title,
  }));
  if (!items.length) {
    throw new NaverError("PARSE_FAILED", "No blog reviews were found for that place.", { query });
  }

  const lines = items.map((it, i) => `${i + 1}. ${it.title || "(제목 미확인)"}\n   ${it.url}`);
  const placeLine = placeIds.length
    ? `\n\n플레이스 페이지: ${placeIds.map((id) => `https://m.place.naver.com/restaurant/${id}/review/ugc`).join(", ")}`
    : "";
  return (
    `"${query}" 플레이스 블로그 리뷰 ${items.length}건\n\n${lines.join("\n")}` +
    placeLine +
    `\n\n(본문을 읽으려면 naver_blog_read 에 위 URL을 넣으세요.)`
  );
}

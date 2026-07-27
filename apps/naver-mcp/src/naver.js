/**
 * Naver scraping layer.
 *
 * Every read goes through a fallback chain so that one blocked route does not
 * take the whole server down. Failures are classified (blocked vs. parse vs.
 * transport) because "Naver said no" and "we could not find the body" need
 * very different fixes.
 */

export const MOBILE_UA =
  "Mozilla/5.0 (Linux; Android 14; SM-S928N) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/126.0.6478.122 Mobile Safari/537.36";

/** Headers copied from a real mobile Chrome navigation request. */
function baseHeaders(referer) {
  const h = {
    "User-Agent": MOBILE_UA,
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Ch-Ua": '"Chromium";v="126", "Google Chrome";v="126", "Not-A.Brand";v="99"',
    "Sec-Ch-Ua-Mobile": "?1",
    "Sec-Ch-Ua-Platform": '"Android"',
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": referer ? "same-origin" : "none",
    "Sec-Fetch-User": "?1",
  };
  if (referer) h.Referer = referer;
  return h;
}

const BLOCK_SIGNS = [
  "많은 요청이 있습니다",
  "비정상적인 접근",
  "자동입력 방지",
  "captcha",
  "이용이 제한",
  "접근이 차단",
  "일시적으로 제한",
];

export class NaverError extends Error {
  constructor(kind, message, detail) {
    super(message);
    this.kind = kind; // BLOCKED | PARSE_FAILED | NOT_FOUND | TRANSPORT | UPSTREAM
    this.detail = detail || null;
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Single HTTP GET with retry. Workers' fetch decompresses gzip transparently.
 * Retries 429/403/5xx with exponential backoff; those are usually rate limits
 * rather than hard bans.
 */
export async function httpGet(url, { referer, timeoutMs = 15000, retries = 2 } = {}) {
  let lastErr = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(400 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250));

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const resp = await fetch(url, {
        headers: baseHeaders(referer),
        redirect: "follow",
        signal: ctl.signal,
        cf: { cacheTtl: 0, cacheEverything: false },
      });
      const text = await resp.text();

      if (resp.status === 429 || resp.status === 403) {
        lastErr = new NaverError("BLOCKED", `Naver returned HTTP ${resp.status}`, { url, status: resp.status });
        continue;
      }
      if (resp.status >= 500) {
        lastErr = new NaverError("UPSTREAM", `Naver returned HTTP ${resp.status}`, { url, status: resp.status });
        continue;
      }
      if (resp.status === 404) {
        throw new NaverError("NOT_FOUND", "Page does not exist (HTTP 404)", { url });
      }
      if (!resp.ok) {
        throw new NaverError("UPSTREAM", `Unexpected HTTP ${resp.status}`, { url, status: resp.status });
      }

      const low = text.toLowerCase();
      const sign = BLOCK_SIGNS.find((s) => low.includes(s.toLowerCase()));
      if (sign && text.length < 20000) {
        lastErr = new NaverError("BLOCKED", `Naver served a block page (${sign})`, { url });
        continue;
      }
      return text;
    } catch (e) {
      clearTimeout(timer);
      if (e instanceof NaverError && e.kind === "NOT_FOUND") throw e;
      lastErr =
        e instanceof NaverError
          ? e
          : new NaverError("TRANSPORT", `Request failed: ${e.message}`, { url });
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new NaverError("TRANSPORT", "Request failed with no further detail", { url });
}

/* ------------------------------------------------------------------ HTML */

const SCRIPT_RE = /<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi;
const BLOCK_END_RE = /<\/(p|div|li|h[1-6]|blockquote|tr)>|<br\s*\/?>/gi;

// "&amp;" is deliberately absent: it must be decoded last, after every other
// entity, or "&amp;#x27;" (a literal "&#x27;" in the source) turns into an
// apostrophe instead of the text the author actually wrote.
const ENTITIES = {
  "&nbsp;": " ", "&lt;": "<", "&gt;": ">",
  "&quot;": '"', "&apos;": "'", "&middot;": "·",
};

/** Decode every entity form in the correct order, "&amp;" last. */
function decodeAllEntities(s) {
  let out = decodeNumericEntities(String(s || ""));
  for (const [k, v] of Object.entries(ENTITIES)) out = out.split(k).join(v);
  return out.split("&amp;").join("&");
}

/**
 * Decode numeric character references. Naver's editor emits the hex form
 * (`&#x27;` for an apostrophe) far more often than the decimal one, so
 * handling only decimals leaves literal `&#x27;` sitting in the output.
 */
function decodeNumericEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => {
      const cp = parseInt(h, 16);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    })
    .replace(/&#(\d+);/g, (m, d) => {
      const cp = Number(d);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    });
}

export function htmlToText(html) {
  let s = String(html || "").replace(SCRIPT_RE, " ").replace(BLOCK_END_RE, "\n");
  s = decodeAllEntities(s.replace(/<[^>]+>/g, " "));
  return s
    .split("\n")
    .map((ln) => ln.replace(/[ \t​ ]+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

export function decodeEntities(s) {
  return decodeAllEntities(s).replace(/<[^>]+>/g, "").trim();
}

/**
 * SmartEditor ONE first, then the older layouts. Returns null when no
 * container matched so the caller can try the next fallback route.
 */
const CONTAINERS = [
  ["se-main-container", /<div[^>]*class="[^"]*se-main-container[^"]*"[^>]*>([\s\S]*)/i],
  ["postViewArea", /<div[^>]*id="postViewArea"[^>]*>([\s\S]*)/i],
  ["post-view", /<div[^>]*class="[^"]*post-view[^"]*"[^>]*>([\s\S]*)/i],
  ["__content", /<div[^>]*id="__content"[^>]*>([\s\S]*)/i],
  ["se_component_wrap", /<div[^>]*class="[^"]*se_component_wrap[^"]*"[^>]*>([\s\S]*)/i],
];

export function extractPostBody(html) {
  for (const [name, re] of CONTAINERS) {
    const m = html.match(re);
    if (!m) continue;
    // Cut at known post-body boundaries to avoid swallowing comments/footer.
    let chunk = m[1];
    const stop = chunk.search(
      /<div[^>]*class="[^"]*(?:se-lastLine|area_comment|post_footer|floating_menu|btn_recommend)/i
    );
    if (stop > 200) chunk = chunk.slice(0, stop);
    const text = htmlToText(chunk);
    if (text.length > 80) return { strategy: name, text };
  }
  return null;
}

export function extractTitle(html) {
  const pats = [
    /<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i,
    /<div[^>]*class="[^"]*se-title-text[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<h3[^>]*class="[^"]*se_textarea[^"]*"[^>]*>([\s\S]*?)<\/h3>/i,
    /<title>([\s\S]*?)<\/title>/i,
  ];
  for (const p of pats) {
    const m = html.match(p);
    if (m) {
      const t = decodeEntities(m[1]);
      if (t) return t.replace(/\s*:\s*네이버\s*블로그\s*$/, "").trim();
    }
  }
  return "";
}

export function extractDate(html) {
  const pats = [
    /<span[^>]*class="[^"]*se_publishDate[^"]*"[^>]*>([\s\S]*?)<\/span>/i,
    /<p[^>]*class="[^"]*se_publishDate[^"]*"[^>]*>([\s\S]*?)<\/p>/i,
    /<span[^>]*class="[^"]*_postAddDate[^"]*"[^>]*>([\s\S]*?)<\/span>/i,
    /<meta[^>]+property="article:published_time"[^>]+content="([^"]+)"/i,
  ];
  for (const p of pats) {
    const m = html.match(p);
    if (m) {
      const d = decodeEntities(m[1]);
      if (d) return d;
    }
  }
  return "";
}

/* ------------------------------------------------------------- URL utils */

/** blog.naver.com renders the body inside an iframe, so normalise to m.blog. */
export function parseBlogUrl(url) {
  const s = String(url || "").trim();
  let m = s.match(/blog\.naver\.com\/([A-Za-z0-9_-]+)\/(\d{6,})/);
  if (m) return { blogId: m[1], logNo: m[2] };

  m = s.match(/[?&]blogId=([A-Za-z0-9_-]+)/);
  const n = s.match(/[?&]logNo=(\d{6,})/);
  if (m && n) return { blogId: m[1], logNo: n[1] };

  m = s.match(/blog\.naver\.com\/([A-Za-z0-9_-]+)\/?$/);
  if (m) return { blogId: m[1], logNo: null };

  return null;
}

export function parseCafeUrl(url) {
  const s = String(url || "").trim();
  const m = s.match(/cafe\.naver\.com\/(?:ca-fe\/web\/cafes\/)?([A-Za-z0-9_-]+)(?:\/articles)?\/(\d+)/);
  return m ? { cafeId: m[1], articleId: m[2] } : null;
}

export function parseTistoryUrl(url) {
  const s = String(url || "").trim();
  // Tistory serves both {name}.tistory.com/123 and custom domains that keep
  // the same /123 or /entry/{slug} shape.
  const m = s.match(/^https?:\/\/([^/]+)\/(entry\/[^?#]+|\d+)/i);
  if (!m) return null;
  return { host: m[1], path: m[2] };
}

export function parseNewsUrl(url) {
  const s = String(url || "").trim();
  const m = s.match(/news\.naver\.com\/(?:mnews\/)?article\/(\d{3})\/(\d{10})/) ||
            s.match(/[?&]oid=(\d{3})[^]*?[?&]aid=(\d{10})/);
  return m ? { oid: m[1], aid: m[2] } : null;
}

/* --------------------------------------------------------- fallback chain */

/**
 * Ordered blog-read routes. The default order is set from the step-0 probe;
 * every route stays in the chain so a future block on one path degrades
 * instead of breaking.
 */
export function blogReadRoutes(blogId, logNo) {
  return [
    {
      name: "direct-mobile",
      url: `https://m.blog.naver.com/${blogId}/${logNo}`,
      referer: "https://m.search.naver.com/",
      parse: (html) => {
        const body = extractPostBody(html);
        if (!body) return null;
        return { title: extractTitle(html), date: extractDate(html), ...body };
      },
    },
    {
      name: "pc-postview",
      url:
        `https://blog.naver.com/PostView.naver?blogId=${blogId}&logNo=${logNo}` +
        `&redirect=Dlog&widgetTypeCall=true&directAccess=false`,
      referer: `https://blog.naver.com/${blogId}`,
      parse: (html) => {
        const body = extractPostBody(html);
        if (!body) return null;
        return { title: extractTitle(html), date: extractDate(html), ...body };
      },
    },
    {
      name: "jina-reader",
      url: `https://r.jina.ai/https://m.blog.naver.com/${blogId}/${logNo}`,
      referer: null,
      timeoutMs: 40000,
      parse: (md) => parseJinaMarkdown(md),
    },
    {
      name: "rss",
      url: `https://rss.blog.naver.com/${blogId}.xml`,
      referer: null,
      parse: (xml) => {
        // RSS only carries recent posts; match the requested one if present.
        const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].map((m) => m[1]);
        const hit = items.find((it) => it.includes(String(logNo))) || null;
        if (!hit) return null;
        const pick = (tag) => {
          const m = hit.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
          return m ? decodeEntities(m[1].replace(/<!\[CDATA\[|\]\]>/g, "")) : "";
        };
        const text = htmlToText(pick("description"));
        if (text.length < 80) return null;
        return { strategy: "rss-description", title: pick("title"), date: pick("pubDate"), text };
      },
    },
  ];
}

/** Body containers used by Tistory themes and most Korean blog platforms. */
const ARTICLE_CONTAINERS = [
  ["tt_article", /<div[^>]*class="[^"]*tt_article_useless_p_margin[^"]*"[^>]*>([\s\S]*)/i],
  ["article_view", /<div[^>]*class="[^"]*article_view[^"]*"[^>]*>([\s\S]*)/i],
  ["entry-content", /<div[^>]*class="[^"]*entry-content[^"]*"[^>]*>([\s\S]*)/i],
  ["article-view", /<div[^>]*id="article-view"[^>]*>([\s\S]*)/i],
  ["contents_style", /<div[^>]*class="[^"]*contents_style[^"]*"[^>]*>([\s\S]*)/i],
  ["article-tag", /<article[^>]*>([\s\S]*?)<\/article>/i],
];

/** Extract a post body from a generic (non-Naver-blog) article page. */
export function extractArticleBody(html) {
  for (const [name, re] of ARTICLE_CONTAINERS) {
    const m = html.match(re);
    if (!m) continue;
    let chunk = m[1];
    const stop = chunk.search(
      /<div[^>]*(?:class|id)="[^"]*(?:comment|reply|footer|related|sns|share|tt_footer)/i
    );
    if (stop > 200) chunk = chunk.slice(0, stop);
    const text = htmlToText(chunk);
    if (text.length > 120) return { strategy: name, text };
  }
  return null;
}

// A cafe article behind a login looks like a successful fetch, so it has to be
// recognised by content or it gets reported as a parsing bug.
const LOGIN_WALL = [
  "nid.naver.com/nidlogin",
  "로그인이 필요합니다",
  "카페 가입",
  "가입하신 후 이용",
  "멤버만 볼 수 있",
  "등급이 되어야",
  "권한이 없습니다",
];

/** Naver cafe public articles. Member-only boards need a login and will fail. */
export function cafeReadRoutes(cafeId, articleId) {
  const parse = (html) => {
    const body = extractPostBody(html) || extractArticleBody(html);
    if (body) return { title: extractTitle(html), date: extractDate(html), ...body };
    // No body: say *why*, so "members only" is not reported as a layout problem.
    if (LOGIN_WALL.some((sign) => html.includes(sign))) {
      throw new NaverError(
        "LOGIN_REQUIRED",
        "This cafe post is members-only; it cannot be read without signing in.",
        { cafeId, articleId }
      );
    }
    return null;
  };
  return [
    {
      name: "cafe-mobile",
      url: `https://m.cafe.naver.com/ca-fe/web/cafes/${cafeId}/articles/${articleId}`,
      referer: "https://m.search.naver.com/",
      parse,
    },
    {
      name: "cafe-mobile-legacy",
      url: `https://m.cafe.naver.com/${cafeId}/${articleId}`,
      referer: "https://m.search.naver.com/",
      parse,
    },
    {
      name: "cafe-jina",
      url: `https://r.jina.ai/https://m.cafe.naver.com/${cafeId}/${articleId}`,
      referer: null,
      timeoutMs: 40000,
      parse: (md) => parseJinaMarkdown(md),
    },
  ];
}

/** Tistory and other ordinary blog hosts. */
export function tistoryReadRoutes(host, path) {
  const parse = (html) => {
    const body = extractArticleBody(html) || extractPostBody(html);
    if (!body) return null;
    return { title: extractTitle(html), date: extractDate(html), ...body };
  };
  return [
    { name: "direct", url: `https://${host}/${path}`, referer: `https://${host}/`, parse },
    {
      name: "jina",
      url: `https://r.jina.ai/https://${host}/${path}`,
      referer: null,
      timeoutMs: 40000,
      parse: (md) => parseJinaMarkdown(md),
    },
  ];
}

/**
 * Any other page: try the article containers, then fall back to the whole
 * document. Naver's search surfaces link out to government sites, journals and
 * PDFs-as-HTML that share no common markup, so a permissive reader beats
 * refusing anything unrecognised.
 */
function extractGenericBody(html) {
  const article = extractArticleBody(html) || extractPostBody(html);
  if (article) return article;

  // Strip page chrome before falling back, or navigation swamps the body.
  const stripped = html
    .replace(/<(nav|header|footer|aside|form)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<div[^>]*(?:class|id)="[^"]*(?:gnb|lnb|snb|nav|menu|footer|header|banner|sidebar)[^"]*"[^>]*>[\s\S]{0,4000}?<\/div>/gi, " ");

  for (const re of [
    /<main[^>]*>([\s\S]*?)<\/main>/i,
    /<div[^>]*(?:id|class)="[^"]*(?:content|container|board|view|body)[^"]*"[^>]*>([\s\S]*)/i,
  ]) {
    const m = stripped.match(re);
    if (m) {
      const text = htmlToText(m[1]);
      if (text.length > 200) return { strategy: "generic-container", text };
    }
  }

  const text = htmlToText(stripped);
  return text.length > 200 ? { strategy: "whole-document", text } : null;
}

/** Read any URL: fetch it directly, then let the reader proxy try. */
export function genericReadRoutes(url) {
  const parse = (html) => {
    const body = extractGenericBody(html);
    if (!body) return null;
    return { title: extractTitle(html), date: extractDate(html), ...body };
  };
  let origin = "";
  try {
    origin = new URL(url).origin + "/";
  } catch {
    origin = "";
  }
  return [
    { name: "direct", url, referer: origin || null, parse },
    {
      name: "jina",
      url: `https://r.jina.ai/${url}`,
      referer: null,
      timeoutMs: 40000,
      parse: (md) => parseJinaMarkdown(md),
    },
  ];
}

/** r.jina.ai returns markdown behind a small "Title:/URL Source:" preamble. */
export function parseJinaMarkdown(md) {
  if (!md || md.length < 200) return null;
  const t = md.match(/^Title:\s*(.+)$/m);
  const body = md.replace(/^(Title|URL Source|Published Time|Markdown Content):.*$/gm, "").trim();
  if (body.length < 120) return null;
  return { strategy: "jina-markdown", title: t ? t[1].trim() : "", date: "", text: body };
}

/**
 * Walk the chain and return the first usable result, along with a per-route
 * trace so callers can report exactly what happened.
 */
export async function readViaChain(routes, order) {
  const ordered = order
    ? order.map((n) => routes.find((r) => r.name === n)).filter(Boolean)
    : routes;
  const chain = ordered.length ? ordered : routes;
  const trace = [];

  for (const route of chain) {
    try {
      const raw = await httpGet(route.url, {
        referer: route.referer,
        timeoutMs: route.timeoutMs || 15000,
        retries: 1,
      });
      const parsed = route.parse(raw);
      if (!parsed) {
        trace.push({ route: route.name, result: "PARSE_FAILED", bytes: raw.length });
        continue;
      }
      trace.push({ route: route.name, result: "OK", chars: parsed.text.length });
      return { ...parsed, route: route.name, trace };
    } catch (e) {
      trace.push({
        route: route.name,
        result: e instanceof NaverError ? e.kind : "TRANSPORT",
        message: e.message,
      });
    }
  }

  // When every route agrees on why it failed, report that reason rather than
  // flattening a login wall or a block into "could not parse".
  const kinds = new Set(trace.map((t) => t.result));
  const only = kinds.size === 1 ? [...kinds][0] : null;
  const kind = only === "BLOCKED" || only === "LOGIN_REQUIRED" || only === "NOT_FOUND"
    ? only
    : trace.some((t) => t.result === "LOGIN_REQUIRED")
      ? "LOGIN_REQUIRED"
      : "PARSE_FAILED";

  const message = {
    BLOCKED: "All routes were blocked by Naver.",
    LOGIN_REQUIRED: "This post is members-only or private; it cannot be read without signing in.",
    NOT_FOUND: "The post does not exist, or has been deleted.",
    PARSE_FAILED: "Reached the page but could not extract a body on any route.",
  }[kind];

  throw new NaverError(kind, message, { trace });
}

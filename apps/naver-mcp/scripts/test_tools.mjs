/**
 * Runs the real tool implementations against live Naver from a GitHub runner.
 *
 * This exercises the exact scraping/parsing code the Worker ships, so the
 * logic is verified independently of whether a Cloudflare deploy has happened.
 */

import {
  naverBlogSearch,
  naverBlogRead,
  naverNewsSearch,
  naverNewsRead,
  naverCafeSearch,
  naverPlaceReviews,
  readArticle,
  naverWebSearch,
  naverRestaurantReviews,
} from "../src/tools.js";

import { httpGet } from "../src/naver.js";

let failures = 0;
const summary = [];

function show(label, text, { minChars = 100 } = {}) {
  const ok = typeof text === "string" && text.length >= minChars;
  if (!ok) failures++;
  summary.push([label, ok ? "PASS" : "FAIL", `${(text || "").length} chars`]);
  console.log("=".repeat(72));
  console.log(`${ok ? "[PASS]" : "[FAIL]"} ${label}  (${(text || "").length} chars)`);
  console.log("=".repeat(72));
  console.log((text || "").slice(0, 900));
  console.log();
  return ok;
}

async function step(label, fn, opts) {
  try {
    const out = await fn();
    return show(label, out, opts);
  } catch (e) {
    failures++;
    summary.push([label, "ERROR", e.kind ? `${e.kind}: ${e.message}` : e.message]);
    console.log("=".repeat(72));
    console.log(`[ERROR] ${label}`);
    console.log(`  kind   : ${e.kind || "unknown"}`);
    console.log(`  message: ${e.message}`);
    if (e.detail) console.log(`  detail : ${JSON.stringify(e.detail).slice(0, 600)}`);
    console.log();
    return false;
  }
}

const run = async () => {
  // 1. blog search -> take a real URL out of it and read it
  let blogUrl = null;
  await step("naver_blog_search('제주도 맛집', 5)", async () => {
    const out = await naverBlogSearch({ query: "제주도 맛집", count: 5 });
    const m = out.match(/https:\/\/m\.blog\.naver\.com\/[A-Za-z0-9_-]+\/\d+/);
    if (m) blogUrl = m[0];
    return out;
  });

  if (blogUrl) {
    console.log(`--> reading the first search hit: ${blogUrl}\n`);
    await step(`naver_blog_read(${blogUrl})`, () => naverBlogRead({ url: blogUrl }), { minChars: 300 });
  } else {
    failures++;
    summary.push(["naver_blog_read", "SKIP", "search produced no URL"]);
  }

  // A PC-form URL must be normalised to m.blog and still return a body.
  await step("naver_blog_read(PC blog.naver.com URL)", async () => {
    if (!blogUrl) throw new Error("no blog url from search");
    const [, id, no] = blogUrl.match(/m\.blog\.naver\.com\/([A-Za-z0-9_-]+)\/(\d+)/);
    return naverBlogRead({ url: `https://blog.naver.com/${id}/${no}` });
  }, { minChars: 300 });

  // max_chars must actually cap the body and say so, so a caller never
  // summarises a half-post as if it were whole.
  if (blogUrl) {
    await step("naver_blog_read(max_chars=800) truncates and says so", async () => {
      const out = await naverBlogRead({ url: blogUrl, max_chars: 800 });
      const full = await naverBlogRead({ url: blogUrl, max_chars: 0 });
      if (out.length >= full.length) throw new Error(`not capped: ${out.length} vs full ${full.length}`);
      if (!out.includes("본문이 길어")) throw new Error("truncation not announced");
      return out;
    }, { minChars: 300 });
  }

  // Titles must survive the result quota: the real title for a URL often sits
  // in a later anchor than the one that first introduced it, so a scan that
  // stops at `want` leaves entries blank.
  await step("naver_blog_search titles are not blank", async () => {
    const out = await naverBlogSearch({ query: "제주도 맛집", count: 5 });
    const blanks = (out.match(/\(제목 미확인\)/g) || []).length;
    if (blanks > 1) throw new Error(`${blanks}/5 results have no title`);
    return out;
  });

  // Date sort must reorder the same matches, not widen them. It was returning
  // recent posts about air conditioners and wedding halls for a cafe-interior
  // query, so assert the results still relate to what was asked.
  await step("naver_blog_search(sort=date) stays on topic", async () => {
    const q = "10평 카페 인테리어";
    const out = await naverBlogSearch({ query: q, count: 8, sort: "date" });
    const titles = [...out.matchAll(/^\s*\d+\.\s+(.+)$/gm)]
      .map((m) => m[1].trim())
      .filter((t) => t !== "(제목 미확인)");
    if (titles.length < 4) throw new Error(`only ${titles.length} titled results`);

    const tokens = q.split(/\s+/).filter((t) => t.length >= 2);
    const onTopic = titles.filter((t) => tokens.some((k) => t.includes(k)));
    const ratio = onTopic.length / titles.length;
    console.log(`--> on-topic ${onTopic.length}/${titles.length}`);
    for (const t of titles) {
      console.log(`    ${tokens.some((k) => t.includes(k)) ? "  ok" : "OFF "} ${t.slice(0, 52)}`);
    }
    if (ratio < 0.6) throw new Error(`only ${Math.round(ratio * 100)}% of date-sorted titles relate to "${q}"`);
    return out;
  });

  // 2. news
  let newsUrl = null;
  await step("naver_news_search('금리', 5)", async () => {
    const out = await naverNewsSearch({ query: "금리", count: 5 });
    const m = out.match(/https:\/\/n\.news\.naver\.com\/mnews\/article\/\d+\/\d+/);
    if (m) newsUrl = m[0];
    return out;
  });
  if (newsUrl) {
    await step(`naver_news_read(${newsUrl})`, () => naverNewsRead({ url: newsUrl }), { minChars: 200 });
  }

  // read_article must route by URL shape and always print the source link.
  if (blogUrl) {
    await step("read_article(naver blog) includes 출처", async () => {
      const out = await readArticle({ url: blogUrl, max_chars: 800 });
      if (!out.includes(`출처: `)) throw new Error("no 출처 line");
      if (!out.includes("blog.naver.com")) throw new Error("source link missing");
      return out;
    }, { minChars: 300 });
  }

  // Tistory: find a live post through Naver's web tab rather than hardcoding
  // one, so the test does not rot when a single blog disappears.
  await step("read_article(tistory)", async () => {
    const q = encodeURIComponent("맛집 후기 site:tistory.com");
    const html = await httpGet(
      `https://m.search.naver.com/search.naver?ssc=tab.m_web.all&query=${q}`,
      { referer: "https://m.search.naver.com/" }
    );
    const hit = html.match(/https?:\/\/[a-z0-9-]+\.tistory\.com\/(?:entry\/[^"'?#]+|\d+)/i);
    if (!hit) throw new Error("no tistory URL found in search results");
    console.log(`--> tistory target: ${hit[0]}`);
    const out = await readArticle({ url: hit[0], max_chars: 800 });
    if (!out.includes("출처: ")) throw new Error("no 출처 line");
    return out;
  }, { minChars: 300 });

  // 3. cafe + place
  await step("naver_cafe_search('캠핑 후기', 5)", () => naverCafeSearch({ query: "캠핑 후기", count: 5 }));

  // Many cafe posts are members-only, so a single sample is a coin flip. Walk
  // several and require that at least one public post reads, while checking
  // that the members-only ones fail as LOGIN_REQUIRED rather than as a
  // parsing bug - that distinction is what the user sees.
  await step("read_article(naver cafe) - at least one public post reads", async () => {
    const list = await naverCafeSearch({ query: "캠핑 후기", count: 8 });
    const urls = [...list.matchAll(/https:\/\/cafe\.naver\.com\/[A-Za-z0-9_-]+\/\d+/g)].map((m) => m[0]);
    if (!urls.length) throw new Error("no cafe URLs from search");

    const outcomes = [];
    for (const u of urls.slice(0, 5)) {
      try {
        const out = await readArticle({ url: u, max_chars: 800 });
        if (!out.includes("출처: ")) throw new Error("no 출처 line");
        console.log(`--> readable: ${u}`);
        outcomes.push("OK");
        return `${outcomes.length} tried, readable at ${u}\n\n${out}`;
      } catch (e) {
        console.log(`--> ${e.kind || "ERROR"}: ${u}`);
        outcomes.push(e.kind || "ERROR");
      }
    }
    throw new Error(`no readable public cafe post in ${outcomes.length}: ${outcomes.join(", ")}`);
  }, { minChars: 300 });
  await step("naver_place_reviews('성수동 카페', 5)", () => naverPlaceReviews({ query: "성수동 카페", count: 5 }));

  // Web search is the route to sources blog search never surfaces - agencies,
  // institutes, journals - so it must return links off naver.com.
  let webUrl = null;
  await step("naver_web_search('한국소비자원 피해구제', 5)", async () => {
    const out = await naverWebSearch({ query: "한국소비자원 피해구제", count: 5 });
    const links = [...out.matchAll(/https?:\/\/[^\s]+/g)].map((m) => m[0]);
    const offNaver = links.filter((l) => !/naver\.com/i.test(l));
    if (!offNaver.length) throw new Error("every result was a naver.com link");
    webUrl = offNaver[0];
    return out;
  });

  // read_article must open whatever web search returned, whatever host it is.
  await step("read_article(generic site from web search)", async () => {
    if (!webUrl) throw new Error("no external URL from web search");
    console.log(`--> generic target: ${webUrl}`);
    const out = await readArticle({ url: webUrl, max_chars: 800 });
    if (!out.includes("출처: ")) throw new Error("no 출처 line");
    return out;
  }, { minChars: 300 });

  // The star-rated visitor reviews are the point of this tool - a response
  // that only carried blog links would look fine but miss what was asked for.
  await step("naver_restaurant_reviews('성수동 맛집')", async () => {
    const out = await naverRestaurantReviews({ query: "성수동 맛집", count: 5 });
    if (!out.includes("방문자 리뷰")) throw new Error("no visitor review section");
    if (!out.includes("m.place.naver.com")) throw new Error("no place link");
    const section = out.split("## 방문자 리뷰")[1] || "";
    if (/\[(?:PARSE_FAILED|BLOCKED|ERROR|TRANSPORT)\]/.test(section)) {
      throw new Error(`visitor reviews failed: ${section.slice(0, 160)}`);
    }
    // Numbered entries mean real reviews came back, not an empty shell.
    if (!/\n1\. \S/.test(section)) throw new Error("visitor section has no numbered reviews");
    return out;
  }, { minChars: 400 });

  console.log("=".repeat(72));
  console.log("TOOL TEST SUMMARY");
  console.log("=".repeat(72));
  for (const [label, status, detail] of summary) {
    console.log(`${status.padEnd(6)} ${label.slice(0, 46).padEnd(48)} ${detail}`);
  }
  console.log();

  if (failures) {
    console.log(`${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("All tool checks passed.");
};

run().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});

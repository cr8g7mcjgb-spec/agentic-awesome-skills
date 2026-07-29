# Naver Content MCP

An **authless remote MCP server** that reads Naver blog, news, cafe, and place
content by scraping Naver's public mobile pages from the Cloudflare edge. No
Naver Open API key is used.

It exists because Claude mobile / Cowork cannot reach `naver.com` directly —
those requests are refused by the egress proxy (`PROXY_REJECTED`). Running the
fetch at the edge sidesteps that, since the edge is not behind that proxy.

## Tools

| Tool | What it does |
| --- | --- |
| `naver_blog_search(query, count, sort)` | Scrapes the mobile blog search tab. Pages via `start`, up to 100 results. |
| `naver_blog_read(url)` | Full post body as markdown. Normalises `blog.naver.com` → `m.blog.naver.com` because the desktop page renders the body in an iframe. |
| `naver_news_search(query, count)` | Mobile news search tab. |
| `naver_news_read(url)` | Full article body from `n.news.naver.com`. |
| `naver_cafe_search(query, count)` | Public cafe posts only. Member-only boards are not attempted. |
| `naver_place_reviews(query)` | Blog reviews written about a place. |
| `naver_web_search(query, count)` | Web tab — government and public agencies, institutes, journals. |
| `naver_restaurant_reviews(query)` | Star-rated visitor reviews plus blog write-ups for one place. |
| `read_article(url)` | Body of any page — Naver, Tistory, government sites. Hands file URLs to `read_file`. |
| `read_file(url)` | PDF and HWPX as text; images as an MCP image block. |

## Fallback chain

`naver_blog_read` tries four routes in order and returns the first that yields a
body. All four stay in the chain, so a block on one degrades instead of breaking.

1. **`direct-mobile`** — `m.blog.naver.com/{blogId}/{logNo}`
2. **`pc-postview`** — `blog.naver.com/PostView.naver?blogId=…&logNo=…`
3. **`jina-reader`** — `r.jina.ai/https://m.blog.naver.com/…` (no key required)
4. **`rss`** — `rss.blog.naver.com/{blogId}.xml`

Body extraction prefers SmartEditor ONE (`se-main-container`) and falls back to
older layouts (`postViewArea`, `post-view`, `__content`, `se_component_wrap`).

## Error reporting

Failures are classified rather than collapsed into one message, because
"Naver refused us" and "we could not find the body" need different fixes:

- `BLOCKED` — HTTP 403/429, or a genuine block page
- `PARSE_FAILED` — page fetched fine, no known container matched
- `LOGIN_REQUIRED` — member-only cafe post; retrying will not help
- `CLIENT_RENDERED` — the site builds its body in the browser (Kakao Map, TMap)
- `NOT_FOUND` — post deleted or private
- `SCANNED_PDF` — a PDF with no text layer
- `UNSUPPORTED_FORMAT` / `TOO_LARGE` — file the reader will not attempt
- `TRANSPORT` / `UPSTREAM` — network or Naver-side error

Each one carries a hint telling the model whether a retry is worth anything.

Failed blog reads include the per-route trace so you can see what each fallback did.

## Request shaping

Requests carry a real mobile Chrome `User-Agent`, `Accept-Language: ko-KR`, a
matching `Referer`, and the `Sec-Fetch-*` / `Sec-Ch-Ua` headers a browser sends.
Naver rejects `python-urllib`-style clients. Search paging sleeps ~600 ms between
pages, and 403/429/5xx are retried with exponential backoff.

## Verification

Two workflows, both of which run on GitHub runners (which, unlike the Claude
Code sandbox, can reach Naver):

- **`naver-edge-probe.yml`** — the step-0 gate. Probes all four fallback routes
  plus every search surface and fails if no route returns a post body. A second
  job runs the shipped tool code against live Naver.
- **`naver-mcp-deploy.yml`** — deploys to Cloudflare Workers, then drives the
  deployed endpoint over JSON-RPC exactly like a Claude connector does
  (`initialize` → `tools/list` → `tools/call`) and asserts real body text comes back.

## File formats

Most Korean reference material — past exam papers, government reports, notices
— is distributed as PDF, HWP, or a scan, none of which the HTML reader can
touch. `read_file` handles them, and `read_article` hands a file URL over
automatically, so a link from search works whichever tool the model reaches for.

The format is decided by Content-Type, then by extension, then by magic bytes —
Korean download links routinely look like `?fileId=1234` with no extension and
`application/octet-stream` on the response.

| Format | Result | Verified by |
| --- | --- | --- |
| PDF with a text layer | Text | `unpdf` extracting a built-in fixture through the bundled Worker |
| HWPX | Text | `fflate` unzip + `<hp:t>` runs from `Contents/section*.xml` |
| Images (PNG/JPEG/…) | An MCP **image block**, not OCR output | Base64 round-trip asserted in `test_worker.mjs` |
| Scanned PDF | `SCANNED_PDF` | Text length compared against page count |
| Legacy `.hwp` | `UNSUPPORTED_FORMAT` + how to convert | OLE signature detection |

Images go to the model as images. OCR was ruled out rather than attempted —
Korean language data alone runs to tens of megabytes, past the Worker limit —
and a model that can see the page reads tables, diagrams and layout that OCR
would flatten into a line of characters.

Size caps: 12 MB per file, 4 MB per image, both refused up front with the
measured size rather than dying halfway through.

**Bundle cost.** `unpdf` + `fflate` take the Worker from 57 KB to:

```
dist/worker.js      raw 2,457,597   gzip 594,427
dist/worker.min.js  raw 1,664,983   gzip 519,837
                                    limit 3,145,728 (Workers gzip)
```

It fits with room to spare, but it is far past what the Cloudflare dashboard's
code editor can take — **format support means deploying from Git or with
wrangler, not by pasting.** `scripts/bundle.mjs` fails the build if a bundle
ever crosses the limit.

## Deploying

Set two repository secrets, then run the deploy workflow:

- `CLOUDFLARE_API_TOKEN` — created from the **Edit Cloudflare Workers** template
- `CLOUDFLARE_ACCOUNT_ID`

The workflow prints the connector URL (`https://<worker>.workers.dev/mcp`) in its
job summary.

Locally: `npm install && npx wrangler deploy`.

## Connecting from Claude

Settings → Connectors → Add custom connector → paste the `/mcp` URL. No auth.

## Scope

Reads publicly accessible pages only. It does not log in, does not touch
member-only cafe boards, and does not use Naver's Open API.

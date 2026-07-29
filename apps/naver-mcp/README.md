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
— is distributed as an attachment, not as HTML. `read_file` reads those, and
`read_article` hands a file URL over automatically, so a link from search works
whichever tool the model reaches for. A link with no extension is resolved by
Content-Type, then extension, then magic bytes, and if it turns out to be a web
page after all it goes back to the HTML reader instead of being refused.

**No library is used for any of it.** `pdf.js` is 1.5 MB, and a Worker that
large can no longer be pasted into the Cloudflare editor, which is this
project's only deploy route. Everything here uses what the runtime already has.

| Format | How | Result |
| --- | --- | --- |
| PDF | Parsed in `src/pdf.js`, including the font tables that make Korean readable | Text |
| HWPX | Central directory read by hand, inflated with the built-in `DecompressionStream` | Text |
| Image | Handed over as an MCP **image block** — no extraction at all | The model sees the page |
| Scanned PDF | Pages of images with no text operators | `SCANNED_PDF` |
| Legacy `.hwp` | Compound-binary, no small reader exists | `UNSUPPORTED_FORMAT` + how to convert |

### Why the PDF reader is not a regex

Pulling whatever sits inside `(...) Tj` reads English and returns noise for
Korean. Korean documents embed a subset font and store text as glyph ids:
`<0037 00A2>` means "the 55th and 162nd shape in this font", not any particular
characters. Measured against real Korean PDFs found through Naver, that naive
approach read 1 of 4 — and worse, the other 3 came back as a *successful* read
of zero Korean characters, because "no Hangul" also describes an English page.

The table that translates them ships inside the file: every such font carries a
`/ToUnicode` CMap so that copy-and-paste works in a viewer. Reading it turns the
same bytes into text with nothing to install and nobody to ask. Doing that needs
real parsing:

- objects are found by scanning, not by trusting a cross-reference table that
  goes stale the moment a file is edited
- objects packed into a compressed `/ObjStm` are expanded — PDF 1.5 puts most
  font dictionaries there, and without this a modern file appears to have no
  fonts at all
- each page's `/Resources /Font` is read, so `/F1` resolves to a font
- the content stream is walked with a scanner rather than matched with a
  pattern, because the same bytes mean different characters depending on which
  `Tf` came before them

Fonts with no table fall back to UTF-8, then EUC-KR, then Latin-1 — in that
order, because Latin-1 never fails, it just returns something unreadable.

`r.jina.ai` — the keyless reader already used as an HTML fallback — remains
behind all of that, for files whose fonts the document never explains.

### How a bad read is caught

A read is only accepted if bytes actually became characters. The signal is the
count of show operations that consumed bytes and produced nothing: a real
English page has none; a document whose fonts are never explained has almost
nothing else. Above a quarter, the file goes to the fallback instead of
returning silence dressed as success.

Size caps: 12 MB per file, 4 MB per image, and PDFs over 6 MB skip the local
route rather than being downloaded twice.

**Bundle cost** — the whole Worker, every format supported:

```
dist/worker.js      raw 85,565   gzip ~23,000
dist/worker.min.js  raw 58,205   gzip ~19,000
                                 limit 3,145,728
```

Small enough to keep deploying by pasting. `scripts/bundle.mjs` fails the build
if that stops being true.

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

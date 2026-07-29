/**
 * Drive the bundled Worker in-process, exactly as a Claude connector would.
 *
 * Node 22 provides Request/Response/fetch, so the Worker's default export can
 * be called directly. This covers the JSON-RPC layer - initialize, tools/list,
 * tools/call - which the tool-level tests never touch, and it proves the
 * pasteable bundle works rather than only the module sources.
 */

import { createServer } from "node:http";
import { makePdf, makeHwpx, makePng, makeHwp } from "./fixtures.mjs";

// Which build to drive. Both bundles are deployed from, so the minified one
// has to pass the same checks as the readable one.
const target = process.argv[2] || "../dist/worker.js";
const worker = (await import(target.startsWith(".") ? target : `../${target}`)).default;
console.log(`driving: ${target}\n`);

let failures = 0;
const rows = [];

function check(label, cond, detail = "") {
  if (!cond) failures++;
  rows.push([cond ? "PASS" : "FAIL", label, detail]);
  console.log(`${cond ? "[PASS]" : "[FAIL]"} ${label} ${detail}`);
}

/** Serve the fixture documents so the Worker can fetch them over real HTTP. */
async function serveFixtures() {
  const files = {
    "/paper.pdf": [makePdf(), "application/pdf"],
    "/download?fileId=99": [makePdf(), "application/octet-stream"],
    "/exam.hwpx": [makeHwpx(), "application/hwp+zip"],
    "/scan.png": [makePng(), "image/png"],
    "/scan.pdf": [makePdf(""), "application/pdf"],
    "/old.hwp": [makeHwp(), "application/x-hwp"],
  };
  const server = createServer((req, res) => {
    const hit = files[req.url];
    if (!hit) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { "Content-Type": hit[1], "Content-Length": hit[0].length });
    res.end(Buffer.from(hit[0]));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

const readFile = async (url) =>
  (await rpc("tools/call", { name: "read_file", arguments: { url } })).body?.result || {};

async function rpc(method, params, { accept = "application/json" } = {}) {
  const req = new Request("https://example.workers.dev/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: accept },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const resp = await worker.fetch(req);
  const text = await resp.text();
  if (accept.includes("event-stream")) return { resp, text };
  return { resp, body: text ? JSON.parse(text) : null };
}

const run = async () => {
  // --- protocol handshake -------------------------------------------------
  const init = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  });
  check("initialize returns serverInfo", !!init.body?.result?.serverInfo,
    JSON.stringify(init.body?.result?.serverInfo || {}));
  check("initialize echoes the requested protocol",
    init.body?.result?.protocolVersion === "2025-06-18",
    init.body?.result?.protocolVersion || "");

  // An unknown protocol must still get a supported one back, not an error.
  const oldInit = await rpc("initialize", { protocolVersion: "1999-01-01", capabilities: {} });
  check("initialize falls back for an unknown protocol",
    !!oldInit.body?.result?.protocolVersion,
    oldInit.body?.result?.protocolVersion || "");

  // --- tool discovery -----------------------------------------------------
  const list = await rpc("tools/list", {});
  const tools = list.body?.result?.tools || [];
  check("tools/list returns 10 tools", tools.length === 10, tools.map((t) => t.name).join(", "));
  check("every tool has a description and schema",
    tools.every((t) => t.description && t.inputSchema?.type === "object"));
  check("blog_read exposes max_chars",
    !!tools.find((t) => t.name === "naver_blog_read")?.inputSchema?.properties?.max_chars);

  // Every advertised tool must be reachable through tools/call. Calling the
  // functions directly (as the tool tests do) hides a missing HANDLERS entry:
  // the tool lists fine and only fails when someone actually invokes it.
  for (const t of tools) {
    const required = t.inputSchema?.required || [];
    // Deliberately invalid arguments - this checks routing, not behaviour.
    const args = Object.fromEntries(required.map((k) => [k, ""]));
    const res = await rpc("tools/call", { name: t.name, arguments: args });
    const text = res.body?.result?.content?.[0]?.text || "";
    check(`tools/call reaches ${t.name}`, !text.includes("Unknown tool"), text.slice(0, 50));
  }

  // --- notifications ------------------------------------------------------
  const note = await worker.fetch(new Request("https://example.workers.dev/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  }));
  check("notification gets 202 with no body", note.status === 202, `status ${note.status}`);

  // --- errors are reported as errors, not silent successes ----------------
  const bad = await rpc("tools/call", { name: "does_not_exist", arguments: {} });
  check("unknown tool is flagged isError", bad.body?.result?.isError === true,
    bad.body?.result?.content?.[0]?.text?.slice(0, 60) || "");

  const badUrl = await rpc("tools/call", {
    name: "naver_blog_read",
    arguments: { url: "https://example.com/not-a-naver-post" },
  });
  const badText = badUrl.body?.result?.content?.[0]?.text || "";
  check("bad URL returns a classified failure",
    badUrl.body?.result?.isError === true && badText.includes("BAD_INPUT"),
    badText.slice(0, 70));

  const unknown = await rpc("nonexistent/method", {});
  check("unknown method returns JSON-RPC -32601", unknown.body?.error?.code === -32601,
    unknown.body?.error?.message || "");

  // --- SSE framing --------------------------------------------------------
  const sse = await rpc("tools/list", {}, { accept: "text/event-stream" });
  check("SSE Accept yields an event-stream frame",
    (sse.resp.headers.get("Content-Type") || "").includes("text/event-stream") &&
      sse.text.startsWith("event: message"),
    sse.text.slice(0, 40).replace(/\n/g, "\\n"));

  // --- health and CORS ----------------------------------------------------
  const health = await worker.fetch(new Request("https://example.workers.dev/health"));
  check("GET /health is ok", health.status === 200 && (await health.clone().json()).ok === true);
  check("CORS is open for browser clients",
    health.headers.get("Access-Control-Allow-Origin") === "*");

  const preflight = await worker.fetch(
    new Request("https://example.workers.dev/mcp", { method: "OPTIONS" }));
  check("OPTIONS preflight returns 204", preflight.status === 204, `status ${preflight.status}`);

  // --- a real call, end to end -------------------------------------------
  const search = await rpc("tools/call", {
    name: "naver_blog_search",
    arguments: { query: "제주도 맛집", count: 3 },
  });
  const searchText = search.body?.result?.content?.[0]?.text || "";
  check("tools/call naver_blog_search returns posts",
    !search.body?.result?.isError && searchText.includes("blog.naver.com"),
    `${searchText.length} chars`);

  const m = searchText.match(/https:\/\/m\.blog\.naver\.com\/[A-Za-z0-9_-]+\/\d+/);
  if (m) {
    const read = await rpc("tools/call", {
      name: "naver_blog_read",
      arguments: { url: m[0], max_chars: 1200 },
    });
    const body = read.body?.result?.content?.[0]?.text || "";
    check("tools/call naver_blog_read returns a body",
      !read.body?.result?.isError && body.length > 300, `${body.length} chars from ${m[0]}`);
    console.log(`\n--- body (first 500 chars) ---\n${body.slice(0, 500)}\n`);
  } else {
    check("search produced a URL to read", false);
  }

  // --- file formats -------------------------------------------------------
  // Served locally rather than fetched from Naver: this checks the readers,
  // and a real attachment URL would make the test depend on someone else's
  // hosting. The Worker fetches them over HTTP exactly as it would a real one.
  const { server, base } = await serveFixtures();
  try {
    const pdf = await readFile(`${base}/paper.pdf`);
    check("read_file extracts PDF text",
      !pdf.isError && (pdf.content?.[0]?.text || "").includes("SUNEUNG KOREAN"),
      (pdf.content?.[0]?.text || "").split("\n").pop().slice(0, 40));

    // No extension and a useless Content-Type: the magic bytes have to decide.
    const sniffed = await readFile(`${base}/download?fileId=99`);
    check("read_file sniffs a PDF with no extension",
      !sniffed.isError && (sniffed.content?.[0]?.text || "").includes("SUNEUNG KOREAN"));

    const hwpx = await readFile(`${base}/exam.hwpx`);
    const hwpxText = hwpx.content?.[0]?.text || "";
    check("read_file extracts HWPX text",
      !hwpx.isError && hwpxText.includes("수능 국어 영역"), hwpxText.split("\n").pop().slice(0, 30));
    check("HWPX keeps paragraphs apart",
      !hwpxText.includes("영역다음"), hwpxText.replace(/\n/g, "|").slice(-40));

    const img = await readFile(`${base}/scan.png`);
    const block = img.content?.find((c) => c.type === "image");
    check("read_file returns an image block, not text",
      !!block && block.mimeType === "image/png" && block.data.startsWith("iVBORw0KGgo"),
      block ? `${block.data.length} b64 chars` : "no image block");

    const scanned = await readFile(`${base}/scan.pdf`);
    check("a PDF with no text layer is called SCANNED_PDF",
      scanned.isError && (scanned.content?.[0]?.text || "").includes("SCANNED_PDF"),
      (scanned.content?.[0]?.text || "").slice(0, 45));

    const legacy = await readFile(`${base}/old.hwp`);
    check("legacy .hwp is refused with conversion advice",
      legacy.isError && (legacy.content?.[0]?.text || "").includes("UNSUPPORTED_FORMAT"),
      (legacy.content?.[0]?.text || "").slice(0, 45));

    const missing = await readFile(`${base}/gone.pdf`);
    check("a missing file is NOT_FOUND, not a parse failure",
      missing.isError && (missing.content?.[0]?.text || "").includes("NOT_FOUND"),
      (missing.content?.[0]?.text || "").slice(0, 45));

    // read_article is the tool the model reaches for first, so a file URL
    // handed to it must not fall into the HTML reader and fail.
    const viaArticle = await rpc("tools/call", {
      name: "read_article",
      arguments: { url: `${base}/paper.pdf` },
    });
    check("read_article hands a PDF URL to the file reader",
      !viaArticle.body?.result?.isError &&
        (viaArticle.body?.result?.content?.[0]?.text || "").includes("SUNEUNG KOREAN"));
  } finally {
    server.close();
  }

  console.log("\n" + "=".repeat(72));
  console.log("WORKER TEST SUMMARY");
  console.log("=".repeat(72));
  for (const [status, label, detail] of rows) {
    console.log(`${status.padEnd(6)} ${label.slice(0, 46).padEnd(48)} ${String(detail).slice(0, 40)}`);
  }
  console.log(failures ? `\n${failures} check(s) failed.` : "\nAll worker checks passed.");
  process.exit(failures ? 1 : 0);
};

run().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});

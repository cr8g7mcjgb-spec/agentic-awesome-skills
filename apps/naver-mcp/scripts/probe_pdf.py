#!/usr/bin/env python3
"""
Can a PDF be read without shipping pdf.js?

pdf.js costs 1.5 MB, which pushes the Worker past what anyone can paste into
the Cloudflare editor. Two cheaper routes exist, and this measures both against
real Korean PDFs discovered through Naver rather than against a fixture:

  A. r.jina.ai  - the keyless reader already used as a fallback for HTML.
                  Does it extract PDF text too, and how often does it 429?
  B. raw streams - most PDFs store text in Flate-compressed content streams.
                  Workers can inflate those with the built-in
                  DecompressionStream, so the only question is whether the
                  text survives as characters or as unmapped CID codes.

Prints a table. No conclusion is drawn here that the numbers do not support.
"""

import gzip
import json
import re
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zlib

UA = (
    "Mozilla/5.0 (Linux; Android 14; SM-S928N) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/126.0.6478.122 Mobile Safari/537.36"
)
HANGUL = re.compile(r"[가-힣]")
CTX = ssl.create_default_context()


def get(url, timeout=45, referer=None, limit=8_000_000):
    headers = {
        "User-Agent": UA,
        "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
        "Accept": "*/*",
        "Accept-Encoding": "gzip, deflate",
    }
    if referer:
        headers["Referer"] = referer
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout, context=CTX) as resp:
        raw = resp.read(limit)
        if resp.headers.get("Content-Encoding") == "gzip":
            raw = gzip.decompress(raw)
        return resp.status, raw, resp.headers.get("Content-Type", "")


def discover_pdfs(query, want=6):
    """Find real PDF links the way the MCP server would - through Naver."""
    found = []
    for start in (1, 16, 31):
        url = (
            "https://m.search.naver.com/search.naver?ssc=tab.m_web.all&where=m_web"
            f"&query={urllib.parse.quote(query)}&start={start}"
        )
        try:
            _, body, _ = get(url, referer="https://m.search.naver.com/")
        except Exception as e:
            print(f"  search failed: {e}")
            continue
        html = body.decode("utf-8", "replace")
        for m in re.finditer(r'href="(https?://[^"]+\.pdf)(?:[?"])', html, re.I):
            link = m.group(1)
            if link not in found:
                found.append(link)
        if len(found) >= want:
            break
        time.sleep(0.6)
    return found[:want]


def try_direct(url):
    """Fetch the file itself - is it really a PDF, and how big?"""
    try:
        status, raw, ctype = get(url)
    except urllib.error.HTTPError as e:
        return {"ok": False, "why": f"HTTP {e.code}"}
    except Exception as e:
        return {"ok": False, "why": type(e).__name__}
    if not raw.startswith(b"%PDF"):
        return {"ok": False, "why": f"not a PDF ({ctype or 'no type'})"}
    return {"ok": True, "bytes": len(raw), "raw": raw}


def try_raw_streams(raw):
    """
    Route B: inflate every Flate stream and see what the text operators hold.
    Counts characters that survived as real Hangul versus glyph codes that
    would need a ToUnicode CMap to become readable.
    """
    hangul = 0
    ops = 0
    tounicode = 0
    for m in re.finditer(rb"stream\r?\n", raw):
        start = m.end()
        end = raw.find(b"endstream", start)
        if end < 0:
            continue
        try:
            data = zlib.decompress(raw[start:end])
        except Exception:
            continue
        if b"beginbfchar" in data or b"beginbfrange" in data:
            tounicode += 1
        text = data.decode("utf-8", "replace")
        ops += len(re.findall(r"\)\s*Tj|\]\s*TJ", text))
        hangul += len(HANGUL.findall(text))
    return {"text_ops": ops, "hangul": hangul, "tounicode_maps": tounicode}


def try_jina(url, attempts=1):
    """Route A: the keyless reader. Reports 429s honestly rather than hiding them."""
    last = {}
    for i in range(attempts):
        try:
            status, raw, _ = get("https://r.jina.ai/" + url, timeout=90)
            text = raw.decode("utf-8", "replace")
            last = {
                "ok": True,
                "chars": len(text),
                "hangul": len(HANGUL.findall(text)),
                "head": " ".join(text.split())[:90],
            }
            return last
        except urllib.error.HTTPError as e:
            last = {"ok": False, "why": f"HTTP {e.code}"}
            if e.code == 429 and i + 1 < attempts:
                time.sleep(8)
                continue
            return last
        except Exception as e:
            return {"ok": False, "why": type(e).__name__}
    return last


def main():
    queries = [
        "수능 국어 영역 기출 문제지 pdf",
        "한국소비자원 보고서 pdf",
    ]
    urls = []
    for q in queries:
        print(f"discovering PDFs for: {q}")
        hits = discover_pdfs(q, want=4)
        for h in hits:
            print(f"  found {h[:100]}")
        urls.extend(hits)

    if not urls:
        print("\nNo PDF links discovered through Naver search.")
        print("That is a finding, not a pass - the routes below were not measured.")
        return 1

    rows = []
    for url in urls[:6]:
        print(f"\n--- {url[:110]}")
        direct = try_direct(url)
        if not direct["ok"]:
            print(f"  direct fetch: {direct['why']}")
            rows.append({"url": url, "direct": direct["why"]})
            continue
        print(f"  direct fetch: ok, {direct['bytes']:,} bytes")

        streams = try_raw_streams(direct["raw"])
        print(
            f"  raw streams : {streams['text_ops']} text ops, "
            f"{streams['hangul']} hangul chars, {streams['tounicode_maps']} ToUnicode maps"
        )

        jina = try_jina(url, attempts=2)
        if jina.get("ok"):
            print(f"  r.jina.ai   : {jina['chars']:,} chars, {jina['hangul']} hangul")
            print(f"                {jina['head']}")
        else:
            print(f"  r.jina.ai   : {jina['why']}")

        rows.append(
            {
                "url": url,
                "bytes": direct["bytes"],
                "streams": streams,
                "jina": {k: v for k, v in jina.items() if k != "head"},
            }
        )
        time.sleep(3)

    print("\n" + "=" * 78)
    print("SUMMARY")
    print("=" * 78)
    jina_ok = sum(1 for r in rows if r.get("jina", {}).get("ok") and r["jina"]["hangul"] > 50)
    streams_ok = sum(1 for r in rows if r.get("streams", {}).get("hangul", 0) > 50)
    measured = sum(1 for r in rows if "streams" in r)
    print(f"PDFs actually fetched      : {measured}/{len(rows)}")
    print(f"r.jina.ai gave Korean text : {jina_ok}/{measured}")
    print(f"raw streams gave Korean    : {streams_ok}/{measured}")

    with open("pdf-probe.json", "w") as fh:
        json.dump(rows, fh, ensure_ascii=False, indent=2)

    # The gate: at least one keyless route has to work on a real PDF.
    return 0 if (jina_ok or streams_ok) else 1


if __name__ == "__main__":
    sys.exit(main())

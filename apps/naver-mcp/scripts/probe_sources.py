#!/usr/bin/env python3
"""
Probe the wider Naver surfaces before building tools on them.

Naver has retired several verticals over the years, so which of these actually
answer has to be measured rather than assumed.
"""

import re
import sys
import urllib.parse

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from naver_probe import fetch, classify  # noqa: E402

Q = urllib.parse.quote("전기차 배터리 수명")
CONSUMER = urllib.parse.quote("한국소비자원 피해구제")

TARGETS = [
    ("web tab (통합/웹)",
     f"https://m.search.naver.com/search.naver?ssc=tab.m_web.all&query={Q}",
     r"https?://[a-z0-9.-]+\.[a-z]{2,}/[^\"'\s]*"),
    ("academic (전문정보)",
     f"https://academic.naver.com/search.naver?query={Q}",
     r"academic\.naver\.com/article"),
    ("academic tab in search",
     f"https://m.search.naver.com/search.naver?ssc=tab.m_academic.all&query={Q}",
     r"(?:academic|kiss|dbpia|riss)"),
    ("지식백과 (terms)",
     f"https://m.terms.naver.com/search.naver?query={Q}",
     r"terms\.naver\.com/entry"),
    ("지식iN",
     f"https://m.search.naver.com/search.naver?ssc=tab.m_kin.all&query={Q}",
     r"kin\.naver\.com/(?:qna|mobile)"),
    ("news tab for 소비자원",
     f"https://m.search.naver.com/search.naver?ssc=tab.m_news.all&query={CONSUMER}",
     r"n\.news\.naver\.com/(?:mnews/)?article"),
    ("kca.go.kr direct",
     "https://www.kca.go.kr/home/main.do",
     r"소비자|kca"),
]

def discover(query, pattern):
    """Find a live URL through Naver's web tab instead of hardcoding one."""
    _, text, _ = fetch(
        f"https://m.search.naver.com/search.naver?ssc=tab.m_web.all&query={urllib.parse.quote(query)}",
        referer="https://m.search.naver.com/",
    )
    m = re.search(pattern, text or "")
    return m.group(0) if m else None


# Map review sites render their content with JavaScript, so a plain fetch may
# only see the shell. Probe both the page and the reader proxy to find out.
print("=" * 78)
print("MAP REVIEW SITES")
print("=" * 78)

kakao = discover("맛집 후기 place.map.kakao.com", r"https?://place\.map\.kakao\.com/\d+")
tmap = discover("맛집 tmap 리뷰", r"https?://[a-z.]*tmap\.co\.kr/[^\"'\s]{4,60}")
print(f"discovered kakao: {kakao}")
print(f"discovered tmap : {tmap}\n")

for label, url in [
    ("kakao place (direct)", kakao),
    ("kakao place (jina)", f"https://r.jina.ai/{kakao}" if kakao else None),
    ("kakao place API (main/v)",
     re.sub(r"place\.map\.kakao\.com/(\d+)", r"place.map.kakao.com/main/v/\1", kakao) if kakao else None),
    ("tmap (direct)", tmap),
    ("tmap (jina)", f"https://r.jina.ai/{tmap}" if tmap else None),
]:
    if not url:
        print(f"[SKIP] {label} - no URL discovered\n")
        continue
    status, text, err = fetch(url, timeout=40)
    # A review page is only useful if Korean review-ish text actually arrived.
    hangul = len(re.findall(r"[가-힣]", text or ""))
    reviewish = len(re.findall(r"리뷰|후기|평점|별점", text or ""))
    verdict = "OK" if status == 200 and hangul > 400 and reviewish > 0 else "NO CONTENT"
    print(f"[{verdict}] {label}")
    print(f"       url     : {url[:110]}")
    print(f"       status  : {status} err={err}")
    print(f"       bytes   : {len(text or '')}, hangul={hangul}, review-words={reviewish}")
    if text and hangul > 100:
        snippet = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", text))[:200]
        print(f"       sample  : {snippet}")
    print()

# Visitor reviews - the star-rated ones - are the piece a restaurant tool
# needs and the piece most likely to be client-rendered.
print("=" * 78)
print("PLACE VISITOR REVIEWS")
print("=" * 78)

place = discover("성수동 맛집", r"(?:place|pcmap\.place)\.naver\.com/restaurant/(\d+)")
pid = re.search(r"(\d+)", place).group(1) if place else None
print(f"discovered place id: {pid}\n")

if pid:
    candidates = [
        ("m.place visitor", f"https://m.place.naver.com/restaurant/{pid}/review/visitor"),
        ("m.place visitor (jina)", f"https://r.jina.ai/https://m.place.naver.com/restaurant/{pid}/review/visitor"),
        ("pcmap visitor", f"https://pcmap.place.naver.com/restaurant/{pid}/review/visitor"),
        ("m.place home (jina)", f"https://r.jina.ai/https://m.place.naver.com/restaurant/{pid}/home"),
    ]
    for label, url in candidates:
        status, text, err = fetch(url, timeout=45)
        hangul = len(re.findall(r"[가-힣]", text or ""))
        # Star ratings and review verbs are what separate a real review list
        # from the page shell.
        signals = len(re.findall(r"별점|평점|방문자 리뷰|재방문|맛있|친절|웨이팅", text or ""))
        verdict = "OK" if status == 200 and hangul > 500 and signals >= 3 else "NO CONTENT"
        print(f"[{verdict}] {label}")
        print(f"       url    : {url[:110]}")
        print(f"       status : {status} err={err}")
        print(f"       bytes  : {len(text or '')}, hangul={hangul}, review-signals={signals}")
        if text and hangul > 200:
            snip = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", text))
            print(f"       sample : {snip[:220]}")
        print()
else:
    print("[SKIP] no place id discovered\n")

rows = []
for label, url, pattern in TARGETS:
    status, text, err = fetch(url, referer="https://m.search.naver.com/")
    hits = len(set(re.findall(pattern, text, re.I))) if text else 0
    kind, detail = classify(status, text, err, extracted=hits)
    rows.append((label, kind, hits, detail))
    print(f"[{'PASS' if kind == 'OK' else 'FAIL'}] {label}")
    print(f"       url    : {url}")
    print(f"       result : {kind} ({detail})")
    print(f"       matches: {hits}")
    if text and hits:
        sample = set(re.findall(pattern, text, re.I))
        print(f"       sample : {list(sample)[:3]}")
    print()

print("=" * 72)
print(f"{'target':<28}{'result':<16}{'matches'}")
print("-" * 72)
for label, kind, hits, _ in rows:
    print(f"{label:<28}{kind:<16}{hits}")

# Informational: this probe maps what exists, it does not gate anything.
print("\n(informational probe - does not fail the build)")

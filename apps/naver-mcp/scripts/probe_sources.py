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

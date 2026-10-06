#!/usr/bin/env python3
"""Scrape the Sui Basecamp agenda into data.js.

Usage: python3 scrape.py [saved.html]
"""
import json
import re
import sys
import subprocess
from collections import Counter
from datetime import datetime, timedelta, timezone
from html.parser import HTMLParser
from pathlib import Path

URL = "https://www.sui.io/basecamp"
HERE = Path(__file__).parent
DATES = {1: "2026-10-07", 2: "2026-10-08"}
VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"}

# Fallback keyword tagging; annotations.json overrides it per session.
TOPICS = {
    "ai": ("AI & Agents", r"\bai\b|agent|llm|machine|intelligence"),
    "defi": ("DeFi & Trading", r"defi|trad(e|ing)|lend|yield|swap|stake|liquidity|capital|predict"),
    "pay": ("Payments & Stablecoins", r"payment|stablecoin|usdc|commerce|\bpay\b"),
    "build": ("Hands-on Building", r"workshop|build|vibe ?cod|hackathon|craft|spin up"),
    "infra": ("Sui Tech & Infra", r"walrus|tps|infrastructure|vault|object|protocol"),
    "real": ("Real-world Adoption", r"real[- ]world|rwa|onchain"),
    "macro": ("Markets & Macro", r"market|macro|invest|wealth|institution"),
    "vision": ("Big Keynotes", r"keynote|future|what.s next|welcome|closing|one more thing"),
    "fun": ("Games & Entertainment", r"gam(e|ing)|play|showdown|hot seat|music|race"),
    "community": ("Careers & Community", r"hire|career|campus|student|community|hackathon|ecosystem"),
}


class Node:
    def __init__(self, tag, attrs, parent):
        self.tag, self.attrs, self.parent = tag, dict(attrs), parent
        self.children = []

    @property
    def classes(self):
        return (self.attrs.get("class") or "").split()

    def text(self):
        return "".join(c if isinstance(c, str) else c.text() for c in self.children)

    def iter(self):
        for c in self.children:
            if isinstance(c, Node):
                yield c
                yield from c.iter()

    def find_all(self, pred):
        return [n for n in self.iter() if pred(n)]

    def find(self, pred):
        return next((n for n in self.iter() if pred(n)), None)


class TreeBuilder(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = Node("root", {}, None)
        self.cur = self.root

    def handle_starttag(self, tag, attrs):
        node = Node(tag, attrs, self.cur)
        self.cur.children.append(node)
        if tag not in VOID:
            self.cur = node

    def handle_startendtag(self, tag, attrs):
        self.cur.children.append(Node(tag, attrs, self.cur))

    def handle_endtag(self, tag):
        n = self.cur
        while n is not self.root and n.tag != tag:
            n = n.parent
        if n is not self.root:
            self.cur = n.parent

    def handle_data(self, data):
        self.cur.children.append(data)


def clean(s):
    return re.sub(r"\s+", " ", s).strip()


def parse_time(s, date):
    return datetime.strptime(f"{date} {s.strip().upper()}", "%Y-%m-%d %I:%M %p")


def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")[:60]


def parse_speakers(raw):
    """'A - Org, B - Org | Moderated by C - Org' -> (speakers, moderator).

    The moderator sometimes sits inside the last speaker's org, e.g. 'Kevin Boon - Mysten Labs | Moderated by ...'.
    """
    main, _, mod = clean(raw).partition("|")
    mod = re.sub(r"^\s*Moderated by\s*", "", mod).strip()
    out = []
    for part in re.split(r",\s*|\s&\s", main):
        part = clean(part).lstrip("& ").strip()
        if part:
            name, _, org = part.partition(" - ")
            out.append({"name": name.strip(), "org": org.strip()})
    return out, mod or None


def topics_for(s):
    hay = " ".join([s["title"], s["format"] or ""]).lower()
    return [k for k, (_, rx) in TOPICS.items() if re.search(rx, hay)]


def main():
    if len(sys.argv) > 1:
        html = Path(sys.argv[1]).read_text()
    else:
        # curl, because python.org macOS builds ship without CA certs
        html = subprocess.run(["curl", "-sfL", "-A", "Mozilla/5.0", URL], capture_output=True, text=True, check=True).stdout

    tb = TreeBuilder()
    tb.feed(html)
    root = tb.root

    notes_path = HERE / "annotations.json"
    notes = json.loads(notes_path.read_text()) if notes_path.exists() else {}

    days = root.find_all(lambda n: "agenda_tabs" in n.classes)
    labels = [clean(n.text()) for n in root.find_all(lambda n: "agenda-tabs-selector_each" in n.classes)]
    sessions = []
    for day_no, day in enumerate(days, 1):
        date = DATES[day_no]
        for item in day.find_all(lambda n: n.attrs.get("fs-list-element") == "item"):
            time_raw = clean(item.find(lambda n: "agenda-tabs-schedule_time" in n.classes).text())
            start_s, _, end_s = time_raw.partition(" - ")
            start = parse_time(start_s, date)
            end = parse_time(end_s, date) if end_s else start + timedelta(minutes=30)

            content = item.find(lambda n: n.attrs.get("id", "").startswith("w-node") and "gap-20" in n.classes)
            title = clean(content.find(lambda n: "ts-21px" in n.classes).text())
            spk = content.find(lambda n: "color-black-50" in n.classes)
            stage_el = item.find(lambda n: n.attrs.get("fs-list-field") == "stage")
            fmt_el = item.find(lambda n: n.attrs.get("fs-list-field") == "format")
            if stage_el is None:
                wrap = item.find(lambda n: "agenda-tabs_stage-wrapper" in n.classes)
                stage, venue_wide = clean(wrap.text()) if wrap else "", True
            else:
                stage, venue_wide = clean(stage_el.text()), False

            speakers, moderator = parse_speakers(spk.text()) if spk else ([], None)
            s = {
                "id": f"d{day_no}-{start:%H%M}-{slug(title)}",
                "day": day_no,
                "date": date,
                "start": start.strftime("%Y-%m-%dT%H:%M:00+08:00"),
                "end": end.strftime("%Y-%m-%dT%H:%M:00+08:00"),
                "title": title,
                "speakers": speakers,
                "moderator": moderator,
                "stage": stage,
                "format": clean(fmt_el.text()) if fmt_el else None,
                "venueWide": venue_wide,
            }
            note = notes.get(s["id"], {})
            s["topics"] = note.get("topics") or topics_for(s)
            s["summary"] = note.get("summary", "")
            s["always"] = venue_wide or note.get("always", False)
            sessions.append(s)

    data = {
        "event": "Sui Basecamp 2026 - Singapore",
        "source": URL,
        "scrapedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "days": [{"day": i + 1, "date": DATES[i + 1], "label": labels[i] if i < len(labels) else f"Day {i + 1}"} for i in range(len(days))],
        "topics": [{"key": k, "label": label} for k, (label, _) in TOPICS.items()],
        "sessions": sessions,
    }
    (HERE / "data.js").write_text("window.AGENDA = " + json.dumps(data, indent=1, ensure_ascii=False) + ";\n")

    print(f"{len(sessions)} sessions")
    for key in ("day", "stage", "format"):
        print(f"  {key}: {dict(Counter(s[key] for s in sessions))}")
    print(f"  topics: {dict(Counter(t for s in sessions for t in s['topics']))}")
    missing = [s["id"] for s in sessions if s["id"] not in notes]
    if missing:
        print(f"  {len(missing)} sessions not in annotations.json (new or renamed?):")
        for i in missing:
            print(f"    {i}")
    stale = set(notes) - {s["id"] for s in sessions}
    if stale:
        print(f"  {len(stale)} annotations match no session: {sorted(stale)}")


if __name__ == "__main__":
    main()

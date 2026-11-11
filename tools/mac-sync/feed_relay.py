#!/usr/bin/python3
"""Offline Reader — fetches substack.com newsletter feeds for the Feed tab.

Substack refuses GitHub's servers, so this Mac fetches those feeds over your own connection
and uploads them to feedcache/<id>.xml in the library repo, which starts the processing Action.
A feed is uploaded only when it has a post the last upload didn't. Every few hours it also
writes feedcache/mac.json, so the app's Newsletters page can show when your Mac last checked.

Run by launchd every 30 minutes. Standard library only — runs on the Python that ships with macOS.
"""
import base64
import fcntl
import json
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

HOME = Path.home()
BASE = HOME / ".offline-reader"
CONFIG = json.loads((BASE / "config.json").read_text())
OWNER = CONFIG["owner"]
API = f"https://api.github.com/repos/{OWNER}/offline-reader-library/contents/"
STATE = BASE / "feed_relay_state.json"
LOG = HOME / "Library" / "Logs" / "OfflineReader-feeds.log"
HEARTBEAT_EVERY = 6 * 3600
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 "
      "(KHTML, like Gecko) Version/18.0 Safari/605.1.15")


def log(msg):
    LOG.parent.mkdir(parents=True, exist_ok=True)
    if LOG.exists() and LOG.stat().st_size > 500_000:
        LOG.replace(LOG.with_suffix(".old.log"))
    with LOG.open("a") as f:
        f.write(f"{datetime.now():%Y-%m-%d %H:%M:%S} {msg}\n")


def token():
    f = BASE / "token"
    if f.exists():
        return f.read_text().strip()
    return subprocess.run(["gh", "auth", "token"], capture_output=True, text=True, check=True).stdout.strip()


def github(method, path, body=None):
    req = urllib.request.Request(API + path, method=method, data=json.dumps(body).encode() if body else None, headers={
        "Authorization": f"Bearer {token()}", "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "offline-reader-feed-relay",
    })
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        if e.code == 404 and method == "GET":
            return None
        raise RuntimeError(f"GitHub {method} {path}: HTTP {e.code} {e.read()[:200]!r}")


def put(path, data, message):
    cur = github("GET", f"{path}?ref=main")
    body = {"message": message, "content": base64.b64encode(data).decode(), "branch": "main"}
    if cur and cur.get("sha"):
        body["sha"] = cur["sha"]
    github("PUT", path, body)


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/rss+xml, application/xml, text/xml, */*"})
    with urllib.request.urlopen(req, timeout=45) as r:
        return r.read()


def is_substack(url):
    return re.search(r"(^|\.)substack\.com$", re.sub(r"^https?://([^/]+).*$", r"\1", url).lower()) is not None


def guids(xml):
    text = xml.decode("utf-8", "replace")
    return sorted(set(re.findall(r"<guid[^>]*>\s*(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?\s*</guid>", text, re.S)))


def main():
    lock = open(BASE / "feed_relay.lock", "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        return
    state = json.loads(STATE.read_text()) if STATE.exists() else {}
    state.setdefault("feeds", {})

    meta = github("GET", "feeds.json?ref=main")
    feeds = json.loads(base64.b64decode(meta["content"])).get("feeds", []) if meta else []
    mine = [f for f in feeds if f.get("url") and f.get("id") and is_substack(f["url"])]
    report = {}
    for f in mine:
        fid = f["id"]
        url = re.match(r"https?://[^/]+", f["url"]).group(0) + "/feed"
        try:
            xml = fetch(url)
            if b"<rss" not in xml[:2000] and b"<feed" not in xml[:2000]:
                raise RuntimeError("the response wasn't a feed")
            ids = guids(xml)
            if ids != state["feeds"].get(fid):
                put(f"feedcache/{fid}.xml", xml, f"Newsletter feed {fid}")
                state["feeds"][fid] = ids
                log(f"{fid}: uploaded ({len(ids)} posts)")
            report[fid] = {"ok": True}
        except Exception as e:  # keep going with the others
            log(f"{fid}: {e}")
            report[fid] = {"ok": False, "error": str(e)[:200]}

    # Forget newsletters no longer followed.
    for fid in list(state["feeds"]):
        if fid not in {f["id"] for f in mine}:
            del state["feeds"][fid]

    now = time.time()
    changed = report != state.get("report")
    if mine and (changed or now - state.get("heartbeat", 0) > HEARTBEAT_EVERY):
        beat = {"lastRun": datetime.now(timezone.utc).isoformat(timespec="seconds"), "feeds": report}
        put("feedcache/mac.json", (json.dumps(beat, indent=1) + "\n").encode(), "Mac newsletter check")
        state["heartbeat"] = now
        state["report"] = report
    STATE.write_text(json.dumps(state))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"error: {e}")
        sys.exit(1)

#!/usr/bin/python3
"""Offline Reader — keeps the Obsidian vault on iCloud Drive in step with GitHub.

Run by launchd every few minutes. Each run:
  1. makes sure every vault file is downloaded from iCloud (never mistakes an evicted
     file for a deleted one),
  2. commits any edits you made in Obsidian,
  3. pulls new clips from GitHub,
  4. pushes everything back.

If you and the app changed the same theme file, your Obsidian version wins and any
new clips from the app (recognised by their %% clip:… %% marker) are re-appended.

Git's own data lives in ~/.offline-reader/vault.git, outside iCloud.
Standard library only — runs on the Python that ships with macOS.
"""
import fcntl
import json
import os
import re
import socket
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

HOME = Path.home()
BASE = HOME / ".offline-reader"
CONFIG = json.loads((BASE / "config.json").read_text())
VAULT = Path(CONFIG["vault"]).expanduser()
GIT_DIR = BASE / "vault.git"
REMOTE = f"https://github.com/{CONFIG['owner']}/offline-reader-vault.git"
LOG = HOME / "Library" / "Logs" / "OfflineReader-sync.log"
STATE = BASE / "state.json"
CLIP_RE = re.compile(r"^%%\s*clip:([\w-]+)\s*%%\s*$", re.M)


def log(msg):
    LOG.parent.mkdir(parents=True, exist_ok=True)
    if LOG.exists() and LOG.stat().st_size > 1_000_000:
        LOG.replace(LOG.with_suffix(".old.log"))
    with LOG.open("a") as f:
        f.write(f"{datetime.now():%Y-%m-%d %H:%M:%S} {msg}\n")


def notify(msg):
    """macOS notification, at most once every 6 hours for the same problem."""
    state = json.loads(STATE.read_text()) if STATE.exists() else {}
    if state.get("last_error") == msg and time.time() - state.get("notified", 0) < 6 * 3600:
        return
    state.update(last_error=msg, notified=time.time())
    STATE.write_text(json.dumps(state))
    subprocess.run(["osascript", "-e",
                    f'display notification {json.dumps(msg)} with title "Offline Reader" subtitle "Obsidian sync problem"'],
                   capture_output=True)


def clear_error():
    if STATE.exists():
        STATE.write_text("{}")


def git(*args, check=True):
    cmd = ["git", f"--git-dir={GIT_DIR}", f"--work-tree={VAULT}", "-c", "core.quotepath=off", *args]
    env = dict(os.environ, GIT_TERMINAL_PROMPT="0")
    r = subprocess.run(cmd, capture_output=True, text=True, env=env)
    if check and r.returncode != 0:
        raise RuntimeError(f"git {' '.join(args[:2])} failed: {(r.stderr or r.stdout).strip()[:400]}")
    return r


def credential_args():
    """Use a token file if present, otherwise the GitHub CLI's stored login."""
    token_file = BASE / "token"
    if token_file.exists():
        import base64
        token = token_file.read_text().strip()
        auth = base64.b64encode(f"x-access-token:{token}".encode()).decode()
        return ["-c", "credential.helper=", "-c", f"http.https://github.com/.extraheader=AUTHORIZATION: basic {auth}"]
    return ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"]


def remote(*args, check=True):
    return git(*credential_args(), *args, check=check)


# ---------- iCloud ----------

def ensure_downloaded():
    """Asks iCloud to download every file in the vault; returns False if some are still missing."""
    subprocess.run(["brctl", "download", str(VAULT)], capture_output=True)
    for _ in range(15):
        placeholders = [p for p in VAULT.rglob(".*.icloud") if ".obsidian" not in p.parts]
        if not placeholders:
            return True
        for p in placeholders:
            subprocess.run(["brctl", "download", str(p)], capture_output=True)
        time.sleep(2)
    return False


# ---------- merging ----------

def clip_blocks(text):
    """Returns {clip_id: block_text} — a block runs from the end of the previous clip to its marker."""
    blocks, start = {}, 0
    for m in CLIP_RE.finditer(text or ""):
        blocks[m.group(1)] = text[start:m.end()].strip("\n")
        start = m.end()
    return blocks


def append_entry(text, entry):
    if not (text or "").strip():
        return entry.rstrip() + "\n"
    return text.rstrip() + "\n\n" + entry.rstrip() + "\n"


def show(rev, path):
    r = git("show", f"{rev}:{path}", check=False)
    return r.stdout if r.returncode == 0 else ""


def resolve_conflicts():
    """Keep the local (Obsidian) file, plus clips added on GitHub since the common base."""
    files = git("diff", "--name-only", "--diff-filter=U").stdout.splitlines()
    base = git("merge-base", "HEAD", "MERGE_HEAD").stdout.strip()
    for path in files:
        ours, theirs, original = show("HEAD", path), show("MERGE_HEAD", path), show(base, path)
        have = set(clip_blocks(ours))
        before = set(clip_blocks(original))
        merged = ours
        added = 0
        for cid, block in clip_blocks(theirs).items():
            if cid not in have and cid not in before:
                merged = append_entry(merged, block)
                added += 1
        (VAULT / path).write_text(merged, encoding="utf-8")
        git("add", "--", path)
        log(f"merged {path}: kept your edits, re-appended {added} new clip(s)")
    git("commit", "-q", "--no-edit", "-m", "Merge clips from Offline Reader")


# ---------- main ----------

def first_run():
    GIT_DIR.mkdir(parents=True, exist_ok=True)
    git("init", "-q", "-b", "main")
    git("remote", "add", "origin", REMOTE)
    git("config", "user.name", f"Obsidian ({socket.gethostname().split('.')[0]})")
    git("config", "user.email", "obsidian@offline-reader.local")
    remote("fetch", "-q", "origin")
    has_files = any(p for p in VAULT.glob("*") if not p.name.startswith("."))
    if has_files:
        # Vault already synced here by iCloud (e.g. a second Mac): adopt GitHub's history
        # without touching the files; the normal cycle then commits any differences.
        git("reset", "-q", "origin/main")
    else:
        git("checkout", "-q", "-f", "-B", "main", "origin/main")
    git("branch", "-q", "--set-upstream-to=origin/main", "main")
    log("set up")


def cycle():
    if not (GIT_DIR / "HEAD").exists():
        first_run()

    if not ensure_downloaded():
        log("some vault files are still downloading from iCloud; will try again next run")
        return

    # Leftover state from an interrupted run.
    if (GIT_DIR / "MERGE_HEAD").exists():
        git("merge", "--abort", check=False)
    if (GIT_DIR / "rebase-merge").exists() or (GIT_DIR / "rebase-apply").exists():
        git("rebase", "--abort", check=False)

    git("add", "-A")
    if git("diff", "--cached", "--quiet", check=False).returncode != 0:
        git("commit", "-q", "-m", "Edits from Obsidian")
        log("committed Obsidian edits")

    for attempt in range(3):
        remote("fetch", "-q", "origin")
        behind = int(git("rev-list", "--count", "HEAD..origin/main").stdout.strip() or 0)
        ahead = int(git("rev-list", "--count", "origin/main..HEAD").stdout.strip() or 0)
        if behind:
            r = git("merge", "-q", "--no-edit", "origin/main", check=False)
            if r.returncode != 0:
                if git("diff", "--name-only", "--diff-filter=U").stdout.strip():
                    resolve_conflicts()
                else:
                    raise RuntimeError(f"merge failed: {(r.stderr or r.stdout).strip()[:300]}")
            log(f"pulled {behind} change(s) from GitHub")
            ahead = int(git("rev-list", "--count", "origin/main..HEAD").stdout.strip() or 0)
        if not ahead:
            return
        if remote("push", "-q", "origin", "main", check=False).returncode == 0:
            log(f"pushed {ahead} commit(s)")
            return
        time.sleep(2)  # someone pushed in between; fetch and try again
    raise RuntimeError("couldn't push after 3 attempts")


def main():
    BASE.mkdir(exist_ok=True)
    VAULT.mkdir(parents=True, exist_ok=True)
    with open(BASE / "lock", "w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return 0  # previous run still going
        try:
            cycle()
            clear_error()
        except Exception as e:
            msg = str(e)
            log(f"error: {msg}")
            offline = any(s in msg for s in ("Could not resolve host", "unable to access", "Failed to connect", "timed out"))
            if not offline:
                notify(msg[:180])
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

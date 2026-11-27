#!/usr/bin/env python3
"""Watchtower agent-session scanner: runs ON a host that has Claude Code transcripts.

Reads ~/.claude/projects/**/*.jsonl incrementally (byte offsets kept in a state file on this host) and prints one
JSON object of per-day totals to stdout. Only timings, counts and token totals leave the host: never prompt text,
tool output or file contents. Daily totals are kept in the state file, so history survives Claude Code deleting old
transcripts (cleanupPeriodDays).

    python3 agents_scan.py --tz America/Detroit                 # on this host
    ssh agent2 python3 - --tz America/Detroit < agents_scan.py  # on another host (the collector does this)

Per session file it tracks:
  prompts      messages you typed (not tool results, not slash-command plumbing, not subagent traffic)
  busy         agent working time: from your prompt through its last activity, with gaps over --idle-min cut out
  attention    your time between the agent finishing and your next prompt, capped at --attention-cap-min
  tokens       per model response, counted once (streamed responses repeat their usage on several lines)
  intervals    busy spans, so the collector can measure how many agents ran at once
Sessions started by `claude -p` / the SDK (entrypoint sdk-*) are "automated" (app jobs); the rest are "interactive".
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import subprocess
import sys
from pathlib import Path
from zoneinfo import ZoneInfo

STATE_VERSION = 2
META_PREFIXES = ("<command-", "<local-command", "Caveat:", "<system-reminder", "[Request interrupted")


def parse_ts(s: str) -> float:
    return dt.datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()


def is_human_prompt(d: dict) -> bool:
    if d.get("type") != "user" or d.get("isMeta") or d.get("isSidechain"):
        return False
    c = (d.get("message") or {}).get("content")
    if isinstance(c, str):
        return bool(c.strip()) and not c.lstrip().startswith(META_PREFIXES)
    if isinstance(c, list):
        kinds = {b.get("type") for b in c if isinstance(b, dict)}
        if "tool_result" in kinds:
            return False
        text = " ".join(b.get("text", "") for b in c if isinstance(b, dict) and b.get("type") == "text").lstrip()
        return bool(text) and not text.startswith(META_PREFIXES) or ("image" in kinds and "text" not in kinds)
    return False


def repo_of(cwd: str, cache: dict) -> str:
    """'Org/repo' from the checkout's origin remote; falls back to the folder name."""
    if cwd in cache:
        return cache[cwd]
    parts = [x for x in cwd.split("/") if x]
    jobs = next((i for i, x in enumerate(parts) if x in (".jobs", "jobs")), None)
    if jobs is not None and 0 < jobs < len(parts) - 1:
        cache[cwd] = f"{parts[jobs - 1]}:{parts[jobs + 1]}"  # .../fg-collectlabs/.jobs/ai-photos/8235 -> fg-collectlabs:ai-photos
        return cache[cwd]
    label = "local:" + (os.path.basename(cwd.rstrip("/")) or "~")
    try:
        url = subprocess.run(["git", "-C", cwd, "config", "--get", "remote.origin.url"], capture_output=True,
                             text=True, timeout=5).stdout.strip()
        if "github.com" in url:
            label = url.split("github.com", 1)[1].lstrip(":/").removesuffix(".git")
    except Exception:  # noqa: BLE001 - folder gone, not a repo, no git
        pass
    cache[cwd] = label
    return label


class FileState:
    def __init__(self, d: dict | None = None):
        d = d or {}
        self.offset = d.get("offset", 0)
        self.mode = d.get("mode")             # interactive | automated
        self.project = d.get("project")
        self.last_act = d.get("last_act")     # epoch of the last activity
        self.busy_start = d.get("busy_start")  # start of the current busy span
        self.agent_done = d.get("agent_done")  # epoch the agent last went quiet before a prompt
        self.ids = d.get("ids", [])           # recent response ids (streamed duplicates are adjacent)
        self.days = d.get("days", {})         # day -> metrics
        self.intervals = d.get("intervals", [])  # [start, end] busy spans (interactive only)
        self.attention = d.get("attention", [])  # [start, end] your reading/prompting spans (interactive only)
        self.sessions = d.get("sessions", [])  # days this file was active

    def dump(self) -> dict:
        return {"offset": self.offset, "mode": self.mode, "project": self.project, "last_act": self.last_act,
                "busy_start": self.busy_start, "agent_done": self.agent_done, "ids": self.ids[-50:],
                "days": self.days, "intervals": self.intervals[-5000:], "attention": self.attention[-5000:],
                "sessions": self.sessions}


def day_of(t: float, tz: ZoneInfo) -> str:
    return dt.datetime.fromtimestamp(t, tz).date().isoformat()


def bump(st: FileState, day: str, key: str, v: float) -> None:
    m = st.days.setdefault(day, {})
    m[key] = m.get(key, 0) + v


def close_span(st: FileState) -> None:
    if st.busy_start is not None and st.last_act is not None and st.last_act > st.busy_start and st.mode == "interactive":
        st.intervals.append([round(st.busy_start), round(st.last_act)])
    st.busy_start = None


def scan_file(path: Path, st: FileState, tz: ZoneInfo, idle: float, cap: float, repo_cache: dict) -> None:
    sub = "/subagents/" in str(path)
    with path.open("rb") as fh:
        fh.seek(st.offset)
        for raw in fh:
            if not raw.endswith(b"\n"):
                break  # a line still being written; pick it up next run
            st.offset += len(raw)
            try:
                d = json.loads(raw)
            except ValueError:
                continue
            if st.mode is None and d.get("entrypoint"):
                st.mode = "automated" if str(d["entrypoint"]).startswith("sdk") else "interactive"
            if st.project is None and d.get("cwd"):
                st.project = repo_of(d["cwd"], repo_cache)
            ts = d.get("timestamp")
            typ = d.get("type")
            if not ts or typ not in ("user", "assistant"):
                continue
            t = parse_ts(ts)
            day = day_of(t, tz)
            if not sub and day not in st.sessions:
                st.sessions.append(day)

            if not sub and is_human_prompt(d):
                bump(st, day, "prompts", 1)
                # Your attention: from the agent going quiet to this prompt, capped (beyond that you were away).
                if st.last_act is not None and t > st.last_act:
                    bump(st, day, "attention_s", min(t - st.last_act, cap))
                    if st.mode == "interactive":
                        st.attention.append([round(max(st.last_act, t - cap)), round(t)])
                close_span(st)
                st.busy_start = t
                st.last_act = t
                continue

            # Agent activity: model responses and tool results.
            if st.last_act is not None and 0 <= t - st.last_act <= idle and st.busy_start is not None:
                bump(st, day_of(st.last_act, tz), "busy_s", t - st.last_act)
            else:
                close_span(st)
                st.busy_start = t
            st.last_act = max(t, st.last_act or t)

            if typ == "assistant":
                msg = d.get("message") or {}
                mid = msg.get("id")
                if mid and mid in st.ids:
                    continue
                if mid:
                    st.ids.append(mid)
                    st.ids = st.ids[-50:]
                u = msg.get("usage") or {}
                bump(st, day, "responses", 1)
                bump(st, day, "tokens_in", (u.get("input_tokens") or 0) + (u.get("cache_creation_input_tokens") or 0))
                bump(st, day, "cache_read", u.get("cache_read_input_tokens") or 0)
                bump(st, day, "tokens_out", u.get("output_tokens") or 0)
                model = msg.get("model")
                if model and not model.startswith("<"):
                    bump(st, day, "model:" + model, 1)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default="~/.claude/projects")
    ap.add_argument("--state", default="~/.cache/fgl-watchtower-agents/state.json")
    ap.add_argument("--tz", default="UTC")
    ap.add_argument("--idle-min", type=float, default=15)
    ap.add_argument("--attention-cap-min", type=float, default=10)
    ap.add_argument("--host", default=os.uname().nodename)
    a = ap.parse_args()
    tz = ZoneInfo(a.tz)
    root = Path(os.path.expanduser(a.root))
    state_path = Path(os.path.expanduser(a.state))
    state = {}
    if state_path.exists():
        try:
            state = json.loads(state_path.read_text())
        except ValueError:
            state = {}
    if state.get("version") != STATE_VERSION:
        state = {"version": STATE_VERSION, "files": {}, "repos": {}}
    files, repos = state["files"], state["repos"]

    for p in sorted(root.glob("**/*.jsonl")):
        key = str(p)
        st = FileState(files.get(key))
        try:
            size = p.stat().st_size
        except OSError:
            continue
        if size < st.offset:  # rewritten or replaced: start over
            st = FileState()
        if size > st.offset:
            scan_file(p, st, tz, a.idle_min * 60, a.attention_cap_min * 60, repos)
            close_span(st) if st.last_act and (dt.datetime.now().timestamp() - st.last_act) > a.idle_min * 60 else None
        files[key] = st.dump()
    # Files Claude Code has deleted stay in the state: their days are history we keep.

    state_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = state_path.with_suffix(".tmp")
    tmp.write_text(json.dumps(state))
    tmp.replace(state_path)

    out_days: dict[str, dict] = {}
    intervals: list[list] = []
    attention: list[list] = []
    for key, f in files.items():
        mode, project = f.get("mode") or "interactive", f.get("project") or "unknown"
        for day, m in f["days"].items():
            agg = out_days.setdefault(day, {}).setdefault(mode, {}).setdefault(project, {"sessions": 0})
            for k, v in m.items():
                agg[k] = agg.get(k, 0) + v
        for day in f.get("sessions", []):
            out_days.setdefault(day, {}).setdefault(mode, {}).setdefault(project, {"sessions": 0})["sessions"] += 1
        if mode == "interactive":
            intervals += [[s, e, project] for s, e in f.get("intervals", [])]
            attention += [[s, e] for s, e in f.get("attention", [])]
    json.dump({"host": a.host, "scanned_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
               "files": len(files), "days": out_days, "intervals": intervals, "attention": attention}, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())

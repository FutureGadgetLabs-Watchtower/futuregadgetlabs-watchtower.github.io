#!/usr/bin/env python3
"""Watchtower senior-hours judge.

Reads the change sets the collector builds (state/velocity/change_sets.jsonl: one repo's commits within one
working session) and asks Claude, via the local `claude` CLI on this host, how long one senior engineer
would have needed for each change before AI coding tools. Results go to state/velocity/judgments.jsonl and
stay on this host; the collector publishes only per-day totals.

    python3 collector/judge.py run [--limit N] [--since YYYY-MM-DD]   # judge unjudged sets, newest first
    python3 collector/judge.py calibration-sheet [--n 18]            # pick sets for you to score blind
    python3 collector/judge.py calibration-report                    # your scores vs the judge's
    python3 collector/judge.py prompt <change-set-id>                # print the prompt, judge nothing

The weekly timer runs `run`; the one-off back-fill is `run` without --since (it resumes where it stopped).
Standard library only, like the collector. It uses the Claude login of the user it runs as, or the one in
JUDGE_CLAUDE_CONFIG_DIR, so pick an account whose usage limits it may spend.
"""

from __future__ import annotations

import argparse
import concurrent.futures as cf
import csv
import datetime as dt
import gzip
import hashlib
import json
import logging
import os
import random
import re
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import sync_watchtower as wt  # noqa: E402  (shared config, classification and cache helpers)

log = logging.getLogger("watchtower.judge")

PROMPT_VERSION = "2026-11-27.1"
DIFF_BUDGET_LINES = 2500      # diff lines shown per change set; the file list always covers everything
DIFF_LINES_PER_FILE = 300
JUDGED_CATS = ("code", "test", "config", "docs")
LIMIT_RE = re.compile(r"(session|usage|weekly|rate|5-hour) limit|limit reached|too many requests", re.I)

SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["summary", "kind", "complexity", "hours_low", "hours_likely", "hours_high", "rationale", "confidence"],
    "properties": {
        "summary": {"type": "string", "maxLength": 200, "description": "What the change does, in plain words, no code."},
        "kind": {"type": "string", "enum": ["feature", "fix", "refactor", "test", "infra", "docs", "chore"]},
        "complexity": {"type": "string", "enum": ["trivial", "small", "medium", "large", "very_large"]},
        "hours_low": {"type": "number", "minimum": 0},
        "hours_likely": {"type": "number", "minimum": 0},
        "hours_high": {"type": "number", "minimum": 0},
        "rationale": {"type": "string", "maxLength": 400, "description": "Why that many hours: what is hard or easy here."},
        "confidence": {"type": "string", "enum": ["low", "medium", "high"]},
    },
}

RUBRIC = """\
You are a calibrated estimator of software engineering effort.

Question: how many focused hours would ONE experienced senior software engineer have needed to produce the
change below in 2022, before AI coding tools, working alone and already familiar with this codebase and stack?

Count: understanding the problem and the code involved, design, writing the code and tests shown, local
debugging until it works, self-review. Do not count: meetings, waiting on CI or reviewers, deploy babysitting,
or work that is not visible in this change.

Rules:
- Judge what the change accomplishes and how hard that is, not its line count. AI-written code is often
  verbose: boilerplate, long comments, many near-identical tests or files. Credit that at the speed a senior
  would produce it (copy-paste, codegen, editor tooling), not line by line.
- Straightforward CRUD, config, wiring and UI layout go fast. Subtle concurrency, data correctness, money or
  probability math, migrations of live data, unfamiliar external APIs and tricky debugging go slow.
- Deletions, renames and moves are cheap unless the refactor clearly needed careful reasoning.
- If the diff is truncated, extrapolate from the file list and what you can see, and widen the range.
- hours_likely is your median. hours_low and hours_high bracket an 80% interval.

Reference points (one senior engineer, pre-AI):
- Config or CI tweak, dependency bump, ~20 lines: 0.25-0.5 h
- Small bug fix in familiar code plus a regression test, ~40 lines: 0.5-2 h
- New REST endpoint with validation, a DB query and tests, ~300 lines: 4-8 h
- New UI page with a chart, filters and state, ~500 lines: 6-12 h
- New service module: schema migration, background worker with retries, API wiring, tests, ~1,500 lines: 20-40 h
- Greenfield app scaffold (build setup, routing, a few CRUD screens), ~3,000 mostly boilerplate lines: 16-32 h
- Documentation only, ~200 lines of prose: 1-2 h
"""


# ---------------------------------------------------------------------------------------------
# Inputs
# ---------------------------------------------------------------------------------------------


class Inputs:
    def __init__(self, cfg: wt.Config):
        self.cfg = cfg
        self.store = cfg.state_dir / "velocity"
        self.vcfg = {**wt.VELOCITY_DEFAULTS, **cfg.targets.get("velocity", {})}
        self.classify = wt.file_classifier(self.vcfg)
        self.sets = wt._read_jsonl(self.store / "change_sets.jsonl")
        if not self.sets:
            raise SystemExit("no change sets yet: run the collector's velocity module first")
        self.by_id = {s["id"]: s for s in self.sets}
        self._files: dict[str, list] = {}
        self.org_desc = {o["id"]: o.get("description", "") for o in cfg.orgs}

    def files(self, project: str) -> dict[str, list]:
        if project not in self._files:
            self._files[project] = {r["oid"]: r["files"] for r in
                                    wt._read_jsonl(self.store / "files" / (project.replace("/", "__") + ".jsonl"))}
        return self._files[project]

    def patches(self, project: str, oid: str) -> dict[str, str]:
        p = self.store / "diffs" / project.replace("/", "__") / f"{oid}.json.gz"
        return json.loads(gzip.decompress(p.read_bytes())) if p.exists() else {}


def signature(cs: dict) -> str:
    """Changes when a session picks up more commits, so a stale judgment gets redone."""
    return hashlib.sha1("".join(cs["commits"]).encode()).hexdigest()[:12]


def code_lines(cs: dict) -> int:
    return sum(sum(cs["lines"].get(k, [0, 0])) for k in ("code", "test", "config"))


def build_prompt(inp: Inputs, cs: dict) -> str:
    project = cs["project"]
    org = project.split("/")[0]
    files = inp.files(project)
    per_file: dict[str, list] = {}
    excluded = [0, 0]
    for oid in cs["commits"]:
        for path, status, add, dele in files.get(oid, []):
            cat = wt.classify_change(path, add, dele, inp.classify)
            if cat == "excluded":
                excluded[0] += 1
                excluded[1] += add + dele
                continue
            f = per_file.setdefault(path, [cat, status, 0, 0])
            f[2] += add
            f[3] += dele

    lines = [f"Repository: {project}" + (f" ({inp.org_desc[org]})" if inp.org_desc.get(org) else ""),
             f"Date: {cs['date']} · {len(cs['commits'])} commit(s)", "", "Commit messages (oldest first):"]
    lines += [f"- {s}" for s in cs.get("subjects", [])]
    lines += ["", f"Files changed ({len(per_file)}; category, +added -deleted):"]
    for path, (cat, status, add, dele) in sorted(per_file.items(), key=lambda kv: -(kv[1][2] + kv[1][3]))[:150]:
        lines.append(f"- {path}  [{cat}{', ' + status if status not in ('modified', '') else ''}]  +{add} -{dele}")
    if len(per_file) > 150:
        lines.append(f"- ... and {len(per_file) - 150} more files")
    if excluded[0]:
        lines.append(f"(Not shown: {excluded[0]} lockfile/generated/data/binary file changes, {excluded[1]:,} lines.)")

    shown, total, diff = 0, 0, []
    for oid in cs["commits"]:
        for path, patch in inp.patches(project, oid).items():
            if path not in per_file or per_file[path][0] not in JUDGED_CATS:
                continue
            pl = patch.splitlines()
            total += len(pl)
            take = min(len(pl), DIFF_LINES_PER_FILE, DIFF_BUDGET_LINES - shown)
            if take <= 0:
                continue
            diff.append(f"--- {path} ({oid[:8]})")
            diff += pl[:take]
            if take < len(pl):
                diff.append(f"... [{len(pl) - take} more lines of this file not shown]")
            shown += take
    lines += ["", f"Diff (showing {shown:,} of {total:,} diff lines" + (", TRUNCATED" if shown < total else "") + "):"]
    lines += diff or ["(no diff text available; judge from the file list)"]
    return RUBRIC + "\n\n=== CHANGE ===\n" + "\n".join(lines) + "\n\nReturn your estimate."


# ---------------------------------------------------------------------------------------------
# Claude
# ---------------------------------------------------------------------------------------------


class Limited(Exception):
    pass


def claude_env() -> dict:
    env = {k: v for k, v in os.environ.items() if not re.search(r"TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL", k, re.I)}
    env.pop("ANTHROPIC_API_KEY", None)  # never bill per token by accident; use the subscription login
    if os.environ.get("JUDGE_CLAUDE_CONFIG_DIR"):
        env["CLAUDE_CONFIG_DIR"] = os.environ["JUDGE_CLAUDE_CONFIG_DIR"]
    return env


def ask_claude(prompt: str, model: str, effort: str, timeout_s: int = 600) -> tuple[dict, dict]:
    cmd = [os.environ.get("CLAUDE_BIN", "claude"), "-p", "--output-format", "json",
           "--json-schema", json.dumps(SCHEMA), "--model", model, "--effort", effort,
           "--tools", "", "--permission-mode", "dontAsk", "--safe-mode", "--strict-mcp-config",
           "--no-session-persistence"]
    workdir = Path(os.environ.get("JUDGE_WORKDIR", Path.home() / ".cache" / "fgl-watchtower-judge"))
    workdir.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    p = subprocess.run(cmd, input=prompt, capture_output=True, text=True, timeout=timeout_s, cwd=workdir, env=claude_env())
    try:
        data = json.loads(p.stdout)
    except json.JSONDecodeError:
        tail = (p.stderr or p.stdout)[-1500:]
        if LIMIT_RE.search(tail):
            raise Limited(tail.strip())
        raise RuntimeError(f"claude exited {p.returncode}: {tail}")
    if data.get("is_error") or not data.get("structured_output"):
        msg = str(data.get("result") or data)[:1500]
        if LIMIT_RE.search(msg):
            raise Limited(msg)
        raise RuntimeError(msg)
    r = data["structured_output"]
    lo, mid, hi = sorted([float(r["hours_low"]), float(r["hours_likely"]), float(r["hours_high"])])
    r.update(hours_low=lo, hours_likely=mid, hours_high=hi)
    usage = data.get("modelUsage") or {}
    meta = {
        "models": sorted(usage),
        "tokens_in": sum((u.get("inputTokens") or 0) + (u.get("cacheReadInputTokens") or 0) + (u.get("cacheCreationInputTokens") or 0)
                         for u in usage.values()),
        "tokens_out": sum(u.get("outputTokens") or 0 for u in usage.values()),
        "cost_usd": data.get("total_cost_usd"),  # API-equivalent; $0 marginal on a subscription
        "duration_s": round(time.monotonic() - started, 1),
    }
    return r, meta


# ---------------------------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------------------------


def load_judgments(store: Path) -> list[dict]:
    return wt._read_jsonl(store / "judgments.jsonl")


def current(judgments: list[dict], sets_by_id: dict[str, dict], sample: str = "primary") -> dict[str, dict]:
    """Latest judgment per change set for this prompt version and the set's current commits."""
    out = {}
    for j in judgments:
        cs = sets_by_id.get(j["id"])
        if cs and j["prompt_version"] == PROMPT_VERSION and j["sig"] == signature(cs) and j.get("sample", "primary") == sample:
            out[j["id"]] = j
    return out


def cmd_run(cfg: wt.Config, args: argparse.Namespace) -> int:
    inp = Inputs(cfg)
    path = inp.store / "judgments.jsonl"
    done = current(load_judgments(inp.store), inp.by_id)
    todo = [s for s in reversed(inp.sets) if s["id"] not in done and s["complete"] and (not args.since or s["date"] >= args.since)]
    if args.ids:
        todo = [inp.by_id[i] for i in args.ids if i in inp.by_id]
    # A small, stable random share is judged twice to measure how consistent the judge is.
    repeats_done = current(load_judgments(inp.store), inp.by_id, sample="repeat")
    rng = random.Random(7)
    repeat_ids = {s["id"] for s in inp.sets if rng.random() < args.repeat_share}
    repeats = [s for s in reversed(inp.sets) if s["id"] in repeat_ids and s["id"] in done and s["id"] not in repeats_done]
    jobs = [(s, "primary") for s in todo] + [(s, "repeat") for s in repeats]
    if args.limit:
        jobs = jobs[: args.limit]
    log.info("judge: %d to do (%d already judged, %d repeats due); model %s, effort %s",
             len(jobs), len(done), len(repeats), args.model, args.effort)

    def one(job: tuple[dict, str]) -> dict:
        cs, sample = job
        r, meta = ask_claude(build_prompt(inp, cs), args.model, args.effort)
        return {"id": cs["id"], "sig": signature(cs), "sample": sample, "prompt_version": PROMPT_VERSION,
                "judged_at": wt.iso(wt.now_utc()), "model": args.model, "effort": args.effort,
                "code_lines": code_lines(cs), **r, **meta}

    n_ok = 0
    with cf.ThreadPoolExecutor(max_workers=args.concurrency) as pool, path.open("a") as out:
        futs = {pool.submit(one, j): j for j in jobs}
        try:
            for f in cf.as_completed(futs):
                cs, sample = futs[f]
                try:
                    row = f.result()
                except Limited as e:
                    log.warning("judge: usage limit reached, stopping (progress is saved): %s", str(e)[:200])
                    for other in futs:
                        other.cancel()
                    break
                except Exception as e:  # noqa: BLE001 - one bad set shouldn't stop the run
                    log.warning("judge: %s failed: %s", cs["id"], str(e)[:300])
                    continue
                out.write(json.dumps(row) + "\n")
                out.flush()
                n_ok += 1
                log.info("judge: %-60s %6.1f h  (%s, %s)  [%d/%d]", cs["id"], row["hours_likely"], row["kind"],
                         row["complexity"], n_ok, len(jobs))
        finally:
            pool.shutdown(cancel_futures=True)
    return 0


def cmd_prompt(cfg: wt.Config, args: argparse.Namespace) -> int:
    inp = Inputs(cfg)
    cs = inp.by_id.get(args.id) or next((s for s in inp.sets if s["id"].startswith(args.id)), None)
    if not cs:
        raise SystemExit(f"no change set {args.id}")
    print(build_prompt(inp, cs))
    return 0


def cmd_calibration_sheet(cfg: wt.Config, args: argparse.Namespace) -> int:
    """Pick change sets across sizes and repos for blind human scoring."""
    inp = Inputs(cfg)
    since = (wt.now_utc().date() - dt.timedelta(weeks=args.weeks)).isoformat()
    pool = [s for s in inp.sets if s["complete"] and s["date"] >= since and code_lines(s) > 0]
    pool.sort(key=code_lines)
    rng = random.Random(args.seed)
    picked, used_repos = [], set()
    bins = [pool[i * len(pool) // args.n:(i + 1) * len(pool) // args.n] for i in range(args.n)]  # size quantiles
    for b in bins:
        rng.shuffle(b)
        choice = next((s for s in b if s["project"] not in used_repos), b[0] if b else None)
        if choice:
            picked.append(choice)
            used_repos.add(choice["project"])
    path = inp.store / "calibration.csv"
    md = inp.store / "calibration.md"
    with path.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["n", "id", "your_hours", "notes"])
        for i, s in enumerate(picked, 1):
            w.writerow([i, s["id"], "", ""])
    out = ["# Calibration: score these blind", "",
           "For each change, how many focused hours would it have taken you, as a senior engineer before AI, working",
           "alone and already familiar with the codebase? Same rules the judge gets: count design, coding, tests and",
           "debugging; not meetings or waiting on CI. Put your number in calibration.csv (your_hours) or reply in chat.", ""]
    for i, s in enumerate(picked, 1):
        files = inp.files(s["project"])
        n_files = len({p for oid in s["commits"] for p, *_ in files.get(oid, [])})
        out += [f"## {i}. {s['project']} · {s['date']}",
                f"{len(s['commits'])} commit(s) · {code_lines(s):,} code lines · {n_files} files", ""]
        out += [f"- {subj}" for subj in s["subjects"][:12]]
        if len(s["subjects"]) > 12:
            out.append(f"- ... {len(s['subjects']) - 12} more")
        out += [""] + [f"  https://github.com/{s['project']}/commit/{oid}" for oid in s["commits"][:8]] + [""]
    md.write_text("\n".join(out))
    print(f"wrote {md} and {path} ({len(picked)} change sets)")
    return 0


def cmd_calibration_report(cfg: wt.Config, args: argparse.Namespace) -> int:
    inp = Inputs(cfg)
    rows = list(csv.DictReader((inp.store / "calibration.csv").open()))
    js = current(load_judgments(inp.store), inp.by_id)
    reps = current(load_judgments(inp.store), inp.by_id, sample="repeat")
    pairs = []
    for r in rows:
        if r["your_hours"].strip() and r["id"] in js:
            pairs.append((float(r["your_hours"]), js[r["id"]]["hours_likely"], js[r["id"]]["hours_low"], js[r["id"]]["hours_high"], r["id"]))
    if not pairs:
        print("no scored + judged pairs yet (fill your_hours, then run: judge.py run --ids <the calibration ids>)")
        return 1
    you, judge = sum(p[0] for p in pairs), sum(p[1] for p in pairs)
    inside = sum(1 for y, _, lo, hi, _ in pairs if lo <= y <= hi)
    ratios = sorted(j / y for y, j, *_ in pairs if y > 0)
    print(f"{len(pairs)} pairs · your total {you:.1f} h · judge total {judge:.1f} h · judge/you = {judge / you:.2f}")
    print(f"median per-set ratio {ratios[len(ratios) // 2]:.2f} · your number inside the judge's 80% range: {inside}/{len(pairs)}")
    for y, j, lo, hi, i in pairs:
        print(f"  {i:60s} you {y:5.1f}  judge {j:5.1f} ({lo:.1f}-{hi:.1f})")
    if reps:
        diffs = [abs(reps[i]["hours_likely"] - js[i]["hours_likely"]) / max(js[i]["hours_likely"], 0.1) for i in reps if i in js]
        if diffs:
            diffs.sort()
            print(f"judge consistency: {len(diffs)} repeats, median difference {diffs[len(diffs) // 2]:.0%}")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run")
    r.add_argument("--limit", type=int, default=0)
    r.add_argument("--since", help="only change sets on or after this local date")
    r.add_argument("--ids", nargs="*", help="judge exactly these change sets")
    r.add_argument("--model", default=os.environ.get("JUDGE_MODEL", "sonnet"))
    r.add_argument("--effort", default=os.environ.get("JUDGE_EFFORT", "medium"))
    r.add_argument("--concurrency", type=int, default=int(os.environ.get("JUDGE_CONCURRENCY", "2")))
    r.add_argument("--repeat-share", type=float, default=0.05, help="share of sets judged twice for consistency")
    p = sub.add_parser("prompt")
    p.add_argument("id")
    c = sub.add_parser("calibration-sheet")
    c.add_argument("--n", type=int, default=18)
    c.add_argument("--weeks", type=int, default=12)
    c.add_argument("--seed", type=int, default=11)
    sub.add_parser("calibration-report")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    cfg = wt.Config()
    return {"run": cmd_run, "prompt": cmd_prompt, "calibration-sheet": cmd_calibration_sheet,
            "calibration-report": cmd_calibration_report}[args.cmd](cfg, args)


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Watchtower collector.

Runs on a Proxmox node (systemd timer or cron). Gathers telemetry, rewrites data/*.json in this
repo, and commits + pushes so the GitHub Pages workflow rebuilds the static site. The site never
calls the homelab, so when this script stops running the site keeps serving the last push and
shows it as cached/STALE.

Standard library only (Python 3.10+), so it runs on a stock Proxmox host without pip.

    python3 collector/sync_watchtower.py                 # collect everything, commit, push
    python3 collector/sync_watchtower.py --only health   # one module
    python3 collector/sync_watchtower.py --dry-run       # print what would change, write nothing
    python3 collector/sync_watchtower.py --no-push       # write + commit locally only

Modules fail independently: if GitHub is unreachable, health still updates, and the previous
velocity.json is kept as it was.
"""

from __future__ import annotations

import argparse
import datetime as dt
import glob
import json
import logging
import os
import re
import socket
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Callable
from zoneinfo import ZoneInfo

VERSION = "0.2.0"
SCHEMA_VERSION = 1
VELOCITY_SCHEMA_VERSION = 2
HERE = Path(__file__).resolve().parent
log = logging.getLogger("watchtower")

UTC = dt.timezone.utc


def now_utc() -> dt.datetime:
    return dt.datetime.now(UTC).replace(microsecond=0)


def iso(t: dt.datetime) -> str:
    return t.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso(s: str) -> dt.datetime:
    return dt.datetime.fromisoformat(s.replace("Z", "+00:00"))


def monday(d: dt.date) -> dt.date:
    return d - dt.timedelta(days=d.weekday())


# ---------------------------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------------------------


def load_dotenv(path: Path) -> None:
    """Minimal .env loader. Real environment variables win over the file."""
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        v = v.strip().strip('"').strip("'")
        os.environ.setdefault(k.strip(), v)


class Config:
    def __init__(self) -> None:
        load_dotenv(HERE / ".env")
        self.repo_dir = Path(os.environ.get("WATCHTOWER_REPO_DIR", HERE.parent)).resolve()
        self.data_dir = self.repo_dir / "data"
        self.state_dir = Path(os.environ.get("WATCHTOWER_STATE_DIR", HERE / "state")).resolve()
        self.node_name = os.environ.get("WATCHTOWER_NODE_NAME", socket.gethostname())
        cfg_path = Path(os.environ.get("WATCHTOWER_CONFIG", HERE / "watchtower.config.json"))
        if not cfg_path.exists():
            fallback = HERE / "watchtower.config.example.json"
            log.warning("%s not found, using %s", cfg_path.name, fallback.name)
            cfg_path = fallback
        self.targets: dict[str, Any] = json.loads(cfg_path.read_text())

        self.github_api = os.environ.get("GITHUB_API_URL", "https://api.github.com")
        # GitHub App (preferred): one app installed on every org; short-lived per-org tokens are minted on demand.
        self.github_app_id = os.environ.get("GITHUB_APP_ID", "")
        self.github_app_key = os.path.expanduser(os.environ.get("GITHUB_APP_KEY", ""))
        self.app = GitHubApp(self)
        self.http_timeout = float(os.environ.get("HEALTH_HTTP_TIMEOUT", "8"))
        self.degraded_ms = int(os.environ.get("HEALTH_DEGRADED_MS", "800"))
        self.history_len = int(os.environ.get("HEALTH_HISTORY_LEN", "48"))

        self.pve_api_url = os.environ.get("PVE_API_URL", "")  # e.g. https://127.0.0.1:8006/api2/json
        self.pve_token_id = os.environ.get("PVE_TOKEN_ID", "")  # user@pam!watchtower
        self.pve_token_secret = os.environ.get("PVE_TOKEN_SECRET", "")
        self.pve_verify_tls = os.environ.get("PVE_VERIFY_TLS", "false").lower() == "true"

        self.git_remote = os.environ.get("GIT_REMOTE", "origin")
        self.git_branch = os.environ.get("GIT_BRANCH", "main")
        self.git_author = os.environ.get("GIT_AUTHOR", "Watchtower Collector <watchtower@localhost>")
        self.heartbeat_minutes = int(os.environ.get("SYNC_HEARTBEAT_MINUTES", "60"))

    @property
    def orgs(self) -> list[dict]:
        return self.targets.get("orgs", [])

    @property
    def projects(self) -> list[dict]:
        return self.targets.get("projects", [])

    def github_token(self, org: str) -> str:
        """The GitHub App's installation token for this org when the App is configured.

        Otherwise a PAT: fine-grained PATs are scoped to one owner, so GITHUB_TOKEN__FG_POLYLABS
        overrides GITHUB_TOKEN for org FG-PolyLabs.
        """
        if self.app.enabled:
            return self.app.token(org)
        key = "GITHUB_TOKEN__" + re.sub(r"[^A-Z0-9]", "_", org.upper())
        return os.environ.get(key) or os.environ.get("GITHUB_TOKEN", "")


def collector_meta(cfg: Config, started: float) -> dict:
    return {
        "host": cfg.node_name,
        "version": VERSION,
        "run_id": iso(now_utc()),
        "duration_ms": int((time.monotonic() - started) * 1000),
        "mock": False,
    }


def read_json(path: Path, default: Any = None) -> Any:
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def write_json_atomic(path: Path, obj: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, indent=2, ensure_ascii=False) + "\n")
    tmp.replace(path)


# ---------------------------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------------------------


def http_json(url: str, *, method: str = "GET", headers: dict | None = None, body: Any = None,
              timeout: float = 20, context: ssl.SSLContext | None = None, retries: int = 3) -> Any:
    """JSON request. Retries 5xx and network errors with backoff (GitHub GraphQL 502s on heavy pages)."""
    for attempt in range(retries + 1):
        try:
            return _http_json(url, method=method, headers=headers, body=body, timeout=timeout, context=context)
        except urllib.error.HTTPError as e:
            if e.code < 500 or attempt == retries:
                raise
        except (urllib.error.URLError, TimeoutError):
            if attempt == retries:
                raise
        time.sleep(2 * (attempt + 1))


def _http_json(url: str, *, method: str, headers: dict | None, body: Any, timeout: float,
               context: ssl.SSLContext | None) -> Any:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "Accept": "application/json",
        "User-Agent": f"fgl-watchtower-collector/{VERSION}",
        **({"Content-Type": "application/json"} if data else {}),
        **(headers or {}),
    })
    with urllib.request.urlopen(req, timeout=timeout, context=context) as r:
        return json.loads(r.read().decode())


# ---------------------------------------------------------------------------------------------
# GitHub App auth: JWT signed with openssl (keeps the collector stdlib-only), per-org install tokens
# ---------------------------------------------------------------------------------------------


def _b64url(b: bytes) -> str:
    import base64
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


class GitHubApp:
    """Read-only access to every org the Watchtower GitHub App is installed on.

    Tokens live in memory only and expire within the hour; nothing is written to disk.
    """

    def __init__(self, cfg: "Config"):
        self.cfg = cfg
        self._installs: dict[str, int] | None = None
        self._tokens: dict[str, tuple[str, float]] = {}

    @property
    def enabled(self) -> bool:
        return bool(self.cfg.github_app_id and self.cfg.github_app_key)

    def _jwt(self) -> str:
        now = int(time.time())
        head = _b64url(b'{"alg":"RS256","typ":"JWT"}')
        body = _b64url(json.dumps({"iat": now - 60, "exp": now + 540, "iss": self.cfg.github_app_id}).encode())
        sig = subprocess.run(["openssl", "dgst", "-sha256", "-sign", self.cfg.github_app_key, "-binary"],
                             input=f"{head}.{body}".encode(), capture_output=True, check=True).stdout
        return f"{head}.{body}.{_b64url(sig)}"

    def _api(self, path: str, auth: str, **kw: Any) -> Any:
        return http_json(self.cfg.github_api.rstrip("/") + path,
                         headers={"Authorization": auth, "X-GitHub-Api-Version": "2022-11-28"}, **kw)

    def installations(self) -> dict[str, int]:
        if self._installs is None:
            self._installs = {}
            page = 1
            while True:
                batch = self._api(f"/app/installations?per_page=100&page={page}", f"Bearer {self._jwt()}")
                for i in batch:
                    self._installs[i["account"]["login"]] = i["id"]
                if len(batch) < 100:
                    break
                page += 1
        return self._installs

    def token(self, org: str) -> str:
        tok, exp = self._tokens.get(org, ("", 0.0))
        if tok and exp - time.time() > 300:
            return tok
        inst = self.installations().get(org)
        if not inst:
            raise RuntimeError(f"the GitHub App is not installed on {org}")
        res = self._api(f"/app/installations/{inst}/access_tokens", f"Bearer {self._jwt()}", method="POST", body={})
        self._tokens[org] = (res["token"], parse_iso(res["expires_at"]).timestamp())
        return res["token"]

    def repos(self, org: str) -> list[dict]:
        out, page = [], 1
        while True:
            batch = self._api(f"/installation/repositories?per_page=100&page={page}", f"token {self.token(org)}")
            out += batch["repositories"]
            if len(out) >= batch["total_count"] or not batch["repositories"]:
                return out
            page += 1


# ---------------------------------------------------------------------------------------------
# GitHub aggregator (GraphQL + REST)
# ---------------------------------------------------------------------------------------------


class GitHub:
    def __init__(self, cfg: Config):
        self.cfg = cfg

    def _headers(self, org: str) -> dict:
        tok = self.cfg.github_token(org)
        if not tok:
            raise RuntimeError(f"no GitHub token for {org}: set GITHUB_TOKEN or a per-org override")
        return {"Authorization": f"Bearer {tok}", "X-GitHub-Api-Version": "2022-11-28"}

    def graphql(self, org: str, query: str, variables: dict) -> dict:
        url = self.cfg.github_api.rstrip("/") + "/graphql"
        res = http_json(url, method="POST", headers=self._headers(org), body={"query": query, "variables": variables})
        if res.get("errors"):
            raise RuntimeError(f"GraphQL error for {org}: {res['errors'][0].get('message')}")
        return res["data"]

    def rest(self, org: str, path: str, params: dict | None = None) -> Any:
        qs = ("?" + urllib.parse.urlencode(params)) if params else ""
        return http_json(self.cfg.github_api.rstrip("/") + path + qs, headers=self._headers(org))

    # -- default-branch history, newest first, stopping at commits already cached ---------------
    HISTORY_Q = """
    query($owner:String!, $name:String!, $cursor:String, $n:Int!) {
      repository(owner:$owner, name:$name) {
        defaultBranchRef { target { ... on Commit {
          history(first:$n, after:$cursor) {
            pageInfo { hasNextPage endCursor }
            nodes { oid authoredDate additions deletions message parents { totalCount } author { name user { login } } }
          }
        } } }
      }
    }"""

    def commit_history(self, org: str, repo: str, known: set[str]) -> list[dict]:
        """New default-branch commits (not in `known`), newest first. Pages are kept small because
        GraphQL times out (502) on 100-commit pages that carry diff stats."""
        out, cursor = [], None
        while True:
            d = self.graphql(org, self.HISTORY_Q, {"owner": org, "name": repo, "cursor": cursor, "n": 40})
            ref = (d.get("repository") or {}).get("defaultBranchRef")
            if not ref:
                return out  # empty repo
            hist = ref["target"]["history"]
            for n in hist["nodes"]:
                if n["oid"] in known:
                    return out
                out.append(n)
            if not hist["pageInfo"]["hasNextPage"]:
                return out
            cursor = hist["pageInfo"]["endCursor"]

    # -- merged PRs for one org in a date range (search caps at 1000 hits, so callers go month by month)
    PRS_Q = """
    query($q:String!, $cursor:String) {
      search(query:$q, type:ISSUE, first:100, after:$cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { ... on PullRequest { mergedAt repository { name } } }
      }
    }"""

    def merged_prs(self, org: str, start: dt.date, end: dt.date) -> list[tuple[str, str]]:
        """[(repo name, mergedAt iso)] for PRs merged in [start, end]."""
        out, cursor = [], None
        q = f"org:{org} is:pr is:merged merged:{start.isoformat()}..{end.isoformat()}"
        while True:
            d = self.graphql(org, self.PRS_Q, {"q": q, "cursor": cursor})["search"]
            out += [(n["repository"]["name"], n["mergedAt"]) for n in d["nodes"] if n and n.get("mergedAt")]
            if not d["pageInfo"]["hasNextPage"]:
                return out
            cursor = d["pageInfo"]["endCursor"]

    def releases(self, org: str, repo: str, limit: int = 20) -> list[dict]:
        return self.rest(org, f"/repos/{org}/{repo}/releases", {"per_page": limit})

    def roadmap_issues(self, org: str, repo: str, label: str) -> list[dict]:
        return self.rest(org, f"/repos/{org}/{repo}/issues", {"labels": label, "state": "all", "per_page": 100})


# ---------------------------------------------------------------------------------------------
# Velocity: every commit the GitHub App can see, cached per repo, published as daily totals
# ---------------------------------------------------------------------------------------------

# Defaults for watchtower.config.json "velocity"; every key can be overridden there.
VELOCITY_DEFAULTS: dict[str, Any] = {
    "timezone": "UTC",
    "include_orgs": [],               # empty = every org the App is installed on
    "exclude_orgs": [],
    "exclude_repos": [],              # "Org/repo"; e.g. data repos that a bot commits to under a human login
    "exclude_forks": True,
    "session_gap_minutes": 120,       # commits closer than this belong to one working session
    "session_lead_minutes": 30,       # work before a session's first commit
    "max_lines_per_commit": 5000,     # caps generated / vendored commits so they can't swamp the totals
    "automated_message_patterns": [r"^auto[ -]?update\b", r"^chore\(data\)", r"^data: sync\b", r"\[skip ci\]"],
    "file_fetch_budget": 600,         # per-commit file stats fetched per run; --backfill-files lifts the cap
    "file_rules": {},                 # extra regexes per category, tried before the built-in ones
    "publish_senior": True,           # off while calibrating, so the judge's numbers stay blind until you've scored
}

# File classification for code-only line counts and the judge's diffs. First match wins, in this order.
FILE_RULES: list[tuple[str, list[str]]] = [
    ("excluded", [
        r"(^|/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|poetry\.lock|uv\.lock|Pipfile\.lock"
        r"|Cargo\.lock|go\.sum|Gemfile\.lock|composer\.lock|flake\.lock)$",
        r"(^|/)(dist|build|out|node_modules|vendor|\.next|\.nuxt|coverage|__snapshots__|__pycache__|\.venv|site-packages)/",
        r"\.(min\.js|min\.css|map|lock|snap)$", r"(_pb2(_grpc)?\.py|\.pb\.go|\.generated\.[a-z]+)$",
        r"\.(csv|tsv|jsonl|ndjson|parquet|xlsx?|sqlite3?|db|pkl|npy|h5)$",
        r"(^|/)(data|datasets|fixtures|snapshots|samples|seeds?|seed-data|testdata|mock-data)/.*\.(json|ya?ml|xml|txt|html|csv)$",
        r"\.(png|jpe?g|gif|webp|avif|ico|icns|svg|pdf|woff2?|ttf|otf|eot|mp[34]|wav|mov|webm|zip|gz|tgz|tar|7z|wasm|bin|exe|dll|so|dylib)$",
    ]),
    ("test", [r"(^|/)(tests?|__tests__|specs?|e2e|cypress|playwright)/",
              r"(_test\.(go|py|rs)|\.(test|spec)\.[cm]?[jt]sx?|(^|/)test_[^/]*\.py|(^|/)conftest\.py)$"]),
    ("docs", [r"\.(md|mdx|rst|adoc|txt)$", r"(^|/)(LICENSE|CHANGELOG|AUTHORS)[^/]*$"]),
    ("config", [r"\.(ya?ml|toml|ini|cfg|conf|properties|env\.example|tf|tfvars|hcl|nix)$",
                r"(^|/)(Dockerfile[^/]*|Containerfile|Makefile|Procfile|Caddyfile|docker-compose[^/]*|\.[a-z]+rc|\.gitignore|\.dockerignore)$",
                r"(^|/)\.github/", r"\.json$"]),
]
CODE_CATS = ("code", "test", "config")  # what the judge reads and "code lines" counts; docs are tallied apart


def file_classifier(vcfg: dict) -> Callable[[str], str]:
    extra = vcfg.get("file_rules") or {}
    rules = [(cat, [re.compile(rx, re.I) for rx in extra.get(cat, []) + rxs]) for cat, rxs in FILE_RULES]
    rules += [(cat, [re.compile(rx, re.I) for rx in rxs]) for cat, rxs in extra.items() if cat not in dict(FILE_RULES)]

    def classify(path: str) -> str:
        for cat, rxs in rules:
            if any(rx.search(path) for rx in rxs):
                return cat
        return "code"
    return classify
ORG_PALETTE = ["#338ced", "#e76624", "#00a888", "#d28e05", "#e24d8b", "#0aac23", "#9887ef",
               "#5ab4c4", "#c46a3a", "#8fa83a", "#b45fb0", "#6f86d6"]
EMPTY_DAY = {"commits": 0, "additions": 0, "deletions": 0, "claude": 0, "hours": 0.0, "prs": 0,
             "code": 0, "docs": 0, "sets": 0, "unclassified": 0,
             "senior": 0.0, "senior_low": 0.0, "senior_high": 0.0, "judged": 0}
CLAUDE_TRAILER = re.compile(r"^co-authored-by:\s*claude\b", re.I | re.M)


def _commit_record(n: dict) -> dict:
    """What the collector keeps per commit (on the collector host only; never published)."""
    msg = n.get("message") or ""
    return {
        "oid": n["oid"], "t": n["authoredDate"],
        "login": ((n.get("author") or {}).get("user") or {}).get("login") or "",
        "add": n.get("additions") or 0, "del": n.get("deletions") or 0,
        "merge": (n.get("parents") or {}).get("totalCount", 1) > 1,
        "claude": bool(CLAUDE_TRAILER.search(msg)),
        "subj": msg.splitlines()[0][:200] if msg else "",
    }


def _read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def _write_jsonl(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text("".join(json.dumps(r, separators=(",", ":")) + "\n" for r in rows))
    tmp.replace(path)


def sync_commit_cache(cfg: Config, vcfg: dict, full: bool = False) -> tuple[list[dict], list[dict]]:
    """Refresh the per-repo commit cache from GitHub. Returns (repos, commits).

    A repo is only queried when its pushed_at moved since the last run, so a 15-minute timer costs a
    handful of API calls. `full` re-reads every repo from scratch (after a force-push or a pattern change).
    """
    gh = GitHub(cfg)
    store = cfg.state_dir / "velocity"
    meta_path = store / "repos.json"
    meta = {} if full else (read_json(meta_path, {}) or {})
    include, exclude_orgs = set(vcfg["include_orgs"]), set(vcfg["exclude_orgs"])
    exclude_repos = set(vcfg["exclude_repos"])
    repos, commits = [], []
    for org in sorted(cfg.app.installations()):
        if (include and org not in include) or org in exclude_orgs:
            continue
        for r in cfg.app.repos(org):
            full_name = f"{org}/{r['name']}"
            if full_name in exclude_repos or (r.get("fork") and vcfg["exclude_forks"]):
                continue
            path = store / "commits" / (full_name.replace("/", "__") + ".jsonl")
            cached = [] if full else _read_jsonl(path)
            if full or not path.exists() or meta.get(full_name, {}).get("pushed_at") != r.get("pushed_at"):
                try:
                    new = gh.commit_history(org, r["name"], {c["oid"] for c in cached})
                except Exception as e:  # noqa: BLE001 - keep what we had for this repo, carry on
                    log.warning("velocity: %s failed, keeping cached history: %s", full_name, e)
                else:
                    if new:
                        cached = [_commit_record(n) for n in new] + cached
                        _write_jsonl(path, cached)
                        log.info("velocity: %s +%d commits", full_name, len(new))
                    elif not path.exists():
                        _write_jsonl(path, [])
                    meta[full_name] = {"pushed_at": r.get("pushed_at")}
            repos.append({"id": full_name, "org": org, "name": r["name"], "private": bool(r.get("private")),
                          "archived": bool(r.get("archived"))})
            commits += [{**c, "project": full_name} for c in cached]
    write_json_atomic(meta_path, meta)
    return repos, commits


def merged_pr_days(cfg: Config, orgs: list[str], first: dt.date, tz: ZoneInfo) -> Counter:
    """{(Org/repo, local date): merged PRs}. Closed months are cached; only the last two are re-queried."""
    gh = GitHub(cfg)
    cache_path = cfg.state_dir / "velocity" / "prs.json"
    cache = read_json(cache_path, {}) or {}
    today = now_utc().date()
    recent = {(today.replace(day=1) - dt.timedelta(days=1)).strftime("%Y-%m"), today.strftime("%Y-%m")}
    out: Counter = Counter()
    for org in orgs:
        m = first.replace(day=1)
        while m <= today:
            key = f"{org}:{m:%Y-%m}"
            nxt = (m.replace(day=28) + dt.timedelta(days=4)).replace(day=1)
            if key not in cache or m.strftime("%Y-%m") in recent:
                try:
                    cache[key] = gh.merged_prs(org, m, nxt - dt.timedelta(days=1))
                except Exception as e:  # noqa: BLE001
                    log.warning("velocity: PR search %s failed: %s", key, e)
            for repo, merged_at in cache.get(key, []):
                out[(f"{org}/{repo}", parse_iso(merged_at).astimezone(tz).date().isoformat())] += 1
            m = nxt
    write_json_atomic(cache_path, cache)
    return out


PATCH_LINES_PER_FILE = 400
PATCH_LINES_PER_COMMIT = 4000


def sync_commit_files(cfg: Config, vcfg: dict, work: list[dict], budget: int | None) -> dict[str, list]:
    """Per-file stats for every counted commit: {oid: [[path, status, additions, deletions], ...]}.

    Fetched once per commit (REST /commits/{sha}) and cached under state/velocity/files. The diff text of
    non-excluded files is kept too (state/velocity/diffs, gzip, truncated) for the change-set judge; it
    never leaves the collector host. `budget` caps fetches per run so a 15-minute timer stays quick.
    """
    import concurrent.futures as cf
    import gzip

    store = cfg.state_dir / "velocity"
    classify = file_classifier(vcfg)
    known: dict[str, list] = {}
    for proj in {c["project"] for c in work}:
        for row in _read_jsonl(store / "files" / (proj.replace("/", "__") + ".jsonl")):
            known[row["oid"]] = row["files"]
    todo = [c for c in reversed(work) if c["oid"] not in known]  # newest first, so recent weeks fill in first
    if budget is not None:
        todo = todo[:budget]
    if not todo:
        return known
    for org in {c["project"].split("/")[0] for c in todo}:
        cfg.app.token(org)  # mint tokens up front; the workers only read them

    gh = GitHub(cfg)

    def fetch(c: dict) -> tuple[dict, list, dict] | None:
        org, repo = c["project"].split("/", 1)
        try:
            res = gh.rest(org, f"/repos/{org}/{repo}/commits/{c['oid']}")
        except Exception as e:  # noqa: BLE001
            log.warning("velocity: files for %s@%s failed: %s", c["project"], c["oid"][:10], e)
            return None
        files, patches, budget_lines = [], {}, PATCH_LINES_PER_COMMIT
        for f in res.get("files") or []:
            files.append([f["filename"], f.get("status", ""), f.get("additions", 0), f.get("deletions", 0)])
            patch = f.get("patch")
            if patch and budget_lines > 0 and classify(f["filename"]) != "excluded":
                lines = patch.splitlines()[:min(PATCH_LINES_PER_FILE, budget_lines)]
                budget_lines -= len(lines)
                patches[f["filename"]] = "\n".join(lines)
        return c, files, patches

    fetched: dict[str, list[dict]] = defaultdict(list)
    with cf.ThreadPoolExecutor(max_workers=6) as pool:
        for res in pool.map(fetch, todo):
            if not res:
                continue
            c, files, patches = res
            known[c["oid"]] = files
            fetched[c["project"]].append({"oid": c["oid"], "files": files})
            if patches:
                d = store / "diffs" / c["project"].replace("/", "__")
                d.mkdir(parents=True, exist_ok=True)
                (d / f"{c['oid']}.json.gz").write_bytes(gzip.compress(json.dumps(patches).encode()))
    for proj, rows in fetched.items():
        path = store / "files" / (proj.replace("/", "__") + ".jsonl")
        _write_jsonl(path, _read_jsonl(path) + rows)
    log.info("velocity: file stats for %d commits (%d still to fetch)", sum(map(len, fetched.values())),
             sum(1 for c in work if c["oid"] not in known))
    return known


GENERATED_DATA_EXT = re.compile(r"\.(json|html?|xml)$", re.I)
DATA_FILE_LINES = 1000       # a json / html / xml file changing this much in one commit is data or generated output
GENERATED_FILE_LINES = 3000  # any file changing this much in one commit is almost certainly generated


def classify_change(path: str, add: int, dele: int, classify: Callable[[str], str]) -> str:
    """Path rules first, then size: hand-written files rarely change by thousands of lines in one commit."""
    cat = classify(path)
    if cat != "excluded" and (add + dele >= GENERATED_FILE_LINES
                              or (GENERATED_DATA_EXT.search(path) and add + dele >= DATA_FILE_LINES)):
        return "excluded"
    return cat


def commit_lines_by_category(files: list, classify: Callable[[str], str]) -> dict[str, list[int]]:
    out: dict[str, list[int]] = {}
    for path, _status, add, dele in files:
        a = out.setdefault(classify_change(path, add, dele, classify), [0, 0])
        a[0] += add
        a[1] += dele
    return out


def collect_velocity(cfg: Config, started: float, full: bool = False, backfill_files: bool = False) -> dict:
    if not cfg.app.enabled:
        raise RuntimeError("velocity needs the GitHub App: set GITHUB_APP_ID and GITHUB_APP_KEY")
    vcfg = {**VELOCITY_DEFAULTS, **cfg.targets.get("velocity", {})}
    tz = ZoneInfo(vcfg["timezone"])
    repos, commits = sync_commit_cache(cfg, vcfg, full=full)

    bots = {b.lower() for b in cfg.targets.get("bot_logins", [])}
    auto_rx = re.compile("|".join(vcfg["automated_message_patterns"]), re.I) if vcfg["automated_message_patterns"] else None
    excluded: Counter = Counter()
    work = []
    for c in commits:
        login = c["login"].lower()
        if c["merge"]:
            excluded["merge_commits"] += 1
        elif login.endswith("[bot]") or login in bots:
            excluded["bot_commits"] += 1
        elif auto_rx and auto_rx.search(c["subj"]):
            excluded["automated_commits"] += 1
        else:
            work.append(c)
    for c in work:
        c["_t"] = parse_iso(c["t"])
    work.sort(key=lambda c: c["_t"])

    # "Your hours": one timeline for everything (one person directing every agent). A session is a run of
    # commits with gaps under session_gap_minutes; its span plus a lead-in is split evenly across its commits.
    gap = dt.timedelta(minutes=vcfg["session_gap_minutes"])
    lead = dt.timedelta(minutes=vcfg["session_lead_minutes"])
    sessions: list[list[dict]] = []
    for c in work:
        if not sessions or c["_t"] - sessions[-1][-1]["_t"] > gap:
            sessions.append([])
        sessions[-1].append(c)
    for i, s in enumerate(sessions):
        share = ((s[-1]["_t"] - s[0]["_t"]) + lead).total_seconds() / 3600 / len(s)
        for c in s:
            c["_h"] = share
            c["_s"] = i

    # Per-file stats → lines by category (code / test / config / docs / excluded) per commit.
    classify = file_classifier(vcfg)
    files = sync_commit_files(cfg, vcfg, work, None if backfill_files else vcfg["file_fetch_budget"])
    for c in work:
        f = files.get(c["oid"])
        c["_cats"] = commit_lines_by_category(f, classify) if f is not None else None

    cap = vcfg["max_lines_per_commit"]
    days: dict[str, dict[str, dict]] = defaultdict(dict)
    for c in work:
        d = c["_t"].astimezone(tz).date().isoformat()
        m = days[d].setdefault(c["project"], dict(EMPTY_DAY))
        m["commits"] += 1
        m["additions"] += min(c["add"], cap)
        m["deletions"] += min(c["del"], cap)
        m["claude"] += 1 if c["claude"] else 0
        m["hours"] += c["_h"]
        if c["_cats"] is not None:
            code = sum(sum(c["_cats"].get(k, [0, 0])) for k in CODE_CATS)
            m["code"] += min(code, cap)
            m["docs"] += min(sum(c["_cats"].get("docs", [0, 0])), cap)
        else:
            m["unclassified"] += 1

    # Change sets: one repo's commits within one working session, roughly what a person would ship as one PR.
    # This is the unit the senior-hours judge scores. Written to the collector host only (subjects are private).
    groups: dict[tuple[int, str], list[dict]] = defaultdict(list)
    for c in work:
        groups[(c["_s"], c["project"])].append(c)
    change_sets = []
    for (_s, proj), cs in sorted(groups.items(), key=lambda kv: kv[1][0]["_t"]):
        cats: dict[str, list[int]] = {}
        for c in cs:
            for k, (a, dl) in (c["_cats"] or {}).items():
                cats.setdefault(k, [0, 0])
                cats[k][0] += a
                cats[k][1] += dl
        local = cs[0]["_t"].astimezone(tz).date()
        change_sets.append({
            "id": f"{proj}@{cs[0]['oid'][:10]}", "project": proj, "date": local.isoformat(),
            "week": monday(local).isoformat(), "start": cs[0]["t"], "end": cs[-1]["t"],
            "commits": [c["oid"] for c in cs], "claude": sum(1 for c in cs if c["claude"]),
            "lines": cats, "complete": all(c["_cats"] is not None for c in cs),
            "subjects": [c["subj"] for c in cs],
        })
        days[local.isoformat()].setdefault(proj, dict(EMPTY_DAY))["sets"] += 1
    _write_jsonl(cfg.state_dir / "velocity" / "change_sets.jsonl", change_sets)
    classified = sum(1 for c in work if c["_cats"] is not None)

    # Senior-engineer-equivalent hours from the judge (collector/judge.py), for sets judged under the current
    # prompt version and with the same commits as now. Unjudged sets add nothing; "judged" shows coverage.
    judge_meta = None
    jpath = cfg.state_dir / "velocity" / "judgments.jsonl"
    if jpath.exists() and vcfg["publish_senior"]:
        if str(HERE) not in sys.path:  # judge.py sits next to this file; python -I leaves it off the path
            sys.path.insert(0, str(HERE))
        import judge as _judge  # imported lazily so the collector runs without it
        by_id = {cs["id"]: cs for cs in change_sets}
        judged = _judge.current(_read_jsonl(jpath), by_id)
        for cs_id, j in judged.items():
            m = days[by_id[cs_id]["date"]].setdefault(by_id[cs_id]["project"], dict(EMPTY_DAY))
            m["senior"] += j["hours_likely"]
            m["senior_low"] += j["hours_low"]
            m["senior_high"] += j["hours_high"]
            m["judged"] += 1
        eligible = [cs for cs in change_sets if cs["complete"]]
        judge_meta = {
            "prompt_version": _judge.PROMPT_VERSION,
            "models": sorted({mdl for j in judged.values() for mdl in j.get("models", [])}),
            "judged_sets": len(judged), "total_sets": len(eligible),
            "first_judged_date": min((by_id[i]["date"] for i in judged), default=None),
        }

    active_orgs = sorted({r["org"] for r in repos})
    if work:
        first_day = work[0]["_t"].astimezone(tz).date()
        tracked = {r["id"] for r in repos}
        for (proj, d), n in merged_pr_days(cfg, active_orgs, first_day, tz).items():
            if proj in tracked:
                days[d].setdefault(proj, dict(EMPTY_DAY))["prs"] += n
    for by in days.values():
        for m in by.values():
            for k in ("hours", "senior", "senior_low", "senior_high"):
                m[k] = round(m[k], 2)

    with_work = {p for by in days.values() for p in by}  # commits or merged PRs
    org_cfg = {o["id"]: o for o in cfg.orgs}
    orgs_out = []
    for i, org in enumerate(active_orgs):
        o = org_cfg.get(org, {})
        orgs_out.append({"id": org, "name": o.get("name", org), "color": o.get("color", ORG_PALETTE[i % len(ORG_PALETTE)]),
                         **({"description": o["description"]} if o.get("description") else {})})
    prev = read_json(cfg.data_dir / "velocity.json", {}) or {}
    return {
        "schema_version": VELOCITY_SCHEMA_VERSION,
        "generated_at": iso(now_utc()),
        "collector": collector_meta(cfg, started),
        "method": {
            "timezone": vcfg["timezone"],
            "your_hours": (f"Session-based: commits less than {vcfg['session_gap_minutes']} min apart form one working session; "
                           f"a session counts its span plus {vcfg['session_lead_minutes']} min of lead-in. One timeline for "
                           "everything, since one person directs every agent."),
            "lines": f"Lines added and deleted per commit, capped at {cap:,} each so generated or vendored commits can't swamp the totals.",
            "code_lines": ("Code lines count source, tests and config (added + deleted), from per-file stats. Lockfiles, generated "
                           "and vendored files, data, fixtures and binaries are left out, as is any JSON/HTML/XML file changing by "
                           f"{DATA_FILE_LINES:,}+ lines or any file changing by {GENERATED_FILE_LINES:,}+ lines in one commit; "
                           "docs are counted separately."),
            "change_sets": "A change set is one repo's commits within one working session: the unit the senior-hours judge scores.",
            "senior_hours": ("Senior-engineer-equivalent hours: for each change set, Claude reads the commit messages, file list and "
                             "code diff and estimates how long one senior engineer, familiar with the codebase, would have needed "
                             "before AI coding tools (design, code, tests, debugging; not meetings or waiting). The median is shown "
                             "with an 80% range. AI verbosity is credited at a senior's speed, not per line."),
            "sources": "Default-branch history of every repo the Watchtower GitHub App can read; merge, bot and automated "
                       "data commits excluded; merged PRs from GitHub search.",
        },
        "file_coverage": round(classified / len(work), 4) if work else 1.0,
        "judge": judge_meta,
        "excluded": {**{k: excluded.get(k, 0) for k in ("merge_commits", "bot_commits", "automated_commits")},
                     "repos": sorted(vcfg["exclude_repos"])},
        "orgs": orgs_out,
        "projects": [r for r in repos if r["id"] in with_work],
        "days": [{"date": d, "by_project": days[d]} for d in sorted(days)],
        # Sprints are planned by hand: from the config, or kept from the last real (non-mock) file.
        "sprints": cfg.targets.get("sprints") or ([] if (prev.get("collector") or {}).get("mock") else prev.get("sprints", [])),
    }


CHANGE_TYPES = {"feature", "fix", "perf", "infra", "security", "docs", "breaking"}


def classify_release(rel: dict) -> str:
    text = f"{rel.get('name') or ''} {rel.get('body') or ''}".lower()
    for t, words in [("breaking", ["breaking"]), ("security", ["security", "cve", "rotate"]), ("fix", ["fix", "bug"]),
                     ("perf", ["perf", "faster", "speed"]), ("infra", ["infra", "terraform", "deploy"]), ("docs", ["docs", "readme"])]:
        if any(w in text for w in words):
            return t
    return "feature"


def collect_changelog(cfg: Config, started: float) -> dict:
    gh = GitHub(cfg)
    entries = []
    for p in cfg.projects:
        if not p.get("publish_releases", True):
            continue  # private repo whose notes shouldn't be public
        org, repo = p["repo"].split("/", 1)
        for r in gh.releases(org, repo):
            if r.get("draft"):
                continue
            body = (r.get("body") or "").strip()
            entries.append({
                "id": f"{p['id']}-{r['tag_name']}",
                "date": (r.get("published_at") or r["created_at"])[:10],
                "project": p["id"], "org": org, "repo": p["repo"], "version": r["tag_name"],
                "type": classify_release(r),
                "title": r.get("name") or r["tag_name"],
                "body": body.splitlines()[0][:280] if body else None,
                "url": r.get("html_url"),
            })
    entries.sort(key=lambda e: e["date"], reverse=True)
    return {"schema_version": SCHEMA_VERSION, "generated_at": iso(now_utc()), "collector": collector_meta(cfg, started),
            "orgs": cfg.orgs, "entries": entries[:200]}


def collect_roadmap(cfg: Config, started: float) -> dict:
    """Roadmap items are opt-in: only issues with the publish label appear (default `watchtower:roadmap`).

    Status comes from labels `status:in-progress` / `status:planned`; closed issues are shipped.
    Priority from `P0`..`P3` labels; progress from a `progress:NN` label.
    """
    gh = GitHub(cfg)
    label = cfg.targets.get("roadmap_label", "watchtower:roadmap")
    items = []
    milestones: dict[str, dict] = {}
    for p in cfg.projects:
        org, repo = p["repo"].split("/", 1)
        for i in gh.roadmap_issues(org, repo, label):
            if "pull_request" in i:
                continue
            labels = {lb["name"] for lb in i.get("labels", [])}
            status = "shipped" if i["state"] == "closed" else "in_progress" if "status:in-progress" in labels else "planned"
            prio = next((x for x in ("P0", "P1", "P2", "P3") if x in labels), "P2")
            prog = next((int(x.split(":")[1]) for x in labels if re.fullmatch(r"progress:\d{1,3}", x)), 100 if status == "shipped" else 0)
            ms = i.get("milestone") or {}
            ms_id = f"{org}/{ms['title']}" if ms else "unscheduled"
            if ms:
                milestones.setdefault(ms_id, {"id": ms_id, "title": ms["title"], "target": (ms.get("due_on") or "")[:10]})
            target = ((i.get("closed_at") if status == "shipped" else ms.get("due_on")) or i["updated_at"])[:10]
            items.append({
                "id": f"{p['id']}#{i['number']}", "title": i["title"], "project": p["id"], "org": org,
                "status": status, "milestone": ms_id, "priority": prio, "target": target, "progress": prog,
                "tags": sorted(x for x in labels if not re.match(r"^(P\d|status:|progress:|watchtower:)", x)),
                "url": i["html_url"],
            })
    if any(i["milestone"] == "unscheduled" for i in items):
        milestones["unscheduled"] = {"id": "unscheduled", "title": "Unscheduled", "target": ""}
    return {"schema_version": SCHEMA_VERSION, "generated_at": iso(now_utc()), "collector": collector_meta(cfg, started),
            "orgs": cfg.orgs, "milestones": sorted(milestones.values(), key=lambda m: m["target"] or "9999"), "items": items}


# ---------------------------------------------------------------------------------------------
# Health checks (HTTP / TCP / ping / heartbeat file) + Proxmox node stats
# ---------------------------------------------------------------------------------------------


def check_http(target: str, timeout: float, expect: int | None = None) -> tuple[bool, float | None, str]:
    t0 = time.monotonic()
    try:
        req = urllib.request.Request(target, headers={"User-Agent": f"fgl-watchtower-healthcheck/{VERSION}"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            code = r.status
    except urllib.error.HTTPError as e:
        code = e.code
    except Exception as e:  # noqa: BLE001 - any failure means down
        return False, None, type(e).__name__
    ms = (time.monotonic() - t0) * 1000
    ok = code == expect if expect else 200 <= code < 400
    return ok, ms, f"HTTP {code}"


def check_tcp(target: str, timeout: float) -> tuple[bool, float | None, str]:
    host, port = target.rsplit(":", 1)
    t0 = time.monotonic()
    try:
        with socket.create_connection((host, int(port)), timeout=timeout):
            return True, (time.monotonic() - t0) * 1000, "connected"
    except OSError as e:
        return False, None, type(e).__name__


def check_ping(target: str, timeout: float) -> tuple[bool, float | None, str]:
    try:
        out = subprocess.run(["ping", "-c", "1", "-W", str(int(timeout)), target], capture_output=True, text=True, timeout=timeout + 2)
    except (subprocess.TimeoutExpired, FileNotFoundError) as e:
        return False, None, type(e).__name__
    m = re.search(r"time=([\d.]+) ms", out.stdout)
    return out.returncode == 0, float(m.group(1)) if m else None, "icmp"


def check_heartbeat(target: str, max_age_min: float) -> tuple[bool, float | None, str]:
    """A cron job touches a file when it finishes; down if the file is older than max_age_min."""
    try:
        age = (time.time() - os.path.getmtime(target)) / 60
    except OSError:
        return False, None, "missing"
    return age <= max_age_min, 0.0, f"{age:.0f} min old"


def run_check(cfg: Config, svc: dict) -> tuple[str, float | None, str]:
    kind, target = svc["check"], svc["target"]
    if kind == "http":
        ok, ms, detail = check_http(target, cfg.http_timeout, svc.get("expect_status"))
    elif kind == "tcp":
        ok, ms, detail = check_tcp(target, cfg.http_timeout)
    elif kind == "ping":
        ok, ms, detail = check_ping(target, cfg.http_timeout)
    elif kind == "heartbeat":
        ok, ms, detail = check_heartbeat(target, svc.get("max_age_minutes", 180))
    else:
        raise ValueError(f"unknown check type {kind!r} for {svc['id']}")
    if not ok:
        return "OFFLINE", None, detail
    threshold = svc.get("degraded_ms", cfg.degraded_ms)
    status = "DEGRADED" if ms is not None and ms > threshold else "ONLINE"
    return status, round(ms) if ms is not None else None, detail


def pve_nodes(cfg: Config) -> list[dict]:
    """Node stats from the Proxmox API token if configured, else from `pvesh` on this host."""
    raw: list[dict] = []
    if cfg.pve_api_url and cfg.pve_token_id:
        ctx = None if cfg.pve_verify_tls else ssl._create_unverified_context()  # self-signed PVE cert
        hdr = {"Authorization": f"PVEAPIToken={cfg.pve_token_id}={cfg.pve_token_secret}"}
        base = cfg.pve_api_url.rstrip("/")
        nodes = http_json(f"{base}/nodes", headers=hdr, context=ctx)["data"]
        version = http_json(f"{base}/version", headers=hdr, context=ctx)["data"].get("release", "")
        for n in nodes:
            guests = []
            for kind in ("lxc", "qemu"):
                try:
                    guests += http_json(f"{base}/nodes/{n['node']}/{kind}", headers=hdr, context=ctx)["data"]
                except Exception:  # noqa: BLE001
                    pass
            raw.append({**n, "_guests": guests, "_version": version})
    else:
        try:
            nodes = json.loads(subprocess.run(["pvesh", "get", "/nodes", "--output-format", "json"],
                                              capture_output=True, text=True, check=True, timeout=30).stdout)
            version = json.loads(subprocess.run(["pvesh", "get", "/version", "--output-format", "json"],
                                                capture_output=True, text=True, check=True, timeout=30).stdout).get("release", "")
        except (FileNotFoundError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as e:
            log.warning("proxmox: no API token and pvesh unavailable (%s); node stats skipped", type(e).__name__)
            return []
        for n in nodes:
            guests = []
            for kind in ("lxc", "qemu"):
                try:
                    guests += json.loads(subprocess.run(["pvesh", "get", f"/nodes/{n['node']}/{kind}", "--output-format", "json"],
                                                        capture_output=True, text=True, check=True, timeout=30).stdout)
                except Exception:  # noqa: BLE001
                    pass
            raw.append({**n, "_guests": guests, "_version": version})

    meta = {m["id"]: m for m in cfg.targets.get("nodes", [])}
    out = []
    for n in raw:
        m = meta.get(n["node"], {})
        gb, tb = 1024 ** 3, 1024 ** 4
        out.append({
            "id": n["node"], "name": n["node"], "role": m.get("role", ""), "cpu": m.get("cpu", f"{n.get('maxcpu', '?')} vCPU"),
            "cpu_pct": round(n.get("cpu", 0) * 100, 1),
            "mem_used_gb": round(n.get("mem", 0) / gb, 1), "mem_total_gb": round(n.get("maxmem", 0) / gb),
            "disk_used_tb": round(n.get("disk", 0) / tb, 2), "disk_total_tb": round(n.get("maxdisk", 0) / tb, 2),
            "uptime_days": int(n.get("uptime", 0) // 86400),
            "guests_running": sum(1 for g in n["_guests"] if g.get("status") == "running"),
            "guests_total": len(n["_guests"]), "pve_version": n["_version"],
        })
    return sorted(out, key=lambda x: x["id"])


def collect_health(cfg: Config, started: float) -> dict:
    """Run every check and fold the result into rolling state (streaks, 30-day uptime, recent history).

    Check targets (LAN IPs, internal hostnames) stay in the config and state file and are never
    written to data/health.json, which is public.
    """
    state_path = cfg.state_dir / "health_state.json"
    state: dict[str, dict] = read_json(state_path, {}) or {}
    t = now_utc()
    cutoff = t - dt.timedelta(days=30)
    services = []
    for svc in cfg.targets.get("services", []):
        status, ms, detail = run_check(cfg, svc)
        st = state.setdefault(svc["id"], {"samples": [], "last_change": iso(t), "last_status": status, "online_since": None})
        st["samples"] = [s for s in st["samples"] if parse_iso(s[0]) >= cutoff] + [[iso(t), status]]
        if st["last_status"] != status:
            st["last_change"] = iso(t)
        st["last_status"] = status
        if status == "ONLINE":
            st["online_since"] = st["online_since"] or iso(t)
        else:
            st["online_since"] = None
        up = sum(1 for _, s in st["samples"] if s != "OFFLINE") / len(st["samples"])
        streak_h = int((t - parse_iso(st["online_since"])).total_seconds() // 3600) if st["online_since"] else 0
        services.append({
            "id": svc["id"], "name": svc["name"], "org": svc["org"], "project": svc.get("project"),
            "kind": svc["kind"], "host": svc.get("host_label", ""), "public_url": svc.get("public_url"),
            "check": svc["check"], "status": status, "latency_ms": ms,
            "uptime_streak_hours": streak_h, "uptime_30d_pct": round(up * 100, 2),
            "last_checked": iso(t), "last_change": st["last_change"],
            "history": [s for _, s in st["samples"][-cfg.history_len:]],
            "notes": svc.get("notes") if status == "ONLINE" else (svc.get("notes") or detail),
        })
        log.info("health: %-24s %-8s %s", svc["id"], status, detail)
    write_json_atomic(state_path, state)

    try:
        nodes = pve_nodes(cfg)
    except Exception as e:  # noqa: BLE001
        log.warning("proxmox node stats failed: %s", e)
        nodes = []
    if not nodes:  # keep the last known node cards rather than blanking them
        nodes = (read_json(cfg.data_dir / "health.json", {}) or {}).get("nodes", [])
    return {"schema_version": SCHEMA_VERSION, "generated_at": iso(t), "collector": collector_meta(cfg, started),
            "orgs": cfg.orgs, "nodes": nodes, "services": services}


# ---------------------------------------------------------------------------------------------
# AI usage log parser
# ---------------------------------------------------------------------------------------------

TASK_RULES = [
    ("tests", r"\b(tests?|pytest|vitest|coverage)\b"),
    ("pr review", r"\b(review|pr #?\d+|pull request)\b"),
    ("docs + diagrams", r"\b(docs?|readme|diagram|mermaid|changelog)\b"),
    ("ops / deploy", r"\b(deploy|docker|compose|ci|workflow|terraform|systemd|lxc)\b"),
    ("debugging", r"\b(fix|bug|error|broken|fails?|traceback|crash)\b"),
    ("refactor", r"\b(refactor|rename|clean ?up|simplify)\b"),
]


def classify_task(prompt: str) -> str:
    p = prompt.lower()
    for cat, rx in TASK_RULES:
        if re.search(rx, p):
            return cat
    return "code generation"


def parse_worker_logs(pattern: str, since: dt.datetime) -> list[dict]:
    """Worker-pool job logs, one JSON object per line:

    {"ts": "...Z", "project": "polyedge", "model": "claude-sonnet-5-5", "provider": "...",
     "tokens_in": 1234, "tokens_out": 210, "status": "ok"|"error", "job": "market summarization"}
    """
    rows = []
    for f in sorted(glob.glob(os.path.expanduser(pattern))):
        with open(f, encoding="utf-8", errors="replace") as fh:
            for line in fh:
                try:
                    r = json.loads(line)
                    if parse_iso(r["ts"]) >= since:
                        rows.append(r)
                except (json.JSONDecodeError, KeyError, ValueError):
                    continue
    return rows


def parse_agent_sessions(label: str, root: str, since: dt.datetime, project_map: dict[str, str]) -> list[dict]:
    """Claude Code transcripts (~/.claude/projects/*/*.jsonl). One file is one session.

    Reads only timestamps, cwd, token usage and the first user prompt (for a rough task category).
    Prompt text is never written out.
    """
    sessions = []
    for f in glob.glob(os.path.join(os.path.expanduser(root), "*", "*.jsonl")):
        if os.path.getmtime(f) < since.timestamp():
            continue
        first_ts = last_ts = None
        tokens = 0
        cwd = ""
        first_prompt = ""
        with open(f, encoding="utf-8", errors="replace") as fh:
            for line in fh:
                try:
                    r = json.loads(line)
                except json.JSONDecodeError:
                    continue
                ts = r.get("timestamp")
                if ts:
                    first_ts = first_ts or ts
                    last_ts = ts
                cwd = cwd or r.get("cwd", "")
                msg = r.get("message") or {}
                usage = msg.get("usage") or {}
                tokens += sum(usage.get(k, 0) or 0 for k in ("input_tokens", "output_tokens", "cache_creation_input_tokens"))
                if not first_prompt and r.get("type") == "user":
                    c = msg.get("content")
                    first_prompt = c if isinstance(c, str) else " ".join(x.get("text", "") for x in c or [] if isinstance(x, dict))
        if not first_ts or parse_iso(first_ts) < since:
            continue
        hours = (parse_iso(last_ts) - parse_iso(first_ts)).total_seconds() / 3600
        project = next((pid for key, pid in project_map.items() if key in cwd), "other")
        sessions.append({"agent": label, "start": first_ts, "hours": min(hours, 12), "tokens": tokens,
                         "project": project, "category": classify_task(first_prompt)})
    return sessions


def collect_ai_usage(cfg: Config, started: float) -> dict:
    t = now_utc()
    since = t - dt.timedelta(days=30)
    ai_cfg = cfg.targets.get("ai", {})
    prev = read_json(cfg.data_dir / "ai_usage.json", {}) or {}

    # In-app / production
    jobs = []
    for pattern in ai_cfg.get("worker_log_globs", []):
        jobs += parse_worker_logs(pattern, since)
    daily: dict[str, dict] = {}
    for i in range(30):
        d = (since + dt.timedelta(days=i + 1)).date().isoformat()
        daily[d] = {"date": d, "api_calls": 0, "tokens_in": 0, "tokens_out": 0, "pipeline_runs": 0}
    by_model: dict[str, dict] = {}
    by_app: dict[str, dict] = {}
    failed = 0
    for j in jobs:
        d = j["ts"][:10]
        row = daily.setdefault(d, {"date": d, "api_calls": 0, "tokens_in": 0, "tokens_out": 0, "pipeline_runs": 0})
        ti, to = int(j.get("tokens_in", 0)), int(j.get("tokens_out", 0))
        row["api_calls"] += 1
        row["tokens_in"] += ti
        row["tokens_out"] += to
        row["pipeline_runs"] += 1 if j.get("pipeline_run") else 0
        failed += 1 if j.get("status") == "error" else 0
        m = by_model.setdefault(j.get("model", "unknown"), {"model": j.get("model", "unknown"), "provider": j.get("provider", ""),
                                                             "api_calls": 0, "tokens_in": 0, "tokens_out": 0})
        m["api_calls"] += 1
        m["tokens_in"] += ti
        m["tokens_out"] += to
        a = by_app.setdefault(j.get("project", "unknown"), {"project": j.get("project", "unknown"), "api_calls": 0, "tokens": 0,
                                                             "pipeline_runs": 0, "_jobs": defaultdict(int)})
        a["api_calls"] += 1
        a["tokens"] += ti + to
        a["pipeline_runs"] += 1 if j.get("pipeline_run") else 0
        a["_jobs"][j.get("job", "job")] += 1
    apps = []
    for a in sorted(by_app.values(), key=lambda x: -x["api_calls"]):
        top = [k for k, _ in sorted(a.pop("_jobs").items(), key=lambda kv: -kv[1])[:3]]
        apps.append({**a, "top_jobs": top})
    days = sorted(daily.values(), key=lambda r: r["date"])[-30:]
    cost_per_mtok = ai_cfg.get("metered_cost_per_mtok", {})  # only metered providers; subscriptions are $0 marginal
    est_cost = sum((m["tokens_in"] + m["tokens_out"]) / 1e6 * cost_per_mtok.get(m["model"], 0) for m in by_model.values())

    production = {
        "note": ai_cfg.get("production_note", "Apps queue jobs on the shared worker pool; no app server holds an LLM key."),
        "totals": {"api_calls": len(jobs), "tokens_in": sum(r["tokens_in"] for r in days), "tokens_out": sum(r["tokens_out"] for r in days),
                   "pipeline_runs": sum(r["pipeline_runs"] for r in days), "failed_runs": failed, "est_cost_usd": round(est_cost, 2)},
        "by_model": sorted(by_model.values(), key=lambda m: -m["api_calls"]),
        "by_app": apps,
        "daily": days,
    } if jobs else prev.get("production")

    # Engineering / coding agents
    sessions = []
    project_map = ai_cfg.get("cwd_project_map", {})
    for src in ai_cfg.get("agent_transcript_dirs", []):
        sessions += parse_agent_sessions(src["label"], src["path"], t - dt.timedelta(weeks=12), project_map)
    if sessions:
        recent = [s for s in sessions if parse_iso(s["start"]) >= since]
        agents: dict[str, dict] = {}
        for s in recent:
            a = agents.setdefault(s["agent"], {"agent": s["agent"], "kind": "cloud", "sessions": 0, "hours": 0.0, "tokens": 0})
            a["sessions"] += 1
            a["hours"] = round(a["hours"] + s["hours"], 1)
            a["tokens"] += s["tokens"]
        for src in ai_cfg.get("agent_transcript_dirs", []):
            if src.get("kind") == "local" and src["label"] in agents:
                agents[src["label"]]["kind"] = "local"
        proj = defaultdict(int)
        for s in recent:
            proj[s["project"]] += 1
        cats = ["code generation"] + [c for c, _ in TASK_RULES]
        weekly: dict[str, dict] = {}
        for s in sessions:
            wk = monday(parse_iso(s["start"]).date()).isoformat()
            w = weekly.setdefault(wk, {"week_start": wk, "sessions": 0, "by_category": {c: 0 for c in cats}})
            w["sessions"] += 1
            w["by_category"][s["category"]] += 1
        manual = ai_cfg.get("engineering_manual_totals", {})  # PR / commit counts you track elsewhere
        engineering = {
            "note": "Sessions counted from coding-agent transcripts on each host; hours are wall-clock session time.",
            "totals": {"sessions": len(recent), "hours": round(sum(s["hours"] for s in recent), 1),
                       "prs_opened_with_ai": manual.get("prs_opened_with_ai", 0), "prs_reviewed_by_ai": manual.get("prs_reviewed_by_ai", 0),
                       "commits_co_authored": manual.get("commits_co_authored", 0)},
            "by_agent": sorted(agents.values(), key=lambda a: -a["sessions"]),
            "by_project": [{"project": k, "share": round(v / len(recent), 3)} for k, v in sorted(proj.items(), key=lambda kv: -kv[1])] if recent else [],
            "weekly": [weekly[k] for k in sorted(weekly)][-12:],
            "highlights": ai_cfg.get("highlights", []),
        }
    else:
        engineering = prev.get("engineering")

    if production is None or engineering is None:
        raise RuntimeError("no AI sources configured or found, and no previous ai_usage.json to keep")
    return {"schema_version": SCHEMA_VERSION, "generated_at": iso(t), "collector": collector_meta(cfg, started),
            "period": {"from": days[0]["date"] if jobs else prev.get("period", {}).get("from"), "to": t.date().isoformat()},
            "production": production, "engineering": engineering}


# ---------------------------------------------------------------------------------------------
# Git publish
# ---------------------------------------------------------------------------------------------


def git(cfg: Config, *args: str, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(["git", "-C", str(cfg.repo_dir), *args], capture_output=True, text=True, check=check)


def strip_volatile(obj: Any) -> Any:
    """Fields that change every run. Used to tell a real change from a timestamp bump."""
    if isinstance(obj, dict):
        return {k: strip_volatile(v) for k, v in obj.items()
                if k not in {"generated_at", "collector", "last_checked", "latency_ms", "duration_ms", "uptime_streak_hours",
                             "uptime_30d_pct", "history", "cpu_pct", "mem_used_gb", "uptime_days"}}
    if isinstance(obj, list):
        return [strip_volatile(x) for x in obj]
    return obj


def publish(cfg: Config, changed: list[str], significant: bool, push: bool) -> None:
    """Commit data/ and push. Skips the commit when only volatile fields moved and the last data
    commit is newer than SYNC_HEARTBEAT_MINUTES, so a healthy lab doesn't spam a deploy every run.
    """
    if not changed:
        log.info("publish: nothing changed")
        return
    if not significant:
        last = git(cfg, "log", "-1", "--format=%ct", "--", "data/", check=False).stdout.strip()
        age_min = (time.time() - int(last)) / 60 if last else 1e9
        if age_min < cfg.heartbeat_minutes:
            log.info("publish: only volatile fields changed, last data commit %.0f min ago; skipping commit", age_min)
            git(cfg, "checkout", "--", *[f"data/{f}" for f in changed], check=False)
            return
    name, email = re.match(r"(.*)<(.*)>", cfg.git_author).groups()  # type: ignore[union-attr]
    git(cfg, "add", "--", *[f"data/{f}" for f in changed])
    msg = f"data: sync {', '.join(f.removesuffix('.json') for f in changed)} from {cfg.node_name}"
    git(cfg, "-c", f"user.name={name.strip()}", "-c", f"user.email={email.strip()}", "commit", "-m", msg)
    log.info("publish: committed %s", msg)
    if push:
        git(cfg, "pull", "--rebase", "--autostash", cfg.git_remote, cfg.git_branch)
        git(cfg, "push", cfg.git_remote, f"HEAD:{cfg.git_branch}")
        log.info("publish: pushed to %s/%s", cfg.git_remote, cfg.git_branch)


# ---------------------------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------------------------

MODULES: dict[str, tuple[str, Callable[[Config, float], dict]]] = {
    "health": ("health.json", collect_health),
    "velocity": ("velocity.json", collect_velocity),
    "changelog": ("changelog.json", collect_changelog),
    "roadmap": ("roadmap.json", collect_roadmap),
    "ai": ("ai_usage.json", collect_ai_usage),
}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--only", help="comma list of modules: " + ",".join(MODULES))
    ap.add_argument("--dry-run", action="store_true", help="collect and print a summary; write nothing")
    ap.add_argument("--no-push", action="store_true", help="commit locally but do not push")
    ap.add_argument("--no-git", action="store_true", help="write data files only")
    ap.add_argument("--full-resync", action="store_true", help="velocity: re-read every repo's history from scratch")
    ap.add_argument("--backfill-files", action="store_true", help="velocity: fetch per-file stats for every commit (no per-run cap)")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    cfg = Config()
    wanted = args.only.split(",") if args.only else list(MODULES)
    changed, significant, failures = [], False, []
    for name in wanted:
        if name not in MODULES:
            log.error("unknown module %s", name)
            return 2
        fname, fn = MODULES[name]
        started = time.monotonic()
        try:
            if name == "velocity":
                new = collect_velocity(cfg, started, full=args.full_resync, backfill_files=args.backfill_files)
            else:
                new = fn(cfg, started)
        except Exception as e:  # noqa: BLE001 - keep the old file, carry on with the rest
            log.error("%s failed, keeping previous %s: %s", name, fname, e)
            failures.append(name)
            continue
        path = cfg.data_dir / fname
        old = read_json(path)
        if old == new:
            continue
        if strip_volatile(old) != strip_volatile(new) or (old or {}).get("collector", {}).get("mock"):
            significant = True
        if args.dry_run:
            log.info("dry-run: %s would change (significant=%s)", fname, strip_volatile(old) != strip_volatile(new))
            continue
        write_json_atomic(path, new)
        changed.append(fname)

    if not args.dry_run and not args.no_git:
        try:
            publish(cfg, changed, significant, push=not args.no_push)
        except subprocess.CalledProcessError as e:
            log.error("git failed: %s %s", e.cmd, e.stderr.strip())
            return 1
    return 1 if failures and len(failures) == len(wanted) else 0


if __name__ == "__main__":
    sys.exit(main())

# FGL Watchtower

Live at **https://futuregadgetlabs-watchtower.github.io/**. Repo:
`FutureGadgetLabs-Watchtower/futuregadgetlabs-watchtower.github.io`, the org's root Pages site.

Future Gadget Labs Watchtower: a static command center for the FGL ecosystem. It covers health,
engineering velocity, homelab architecture, the roadmap and patch notes, and AI usage.

The site is a static build on GitHub Pages and makes **no runtime API calls**. Everything it shows
is read at build time from `/data`. A collector on a Proxmox node refreshes `/data` and pushes, and
the push triggers a rebuild. When the homelab is off, the site keeps serving the last push. The
header then switches to **CACHED**, and any service not checked in 24 h shows **STALE**.

```
futuregadgetlabs-watchtower.github.io/
├── .github/workflows/deploy.yml      build + deploy to Pages on every push to main
├── data/                             the only data source for the site
│   ├── health.json                   services, Proxmox nodes, status history
│   ├── velocity.json                 per-week, per-repo commits / PRs / lines / est. hours, sprints
│   ├── changelog.json                release notes across orgs
│   ├── roadmap.json                  milestones + in_progress / planned / shipped items
│   ├── ai_usage.json                 in-app (worker pool) + engineering-agent usage
│   └── architecture.md               prose, tables and ```mermaid diagrams
├── collector/
│   ├── sync_watchtower.py            stdlib-only Python collector (runs on a PVE node)
│   ├── .env.example                  tokens, PVE API, git settings → copy to .env
│   ├── watchtower.config.example.json  orgs, repos, check targets, AI log paths → copy to watchtower.config.json
│   └── systemd/                      .service + .timer (every 15 min)
├── scripts/validate-data.mjs         CI gate: malformed data fails the build, last good deploy stays up
├── src/
│   ├── data.ts                       imports /data/* (bundled at build time)
│   ├── types.ts                      the schemas for every /data file
│   ├── components/                   Header (sync indicator), Mermaid, charts, ui primitives
│   ├── views/                        Health, Velocity, Architecture, Roadmap, AiUsage
│   └── lib/                          formatting, STALE logic, hash router
├── index.html · vite.config.ts · tsconfig.json · package.json
```

Stack: Vite, React 19, TypeScript, Tailwind v4, Recharts, Mermaid (lazy-loaded), marked.

## Develop

```sh
npm install
npm run dev            # http://localhost:5173
npm run build          # typecheck + static build into dist/
npm run validate-data  # what CI runs before building
```

Routes are hash-based (`#/health`, `#/velocity`, `#/architecture`, `#/roadmap`, `#/ai`), so deep
links work on Pages without a 404 fallback.

The files in `/data` are **sample data**: their `collector.mock` is `true`, and the site shows a
SAMPLE DATA banner until the collector's first real run replaces them. The sample timestamps are
from 2026-11-26, so a day later the header reads CACHED and the services read STALE. That is the
offline behavior working as intended.

## Data contract

`src/types.ts` defines each file's schema. Every file carries `schema_version`, `generated_at` and
`collector { host, version, run_id, duration_ms, mock }`. The header shows the newest
`generated_at`, and hovering it shows the oldest. Rules worth knowing:

- **Status** is `ONLINE | DEGRADED | OFFLINE` in the file. `STALE` is derived in the browser from
  `last_checked`, so it appears even when nothing new is pushed.
- **health.json is public.** Check targets (LAN hosts, ports, file paths) stay in
  `collector/watchtower.config.json`, which is gitignored. Only `name`, `host_label` and
  `public_url` are published. `validate-data` fails the build if a private IP appears in
  `health.json`.
- **Roadmap is opt-in.** Only issues labelled `watchtower:roadmap` are published, so private
  `backlog` issues stay private. Status comes from `status:in-progress` or `status:planned`;
  closed issues count as shipped. Priority comes from `P0`..`P3`, and progress from `progress:NN`.
- **Release notes** come from GitHub Releases. Set `publish_releases: false` on a repo in the
  config to keep its notes off the site.
- **Velocity is counts only.** `velocity.json` holds per-day, per-repo totals: commits, code lines,
  change sets, merged PRs, your hours and senior-equivalent hours. Commit messages, author emails,
  diffs and the judge's write-ups stay in `collector/state/velocity/` on the collector host.
- **Sprints** in `velocity.json` are kept as you write them. The collector does not overwrite
  them unless `sprints` is set in the config.
- **Engineering AI usage** reads only timestamps, cwd, token counts and a task category from
  Claude Code transcripts. The category is guessed from keywords in the first prompt. Prompt text
  is never written out.

## Velocity and the senior-hours judge

Velocity reads every repo the **Watchtower GitHub App** can see. Set `GITHUB_APP_ID` and
`GITHUB_APP_KEY` (the `.pem`). The `velocity` block in `watchtower.config.json` sets the timezone,
the excluded orgs and repos, and the session rules.

1. **Commits** are cached per repo in `state/velocity/commits/`. A repo is re-read only when its
   `pushed_at` moves.
2. **Per-file stats** for each counted commit go to `state/velocity/files/`, and non-excluded diff
   text goes to `state/velocity/diffs/`. Each run fetches up to 600 commits; the first time, run
   `--backfill-files` instead.
3. **Files are classified** as code, test, config, docs or excluded (`FILE_RULES`, plus size rules
   for data and generated files). Code lines count code, test and config.
4. **Change sets** are one repo's commits within one working session. They are written to
   `state/velocity/change_sets.jsonl`.
5. **The judge** (`collector/judge.py`) asks Claude, through the `claude` CLI on the host, how many
   hours one senior engineer would have needed for each change set before AI. Results go to
   `state/velocity/judgments.jsonl`, and the collector adds them up per day as `senior` (median),
   `senior_low` and `senior_high` (80% range).

```sh
python3 collector/judge.py calibration-sheet      # 18 change sets for you to score blind
python3 collector/judge.py calibration-report     # your scores vs the judge's
python3 collector/judge.py run                    # judge everything not yet judged, newest first
python3 collector/judge.py run --since 2026-11-01 --limit 50
python3 collector/judge.py prompt <change-set-id> # see exactly what the judge sees
```

- **Account:** by default the judge uses the Claude login of the user it runs as (or
  `JUDGE_CLAUDE_CONFIG_DIR`). With `--ssh-host agent2` (or `JUDGE_SSH_HOST`) only the `claude` call
  runs on that host, under that host's login; the prompt goes over stdin and nothing is copied there.
  On agent1, the default login is shared with the agent1 workers. Don't run the back-fill on it.
- **Budget:** each change set is about 30k tokens. After every judgment the judge reads the
  account's usage meter and stops once the 5-hour window passes 60% (`--max-five-hour`) or the
  7-day window passes 80% (`--max-seven-day`). That leaves headroom for whatever else uses the
  account. A hard usage limit also stops it cleanly. Either way it resumes on the next run.
- **Schedule (agent1, hourly):**
  `17 * * * * cd /home/phil/code/FGL-Watchtower/fgl-watchtower && flock -n /tmp/fgl-watchtower-judge.lock /usr/bin/python3 -I collector/judge.py run --ssh-host agent2 --concurrency 1 >> ~/.cache/fgl-watchtower-judge/judge.log 2>&1`
- **Versions:** judgments are tied to `PROMPT_VERSION` and to the change set's commits. Changing the
  scoring guide, or a session gaining commits, means that set gets judged again.
- **Consistency:** 5% of sets are judged twice. `calibration-report` shows how far apart the two
  runs land.

## Agent sessions (delegation)

`collector/agents_scan.py` runs on each host that has Claude Code transcripts. The collector runs it
locally on agent1 and over ssh (`ssh agent2 python3 - < agents_scan.py`) elsewhere. It reads
`~/.claude/projects/**/*.jsonl` incrementally and prints per-day totals. Only timings, counts and
token totals leave the host. Its state is in `~/.cache/fgl-watchtower-agents/` on that host, so
history outlives Claude Code deleting old transcripts. Hosts are set in `agents.hosts` in the config.

`data/agents.json` (module `agents`) has, per day:

- **Your attention:** time from an agent finishing to your next prompt, capped at 10 min. It is
  counted once across sessions and hosts.
- **Agent working time:** prompt to last activity, with gaps over 15 min cut out. Subagents count.
- **Parallel agents:** the average number working at once while any was, plus the peak.
- **Tokens:** split into fresh input, cache reads and output.
- **Automated app jobs:** sessions started by `claude -p` / the SDK, labelled `app:job-type`.

## Running on agent1 (automatic publishing)

The collector runs from cron on agent1 through `collector/run.sh`. That script loads
`~/.config/fgl-watchtower/collector.env`, pulls the latest merged code into a clone that is used
only by the collector (`~/fgl-watchtower-collector`), and runs under a lock.

- **State:** `~/.local/state/fgl-watchtower` holds the commit and diff caches, change sets,
  judgments and agent-scan results. Config is in `~/.config/fgl-watchtower/`.
- **Push:** with the deploy key `~/.ssh/fgl_watchtower_deploy`, which has write access to this repo
  only. The clone's push URL is `git@github.com:...`.
- **Privacy:** `publish()` runs the same privacy rules as `validate-data` **before committing**. A
  file with an email, a private IP or a key is never committed, and the site keeps the last good push.

```cron
*/15 * * * * /home/phil/fgl-watchtower-collector/collector/run.sh sync_watchtower.py --only velocity,agents >> /home/phil/.cache/fgl-watchtower-collector.log 2>&1
17 * * * *   /home/phil/fgl-watchtower-collector/collector/run.sh judge.py run --ssh-host agent2 --concurrency 1 >> /home/phil/.cache/fgl-watchtower-judge/judge.log 2>&1
```

## Collector setup (on a Proxmox node)

```sh
git clone git@github.com:FutureGadgetLabs-Watchtower/futuregadgetlabs-watchtower.github.io.git /opt/fgl-watchtower
cd /opt/fgl-watchtower/collector
cp .env.example .env                                     # fill in tokens
cp watchtower.config.example.json watchtower.config.json # real targets
python3 sync_watchtower.py --dry-run -v                  # collect, write nothing
python3 sync_watchtower.py --no-push                     # write + local commit
cp systemd/* /etc/systemd/system/ && systemctl daemon-reload
systemctl enable --now fgl-watchtower-collector.timer
```

- **GitHub read access:** a fine-grained PAT covers only one owner, so either use one classic PAT
  (`repo`, `read:org`) or one fine-grained PAT per org via `GITHUB_TOKEN__<ORG>` (see `.env.example`).
- **Push access:** add an SSH deploy key with write access to this repo only. Pushes made with it
  trigger the Pages workflow.
- **Proxmox stats:** run as root to use `pvesh`, or create a `PVEAuditor` API token.
- **AI logs:** the transcripts and worker job logs live on agent1 and agent2, not on the PVE node.
  Mount or rsync them to the paths named in `ai.agent_transcript_dirs` and `ai.worker_log_globs`.
  The worker job log format is documented in `parse_worker_logs`. The worker pool does not write it
  yet.
- **Noise control:** a run that changes only timestamps or latency is not committed until
  `SYNC_HEARTBEAT_MINUTES` (default 60) has passed. Any status change commits immediately.
- **Failure isolation:** each module fails on its own. A failed module keeps its previous file.

## Deploy setup (one time)

1. Create `FutureGadgetLabs-Watchtower/futuregadgetlabs-watchtower.github.io` as a **public** repo
   (Pages on the free plan needs a public repo) and push `main`. The name must match the org, so
   GitHub serves it at the root: `https://futuregadgetlabs-watchtower.github.io/`.
2. Repo **Settings → Pages → Source: GitHub Actions**.
3. The workflow takes the base path from `actions/configure-pages`, which is `/` for this repo.
   If you later add a custom domain or move the site to a project repo, nothing in the code changes.

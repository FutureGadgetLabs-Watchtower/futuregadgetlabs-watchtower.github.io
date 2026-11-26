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
- **Sprints** in `velocity.json` are kept as you write them. The collector does not overwrite
  them unless `sprints` is set in the config.
- **Engineering AI usage** reads only timestamps, cwd, token counts and a task category from
  Claude Code transcripts. The category is guessed from keywords in the first prompt. Prompt text
  is never written out.

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

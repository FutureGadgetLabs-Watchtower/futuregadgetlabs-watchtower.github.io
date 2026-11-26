# Homelab architecture

Everything public reaches the homelab through one Cloudflare tunnel. Nothing listens on the home
router. App servers live in LXC containers on the Proxmox cluster and run Docker Compose. Static
frontends are on GitHub Pages or Cloudflare Pages, so they keep working when the homelab is off.

> Sample data. Hostnames and CT numbers come from the workspace notes. Hardware specs are
> placeholders until the collector reports real values.

## Topology

```mermaid
flowchart LR
  user([Visitor]) --> cf[Cloudflare edge<br/>DNS + Access]
  user --> pages[GitHub Pages<br/>Watchtower, fg-labs-hub]
  user --> cfp[Cloudflare Pages<br/>shop, admin]

  cf -->|tunnel| cfd[cloudflared]

  subgraph pve1[pve-01: primary compute]
    cfd
    ct110[CT 110<br/>fg-collect-core]
    ct117[CT 117<br/>COGS subledger]
    ct118[CT 118<br/>PolyEdge]
    ct121[CT 121<br/>fg-crypto-portfolio]
    ct127[CT 127<br/>PolyWeather]
    ct129[CT 129<br/>PolyEsports]
  end

  subgraph pve2[pve-02: agents + storage]
    a1[agent1<br/>worker, 3 slots]
    a2[agent2<br/>worker, 1 slot]
    zfs[(ZFS pool<br/>vzdump backups)]
  end

  cfd --> ct110 & ct117 & ct118 & ct121 & ct127 & ct129
  cfp -->|API| cf
  a1 -->|claim jobs<br/>/api/v1/worker/*| ct110 & ct118 & ct121
  a2 -->|claim jobs| ct118
  pve1 -.->|nightly vzdump| zfs
```

## CI/CD

```mermaid
flowchart LR
  dev[Push / PR] --> gha[GitHub Actions<br/>GitHub-hosted runner]
  gha -->|test + build| img[(GHCR<br/>private images)]
  gha -->|static build| ghp[GitHub Pages]
  img --> deploy[agent1: deploy/deploy.sh<br/>SSH as prxfgl]
  deploy --> ct[LXC CT<br/>docker compose pull + up]
```

## Watchtower data flow

```mermaid
sequenceDiagram
  participant T as systemd timer (pve-01)
  participant C as collector/sync_watchtower.py
  participant S as Homelab services
  participant G as GitHub API
  participant R as Watchtower repo
  participant P as GitHub Pages

  T->>C: every 15 min
  C->>S: HTTP / TCP / ping checks
  C->>G: GraphQL + REST per org
  C->>C: parse worker + agent logs
  C->>R: write data/*.json, commit, push
  R->>P: deploy.yml builds the static site
  Note over P: If the homelab is off, the site still serves the last push.<br/>Sections older than 24 h show as STALE.
```

## Nodes

| Node | Role | CPU | RAM | Storage | Guests |
|---|---|---|---|---|---|
| pve-01 | primary compute | Ryzen 9 7950X, 16c/32t | 128 GB | 4 TB NVMe (ZFS mirror) | CT 110, 117, 118, 121, 127, 129, cloudflared |
| pve-02 | agents + storage | i5-12500, 6c/12t | 64 GB | 12 TB ZFS RAIDZ1 | agent1, agent2, backups |

## Project stacks

| Project | Org | Stack | Runs on | Deploy |
|---|---|---|---|---|
| fg-collect-core | FG-CollectShop | Go, PostgreSQL, agent job queue | CT 110 | GHCR, deploy.sh |
| fg-collect-admin | FG-CollectShop | Vite, React, TypeScript | Cloudflare Pages | Pages on push |
| fg-collect-infra | FG-CollectShop | Terraform, Cloudflare, Proxmox provider | n/a | manual `terraform apply` |
| fg-price-scout | FG-CollectShop | Python, worker jobs | CT 110 (cron) | GHCR |
| fg-crypto-portfolio | FG-CryptoLabs | Python, FastAPI, SQLite | CT 121 | GHCR, deploy.sh |
| fg-labs-hub | FG-CryptoLabs | Hugo, `data/projects.yaml` | GitHub Pages | Pages on push |
| polyedge / polyarbs | FG-PolyLabs | Python, Postgres, Docker Compose | CT 118 | GHCR, deploy.sh |
| polyweather | FG-PolyLabs | Python, Postgres | CT 127 | GHCR, deploy.sh |
| polyesports | FG-PolyLabs | Python, Postgres | CT 129 | GHCR, deploy.sh |
| tcg-cogs-subledger | FGL-Services | Python, Postgres | CT 117 | deploy.sh |
| fgl-watchtower | FutureGadgetLabs-Watchtower | Vite, React, Tailwind; Python collector | GitHub Pages + pve-01 timer | Pages on push |

## Conventions

- **AI goes through the worker pool.** Apps queue a job with a prompt, a JSON schema and a model.
  agent1 and agent2 claim jobs over `/api/v1/worker/*`. No app server holds an LLM key.
- **Auth.** Public routes on the tunnel sit behind a Google sign-in allowlist.
- **Backlog.** GitHub issues labelled `backlog`, in private repos only.

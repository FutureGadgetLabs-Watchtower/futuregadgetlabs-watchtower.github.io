// Schemas for the files in /data. The collector writes these; the site only reads them at build time.
// Bump schema_version in both places when a shape changes.

export type ServiceStatus = 'ONLINE' | 'DEGRADED' | 'OFFLINE'
export type DisplayStatus = ServiceStatus | 'STALE'

export interface Org {
  id: string
  name: string
  color: string
  description?: string
}

export interface CollectorMeta {
  host: string
  version: string
  run_id: string
  duration_ms: number
  mock?: boolean
}

interface Envelope {
  schema_version: number
  generated_at: string
  collector: CollectorMeta
}

export interface Service {
  id: string
  name: string
  org: string
  project?: string | null
  kind: 'node' | 'lxc' | 'vm' | 'pages' | 'worker' | 'network' | 'external'
  host: string
  public_url?: string | null
  check: 'http' | 'tcp' | 'ping' | 'heartbeat'
  status: ServiceStatus
  latency_ms: number | null
  uptime_streak_hours: number
  uptime_30d_pct: number
  last_checked: string
  last_change: string
  /** Oldest first, one entry per collector run. */
  history: ServiceStatus[]
  notes?: string | null
}

export interface PveNode {
  id: string
  name: string
  role: string
  cpu: string
  cpu_pct: number
  mem_used_gb: number
  mem_total_gb: number
  disk_used_tb: number
  disk_total_tb: number
  uptime_days: number
  guests_running: number
  guests_total: number
  pve_version: string
}

export interface HealthData extends Envelope {
  orgs: Org[]
  nodes: PveNode[]
  services: Service[]
}

/** One project's activity on one local day (velocity.json schema_version 2). */
export interface DayMetrics {
  commits: number
  additions: number
  deletions: number
  /** commits with a Co-Authored-By: Claude trailer */
  claude: number
  /** "your hours": this project's share of session time that day */
  hours: number
  prs: number
}

export interface Sprint {
  name: string
  start: string
  end: string
  goal: string
  points_committed: number
  points_done: number
  status: 'active' | 'closed'
}

export interface VelocityData extends Envelope {
  method: { timezone: string; your_hours: string; lines: string; sources: string }
  excluded: { merge_commits: number; bot_commits: number; automated_commits: number; repos: string[] }
  orgs: Org[]
  /** id is "Org/repo": repo names repeat across orgs */
  projects: { id: string; org: string; name: string; private: boolean; archived: boolean }[]
  /** active days only, in method.timezone, ascending */
  days: { date: string; by_project: Record<string, DayMetrics> }[]
  sprints: Sprint[]
}

export type ChangeType = 'feature' | 'fix' | 'perf' | 'infra' | 'security' | 'docs' | 'breaking'

export interface ChangelogData extends Envelope {
  orgs: Org[]
  entries: {
    id: string
    date: string
    project: string
    org: string
    repo: string
    version: string
    type: ChangeType
    title: string
    body?: string | null
    url?: string | null
  }[]
}

export type RoadmapStatus = 'in_progress' | 'planned' | 'shipped'

export interface RoadmapData extends Envelope {
  orgs: Org[]
  milestones: { id: string; title: string; target: string }[]
  items: {
    id: string
    title: string
    project: string
    org: string
    status: RoadmapStatus
    milestone: string
    priority: 'P0' | 'P1' | 'P2' | 'P3'
    target: string
    progress: number
    tags: string[]
    url?: string | null
  }[]
}

export interface AiUsageData extends Envelope {
  period: { from: string; to: string }
  production: {
    note?: string
    totals: {
      api_calls: number
      tokens_in: number
      tokens_out: number
      pipeline_runs: number
      failed_runs: number
      est_cost_usd: number
    }
    by_model: { model: string; provider: string; api_calls: number; tokens_in: number; tokens_out: number }[]
    by_app: { project: string; api_calls: number; tokens: number; pipeline_runs: number; top_jobs: string[] }[]
    daily: { date: string; api_calls: number; tokens_in: number; tokens_out: number; pipeline_runs: number }[]
  }
  engineering: {
    note?: string
    totals: {
      sessions: number
      hours: number
      prs_opened_with_ai: number
      prs_reviewed_by_ai: number
      commits_co_authored: number
    }
    by_agent: { agent: string; kind: 'cloud' | 'local'; sessions: number; hours: number; tokens: number }[]
    by_project: { project: string; share: number }[]
    weekly: { week_start: string; sessions: number; by_category: Record<string, number> }[]
    highlights: string[]
  }
}

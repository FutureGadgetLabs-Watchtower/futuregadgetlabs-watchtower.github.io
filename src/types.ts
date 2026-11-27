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
  /** source + tests + config lines (added + deleted); lockfiles, generated, data and binaries left out */
  code: number
  /** test-file lines (added + deleted), part of code */
  tests: number
  docs: number
  /** non-trivial code lines written this day, and how many of them were deleted again within the rework window */
  written: number
  reworked: number
  /** change sets (one repo's commits within one working session) that started this day */
  sets: number
  /** commits whose per-file stats haven't been fetched yet */
  unclassified: number
  /** senior-engineer-equivalent hours from the judge: median and 80% range, summed over judged change sets */
  senior: number
  senior_low: number
  senior_high: number
  /** change sets judged (compare with sets for coverage) */
  judged: number
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
  method: {
    timezone: string
    your_hours: string
    lines: string
    code_lines: string
    change_sets: string
    senior_hours: string
    rework: string
    rework_window_days: number
    sources: string
  }
  judge: {
    prompt_version: string
    models: string[]
    judged_sets: number
    total_sets: number
    first_judged_date: string | null
    /** how the judge was checked against the owner's own estimates */
    calibration: { date: string; pairs: number; inside_range: number; judge_over_you: number | null; blind: boolean } | null
  } | null
  /** share of counted commits with per-file stats (code lines are complete at 1) */
  file_coverage: number
  excluded: { merge_commits: number; bot_commits: number; automated_commits: number; repos: string[] }
  orgs: Org[]
  /** id is "Org/repo": repo names repeat across orgs */
  projects: { id: string; org: string; name: string; private: boolean; archived: boolean }[]
  /** active days only, in method.timezone, ascending */
  days: { date: string; by_project: Record<string, DayMetrics> }[]
  sprints: Sprint[]
}

export interface AgentProjectDay {
  sessions: number
  prompts: number
  responses: number
  /** per-session attention; summed across sessions, so it overlaps. Use AgentsData.days[].attention_h for your time. */
  attention_h: number
  busy_h: number
  tokens_in: number
  cache_read: number
  tokens_out: number
}

export interface AgentsData extends Envelope {
  method: { timezone: string; sources: string; attention: string; busy: string; parallel: string; automated: string }
  hosts: { name: string; scanned_at: string | null; files: number }[]
  days: {
    date: string
    /** your attention that day, counted once across sessions and hosts */
    attention_h: number
    interactive: Record<string, AgentProjectDay>
    automated: Record<string, AgentProjectDay>
    parallel: { any_busy_h: number; agent_busy_h: number; peak: number }
    models: Record<string, number>
  }[]
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

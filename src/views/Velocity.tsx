import { useMemo, useState } from 'react'
import { Bar as RBar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { orgColor, velocity } from '../data'
import { compact, num, shortDate } from '../lib/format'
import type { DayMetrics } from '../types'
import { axisProps, ChartTooltip, gridProps, Legend, SERIES } from '../components/charts'
import { Bar, OrgTag, PageHead, Panel, Segmented, Select, Stat } from '../components/ui'

type Metric = 'commits' | 'hours' | 'lines' | 'prs'
type Grain = 'day' | 'week'
type Range = '28' | '84' | '182' | 'all'

const METRICS: { value: Metric; label: string }[] = [
  { value: 'commits', label: 'Commits' },
  { value: 'hours', label: 'Your hours' },
  { value: 'lines', label: 'Lines' },
  { value: 'prs', label: 'PRs' },
]
const OTHER = '#6b7a90'
const MAX_SERIES = 6

// Dates are local calendar days ("YYYY-MM-DD" in method.timezone); do the arithmetic in UTC so nothing shifts.
const toDate = (s: string) => new Date(s + 'T00:00:00Z')
const fromDate = (d: Date) => d.toISOString().slice(0, 10)
const addDays = (s: string, n: number) => fromDate(new Date(toDate(s).getTime() + n * 864e5))
const mondayOf = (s: string) => addDays(s, -((toDate(s).getUTCDay() + 6) % 7))
const localToday = (tz: string, iso: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso))

const metricOf = (m: DayMetrics, k: Metric) => (k === 'lines' ? m.additions + m.deletions : m[k])

interface Totals {
  commits: number
  hours: number
  additions: number
  deletions: number
  prs: number
  claude: number
  days: number
}
function totals(days: typeof velocity.days, inScope: (p: string) => boolean): Totals {
  const t: Totals = { commits: 0, hours: 0, additions: 0, deletions: 0, prs: 0, claude: 0, days: 0 }
  for (const d of days) {
    let active = false
    for (const [p, m] of Object.entries(d.by_project)) {
      if (!inScope(p)) continue
      t.commits += m.commits
      t.hours += m.hours
      t.additions += m.additions
      t.deletions += m.deletions
      t.prs += m.prs
      t.claude += m.claude
      active ||= m.commits > 0
    }
    if (active) t.days += 1
  }
  return t
}

export function Velocity() {
  const [grain, setGrain] = useState<Grain>('week')
  const [range, setRange] = useState<Range>('84')
  const [metric, setMetric] = useState<Metric>('hours')
  const [org, setOrg] = useState('all')

  const tz = velocity.method.timezone
  const today = localToday(tz, velocity.generated_at)
  const first = velocity.days[0]?.date ?? today
  const start = range === 'all' ? first : addDays(today, -Number(range) + 1)
  const prevStart = range === 'all' ? first : addDays(start, -Number(range))

  const projectOrg = useMemo(() => new Map(velocity.projects.map((p) => [p.id, p.org])), [])
  const inScope = (p: string) => org === 'all' || projectOrg.get(p) === org

  const windowDays = velocity.days.filter((d) => d.date >= start && d.date <= today)
  const prevDays = range === 'all' ? [] : velocity.days.filter((d) => d.date >= prevStart && d.date < start)
  const cur = totals(windowDays, inScope)
  const prev = range === 'all' ? null : totals(prevDays, inScope)
  const delta = (a: number, b?: number) => (b ? (a - b) / b : null)

  // Series: the biggest orgs (or repos, inside one org) for this metric and window; the rest fold into "Other".
  const series = useMemo(() => {
    const keyOf = (p: string) => (org === 'all' ? projectOrg.get(p)! : p)
    const size = new Map<string, number>()
    for (const d of windowDays)
      for (const [p, m] of Object.entries(d.by_project))
        if (inScope(p)) size.set(keyOf(p), (size.get(keyOf(p)) ?? 0) + metricOf(m, metric))
    const ranked = [...size.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])
    const top = ranked.slice(0, MAX_SERIES).map(([k], i) => ({
      key: k,
      label: org === 'all' ? k : k.split('/')[1],
      color: org === 'all' ? orgColor(k) : SERIES[i % SERIES.length],
    }))
    const rest = ranked.length > MAX_SERIES ? [{ key: '__other', label: `Other (${ranked.length - MAX_SERIES})`, color: OTHER }] : []
    return { list: [...top, ...rest], keyOf, topKeys: new Set(top.map((t) => t.key)) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org, metric, start, today])

  // Continuous buckets so empty days and weeks show as gaps, not as missing bars.
  const chartData = useMemo(() => {
    const bucketOf = (d: string) => (grain === 'week' ? mondayOf(d) : d)
    const rows = new Map<string, Record<string, number | string>>()
    for (let d = bucketOf(start); d <= today; d = addDays(d, grain === 'week' ? 7 : 1)) {
      const row: Record<string, number | string> = { at: d }
      for (const s of series.list) row[s.key] = 0
      rows.set(d, row)
    }
    for (const day of windowDays) {
      const row = rows.get(bucketOf(day.date))
      if (!row) continue
      for (const [p, m] of Object.entries(day.by_project)) {
        if (!inScope(p)) continue
        const k = series.keyOf(p)
        const key = series.topKeys.has(k) ? k : '__other'
        if (key in row) row[key] = Math.round(((row[key] as number) + metricOf(m, metric)) * 100) / 100
      }
    }
    return [...rows.values()]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series, grain, start, today])

  const table = useMemo(() => {
    const rows = new Map<string, Totals & { id: string }>()
    for (const d of windowDays)
      for (const [p, m] of Object.entries(d.by_project)) {
        if (!inScope(p)) continue
        const r = rows.get(p) ?? { id: p, commits: 0, hours: 0, additions: 0, deletions: 0, prs: 0, claude: 0, days: 0 }
        r.commits += m.commits
        r.hours += m.hours
        r.additions += m.additions
        r.deletions += m.deletions
        r.prs += m.prs
        r.claude += m.claude
        r.days += m.commits > 0 ? 1 : 0
        rows.set(p, r)
      }
    return [...rows.values()].filter((r) => r.commits > 0).sort((a, b) => b.hours - a.hours)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org, start, today])
  const maxHours = Math.max(...table.map((t) => t.hours), 1)

  const fmt = (v: number) => (metric === 'lines' ? compact(v) : metric === 'hours' ? `${v.toFixed(1)} h` : num(v))
  const rangeLabel = range === 'all' ? `since ${shortDate(first)}` : `last ${range === '28' ? '4' : range === '84' ? '12' : '26'} weeks`
  const ex = velocity.excluded

  return (
    <div>
      <PageHead code="02" title="Engineering velocity">
        Every commit across the orgs the Watchtower GitHub App can read, counted per day in {tz.replace('_', ' ')} time. "Your
        hours" is time spent directing the work, from commit sessions. Senior-engineer-equivalent hours arrive with the weekly
        judge.
      </PageHead>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="Your hours" value={cur.hours.toFixed(0)} delta={delta(cur.hours, prev?.hours)} sub={prev ? 'vs prior period' : rangeLabel} />
        <Stat label="Commits" value={num(cur.commits)} delta={delta(cur.commits, prev?.commits)} sub={prev ? 'vs prior period' : rangeLabel} />
        <Stat label="Active days" value={cur.days} sub={`of ${range === 'all' ? Math.round((toDate(today).getTime() - toDate(first).getTime()) / 864e5) + 1 : range}`} />
        <Stat
          label="Lines changed"
          value={compact(cur.additions + cur.deletions)}
          delta={delta(cur.additions + cur.deletions, prev ? prev.additions + prev.deletions : undefined)}
          sub={`+${compact(cur.additions)} −${compact(cur.deletions)}`}
        />
        <Stat label="PRs merged" value={num(cur.prs)} delta={delta(cur.prs, prev?.prs)} sub={prev ? 'vs prior period' : rangeLabel} />
        <Stat label="Claude co-authored" value={cur.commits ? `${Math.round((cur.claude / cur.commits) * 100)}%` : '—'} sub="of commits" />
      </div>

      <Panel
        className="mt-5"
        kicker={`${rangeLabel} · ${grain === 'week' ? 'weeks start Monday' : 'by day'}`}
        title={`${METRICS.find((m) => m.value === metric)!.label} per ${grain}, ${org === 'all' ? 'by org' : `${org} by repo`}`}
        right={
          <div className="flex flex-wrap items-center gap-2">
            <Select
              label="Scope"
              value={org}
              onChange={setOrg}
              options={[{ value: 'all', label: 'All orgs' }, ...velocity.orgs.map((o) => ({ value: o.id, label: o.name }))]}
            />
            <Segmented label="Metric" value={metric} onChange={setMetric} options={METRICS} />
            <Segmented
              label="Grain"
              value={grain}
              onChange={setGrain}
              options={[
                { value: 'day', label: 'Day' },
                { value: 'week', label: 'Week' },
              ]}
            />
            <Segmented
              label="Range"
              value={range}
              onChange={setRange}
              options={[
                { value: '28', label: '4W' },
                { value: '84', label: '12W' },
                { value: '182', label: '26W' },
                { value: 'all', label: 'All' },
              ]}
            />
          </div>
        }
      >
        <Legend items={series.list.map((s) => ({ label: s.label, color: s.color }))} />
        <div className="mt-3 h-[320px]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} margin={{ top: 8, right: 8, left: -12, bottom: 0 }} barCategoryGap={grain === 'day' ? '12%' : '22%'}>
              <CartesianGrid {...gridProps} />
              <XAxis dataKey="at" {...axisProps} tickFormatter={shortDate} minTickGap={16} />
              <YAxis {...axisProps} tickFormatter={(v) => compact(Number(v))} width={52} />
              <Tooltip
                cursor={{ fill: 'rgb(255 255 255 / 0.04)' }}
                content={
                  <ChartTooltip fmt={fmt} labelFmt={(l) => (grain === 'week' ? `Week of ${shortDate(String(l))}` : shortDate(String(l)))} total />
                }
              />
              {series.list.map((s, i) => (
                <RBar
                  key={s.key}
                  dataKey={s.key}
                  name={s.label}
                  stackId="v"
                  fill={s.color}
                  stroke="var(--color-panel)"
                  strokeWidth={grain === 'day' ? 0.5 : 1.5}
                  radius={i === series.list.length - 1 ? [3, 3, 0, 0] : 0}
                  isAnimationActive={false}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Panel>

      <div className={`mt-5 grid gap-5 ${velocity.sprints.length ? 'xl:grid-cols-[1fr_380px]' : ''}`}>
        <Panel pad={false} kicker={rangeLabel} title={`By repository (${table.length})`}>
          <div className="max-h-[560px] overflow-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-panel">
                <tr className="border-b border-line text-left">
                  {['Repository', 'Org', 'Your hours', 'Commits', 'PRs', 'Lines +/−', 'Active days', 'Claude'].map((h) => (
                    <th key={h} className="label whitespace-nowrap px-4 py-2 font-normal">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.map((r) => {
                  const [o, name] = r.id.split('/')
                  return (
                    <tr key={r.id} className="border-b border-line/70 last:border-0 hover:bg-panel-2/60">
                      <td className="px-4 py-2 font-mono text-xs">
                        <a className="hover:text-scan" href={`https://github.com/${r.id}`} target="_blank" rel="noreferrer">
                          {name}
                        </a>
                      </td>
                      <td className="px-4 py-2">
                        <OrgTag org={o} short />
                      </td>
                      <td className="w-44 px-4 py-2">
                        <div className="flex items-center gap-2">
                          <span className="w-10 font-mono text-xs tnum">{r.hours.toFixed(1)}</span>
                          <div className="flex-1">
                            <div className="h-1.5 rounded-full" style={{ width: `${(r.hours / maxHours) * 100}%`, background: orgColor(o) }} />
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-2 font-mono text-xs tnum">{num(r.commits)}</td>
                      <td className="px-4 py-2 font-mono text-xs tnum">{r.prs}</td>
                      <td className="whitespace-nowrap px-4 py-2 font-mono text-xs text-ink-2 tnum">
                        +{compact(r.additions)} −{compact(r.deletions)}
                      </td>
                      <td className="px-4 py-2 font-mono text-xs text-ink-2 tnum">{r.days}</td>
                      <td className="px-4 py-2 font-mono text-xs text-ink-2 tnum">{Math.round((r.claude / r.commits) * 100)}%</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </Panel>

        {velocity.sprints.length > 0 && (
          <Panel kicker="2-week sprints" title="Sprints">
            <ul className="space-y-3">
              {[...velocity.sprints].reverse().map((s) => (
                <li key={s.name}>
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-sm">
                      <span className={`mr-2 font-mono text-xs ${s.status === 'active' ? 'text-nixie' : 'text-ink-3'}`}>{s.name}</span>
                      {s.goal}
                    </span>
                    <span className="shrink-0 font-mono text-xs text-ink-2 tnum">
                      {s.points_done}/{s.points_committed} pts
                    </span>
                  </div>
                  <div className="mt-1.5">
                    <Bar value={s.points_done} max={s.points_committed} tone={s.status === 'active' ? 'nixie' : 'scan'} />
                  </div>
                  <div className="mt-1 text-[0.7rem] text-ink-3">
                    {shortDate(s.start)} – {shortDate(s.end)} {s.status === 'active' && '· in progress'}
                  </div>
                </li>
              ))}
            </ul>
          </Panel>
        )}
      </div>

      <div className="mt-4 space-y-1.5 text-xs text-ink-3">
        <p>
          <span className="label mr-2">your hours</span>
          {velocity.method.your_hours}
        </p>
        <p>
          <span className="label mr-2">lines</span>
          {velocity.method.lines}
        </p>
        <p>
          <span className="label mr-2">sources</span>
          {velocity.method.sources} Left out: {num(ex.merge_commits)} merge, {num(ex.bot_commits)} bot and{' '}
          {num(ex.automated_commits)} automated commits{ex.repos.length ? `, plus ${ex.repos.join(', ')}` : ''}.
        </p>
      </div>
    </div>
  )
}

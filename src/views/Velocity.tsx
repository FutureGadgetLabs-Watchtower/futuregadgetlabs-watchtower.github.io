import { useMemo, useState } from 'react'
import { Bar as RBar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { orgColor, velocity } from '../data'
import { compact, num, shortDate } from '../lib/format'
import type { DayMetrics } from '../types'
import { axisProps, ChartTooltip, gridProps, Legend, SERIES } from '../components/charts'
import { Bar, OrgTag, PageHead, Panel, Segmented, Select, Stat } from '../components/ui'
import { DelegationPanel } from './Delegation'

type Metric = 'senior' | 'commits' | 'hours' | 'code' | 'sets' | 'prs'
type Grain = 'day' | 'week'
type Range = '28' | '84' | '182' | 'all'

const METRICS: { value: Metric; label: string }[] = [
  { value: 'senior', label: 'Eng. hours delivered' },
  { value: 'hours', label: 'Your hours' },
  { value: 'sets', label: 'Change sets' },
  { value: 'commits', label: 'Commits' },
  { value: 'code', label: 'Code lines' },
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

const metricOf = (m: DayMetrics, k: Metric) => m[k] ?? 0
const pct = (x: number) => `${(x * 100).toFixed(x < 0.1 ? 1 : 0)}%`

interface Totals {
  tests: number
  written: number
  reworked: number
  senior: number
  senior_low: number
  senior_high: number
  judged: number
  commits: number
  hours: number
  code: number
  docs: number
  sets: number
  prs: number
  claude: number
  days: number
}
const ZERO: Totals = { tests: 0, written: 0, reworked: 0, senior: 0, senior_low: 0, senior_high: 0, judged: 0, commits: 0, hours: 0, code: 0, docs: 0, sets: 0, prs: 0, claude: 0, days: 0 }
function add(t: Totals, m: DayMetrics, matured = true) {
  t.tests += m.tests ?? 0
  // Rework only counts once a day's window has closed; younger days would understate it.
  if (matured) {
    t.written += m.written ?? 0
    t.reworked += m.reworked ?? 0
  }
  t.senior += m.senior ?? 0
  t.senior_low += m.senior_low ?? 0
  t.senior_high += m.senior_high ?? 0
  t.judged += m.judged ?? 0
  t.commits += m.commits
  t.hours += m.hours
  t.code += m.code ?? 0
  t.docs += m.docs ?? 0
  t.sets += m.sets ?? 0
  t.prs += m.prs
  t.claude += m.claude
}
function totals(days: typeof velocity.days, inScope: (p: string) => boolean, maturedUntil: string): Totals {
  const t = { ...ZERO }
  for (const d of days) {
    let active = false
    for (const [p, m] of Object.entries(d.by_project)) {
      if (!inScope(p)) continue
      add(t, m, d.date <= maturedUntil)
      active ||= m.commits > 0
    }
    if (active) t.days += 1
  }
  return t
}

export function Velocity() {
  const [grain, setGrain] = useState<Grain>('week')
  const [range, setRange] = useState<Range>('84')
  const [metric, setMetric] = useState<Metric>(velocity.judge?.judged_sets ? 'senior' : 'hours')
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
  const maturedUntil = addDays(today, -(velocity.method.rework_window_days ?? 21))
  const cur = totals(windowDays, inScope, maturedUntil)
  const prev = range === 'all' ? null : totals(prevDays, inScope, maturedUntil)
  // A % change against a near-empty prior period (1 PR → 1,179) says nothing; show it only from a real base.
  const delta = (a: number, b?: number) => (b && b >= 5 ? (a - b) / b : null)

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
        const r = rows.get(p) ?? { id: p, ...ZERO }
        add(r, m, d.date <= maturedUntil)
        r.days += m.commits > 0 ? 1 : 0
        rows.set(p, r)
      }
    return [...rows.values()].filter((r) => r.commits > 0).sort((a, b) => b.hours - a.hours)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org, start, today])
  const maxHours = Math.max(...table.map((t) => t.hours), 1)

  const fmt = (v: number) => (metric === 'code' ? compact(v) : metric === 'hours' || metric === 'senior' ? `${v.toFixed(1)} h` : num(v))
  // Leverage and team size only once (nearly) every change set in the window has been judged: a partial
  // back-fill would understate engineering hours delivered against a complete count of your hours.
  const coverage = cur.sets ? cur.judged / cur.sets : 0
  const complete = coverage >= 0.95
  const weeks = Math.max(1, (range === 'all' ? (toDate(today).getTime() - toDate(first).getTime()) / 864e5 + 1 : Number(range)) / 7)
  const rangeLabel = range === 'all' ? `since ${shortDate(first)}` : `last ${range === '28' ? '4' : range === '84' ? '12' : '26'} weeks`
  const ex = velocity.excluded

  return (
    <div>
      <PageHead code="02" title="Engineering velocity">
        Every commit across the orgs the Watchtower GitHub App can read, counted per day in {tz.replace('_', ' ')} time. "Your
        hours" is time spent directing the work, from commit sessions. "Engineering hours delivered" is how much engineering the
        shipped code represents: a judge reads each change and estimates what it would have taken one senior engineer before AI.
      </PageHead>

      <div className="mb-3 grid gap-3 md:grid-cols-3">
        <Stat
          label="Engineering hours delivered"
          value={cur.judged ? cur.senior.toFixed(0) : '—'}
          delta={complete ? delta(cur.senior, prev && prev.sets && prev.judged / prev.sets >= 0.95 ? prev.senior : undefined) : null}
          sub={
            cur.judged
              ? `${cur.senior_low.toFixed(0)}–${cur.senior_high.toFixed(0)} h range, senior pre-AI pace${complete ? '' : ` · ${cur.judged} of ${cur.sets} change sets judged`}`
              : 'judge not run for this period yet'
          }
        />
        <Stat
          label="Leverage"
          value={complete && cur.hours ? `${(cur.senior / cur.hours).toFixed(1)}×` : '—'}
          sub={complete ? 'engineering hours delivered per hour of yours' : 'needs the back-fill for this period'}
        />
        <Stat
          label="Team equivalent"
          value={complete ? (cur.senior / weeks / 40).toFixed(1) : '—'}
          sub={complete ? 'engineers at 40 h/week of delivered work, averaged' : 'needs the back-fill for this period'}
        />
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat
          label="Your hours"
          value={cur.hours.toFixed(0)}
          delta={delta(cur.hours, prev?.hours)}
          sub={`${cur.days} active days`}
        />
        <Stat label="Change sets" value={num(cur.sets)} delta={delta(cur.sets, prev?.sets)} sub={prev ? 'vs prior period' : rangeLabel} />
        <Stat label="Commits" value={num(cur.commits)} delta={delta(cur.commits, prev?.commits)} sub={prev ? 'vs prior period' : rangeLabel} />
        <Stat
          label="Code lines"
          value={compact(cur.code)}
          delta={delta(cur.code, prev?.code)}
          sub={velocity.file_coverage < 1 ? `${Math.round(velocity.file_coverage * 100)}% of commits classified` : `+ ${compact(cur.docs)} docs`}
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

      <DelegationPanel start={start} end={today} org={org} rangeLabel={rangeLabel} />

      <QualityPanel days={windowDays} inScope={inScope} maturedUntil={maturedUntil} cur={cur} rangeLabel={rangeLabel} />

      <div className={`mt-5 grid gap-5 ${velocity.sprints.length ? 'xl:grid-cols-[1fr_380px]' : ''}`}>
        <Panel pad={false} kicker={rangeLabel} title={`By repository (${table.length})`}>
          <div className="max-h-[560px] overflow-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-panel">
                <tr className="border-b border-line text-left">
                  {['Repository', 'Org', 'Your hours', 'Eng. hours', 'Change sets', 'Commits', 'PRs', 'Code lines', 'Rework', 'Active days', 'Claude'].map((h) => (
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
                      <td className="px-4 py-2 font-mono text-xs tnum" title={r.judged ? `${r.judged} of ${r.sets} change sets judged` : ''}>
                        {r.judged ? `${r.senior.toFixed(0)}${r.judged < r.sets ? '*' : ''}` : '—'}
                      </td>
                      <td className="px-4 py-2 font-mono text-xs tnum">{num(r.sets)}</td>
                      <td className="px-4 py-2 font-mono text-xs tnum">{num(r.commits)}</td>
                      <td className="px-4 py-2 font-mono text-xs tnum">{r.prs}</td>
                      <td className="whitespace-nowrap px-4 py-2 font-mono text-xs text-ink-2 tnum">{compact(r.code)}</td>
                      <td className="px-4 py-2 font-mono text-xs text-ink-2 tnum">{r.written >= 200 ? pct(r.reworked / r.written) : '—'}</td>
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
          <span className="label mr-2">code lines</span>
          {velocity.method.code_lines}
        </p>
        <p>
          <span className="label mr-2">engineering hours</span>
          {velocity.method.senior_hours}
          {velocity.judge &&
            ` Judged so far: ${num(velocity.judge.judged_sets)} of ${num(velocity.judge.total_sets)} change sets (scoring guide ${velocity.judge.prompt_version}). * = some of that repo's change sets aren't judged yet.`}
          {velocity.judge?.calibration &&
            ` Checked against my own estimates on ${velocity.judge.calibration.pairs} change sets (${velocity.judge.calibration.blind ? 'scored blind' : 'reviewed after seeing the judge\'s number, so not blind'}): ${velocity.judge.calibration.inside_range} of ${velocity.judge.calibration.pairs} inside the judge's range; judge total ÷ mine = ${velocity.judge.calibration.judge_over_you?.toFixed(2)}. A ballpark, not a timesheet.`}
        </p>
        <p>
          <span className="label mr-2">rework</span>
          {velocity.method.rework}
        </p>
        <p>
          <span className="label mr-2">change sets</span>
          {velocity.method.change_sets}
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

/** Quality next to output: how much freshly written code was thrown away again, and how much of it is tests. */
function QualityPanel({
  days,
  inScope,
  maturedUntil,
  cur,
  rangeLabel,
}: {
  days: typeof velocity.days
  inScope: (p: string) => boolean
  maturedUntil: string
  cur: Totals
  rangeLabel: string
}) {
  const weeks = new Map<string, { written: number; reworked: number }>()
  for (const d of days) {
    if (d.date > maturedUntil) continue
    const w = weeks.get(mondayOf(d.date)) ?? { written: 0, reworked: 0 }
    for (const [p, m] of Object.entries(d.by_project)) {
      if (!inScope(p)) continue
      w.written += m.written ?? 0
      w.reworked += m.reworked ?? 0
    }
    weeks.set(mondayOf(d.date), w)
  }
  const data = [...weeks.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .filter(([, w]) => w.written >= 200)
    .map(([at, w]) => ({ at, rework: Math.round((w.reworked / w.written) * 1000) / 10 }))
  const windowDays = velocity.method.rework_window_days ?? 21
  return (
    <Panel className="mt-5" kicker={`${rangeLabel} · ${windowDays}-day rework window`} title="Quality: does the code stay?">
      <div className="grid gap-5 lg:grid-cols-[320px_1fr]">
        <div className="grid grid-cols-2 gap-3 self-start lg:grid-cols-1">
          <Stat
            label="Rework rate"
            value={cur.written ? pct(cur.reworked / cur.written) : '—'}
            sub={cur.written ? `${compact(cur.reworked)} of ${compact(cur.written)} lines deleted within ${windowDays} days` : `no day older than ${windowDays} days in range`}
          />
          <Stat label="Tests" value={cur.code ? pct(cur.tests / cur.code) : '—'} sub="share of code lines changed" />
        </div>
        <div className="h-[220px]">
          {data.length ? (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data} margin={{ top: 8, right: 8, left: -12, bottom: 0 }} barCategoryGap="22%">
                <CartesianGrid {...gridProps} />
                <XAxis dataKey="at" {...axisProps} tickFormatter={shortDate} minTickGap={16} />
                <YAxis {...axisProps} tickFormatter={(v) => `${v}%`} width={44} />
                <Tooltip
                  cursor={{ fill: 'rgb(255 255 255 / 0.04)' }}
                  content={<ChartTooltip fmt={(v) => `${v}% reworked`} labelFmt={(l) => `Code written week of ${shortDate(String(l))}`} />}
                />
                <RBar dataKey="rework" name="Rework" fill="var(--color-scan)" radius={[3, 3, 0, 0]} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <p className="py-16 text-center text-xs text-ink-3">Not enough code older than {windowDays} days in this range.</p>
          )}
        </div>
      </div>
    </Panel>
  )
}

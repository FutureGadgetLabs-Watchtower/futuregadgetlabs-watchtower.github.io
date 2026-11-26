import { useMemo, useState } from 'react'
import { Bar as RBar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { orgColor, orgs, velocity } from '../data'
import { compact, num, shortDate } from '../lib/format'
import type { WeekMetrics } from '../types'
import { axisProps, ChartTooltip, gridProps, Legend, SERIES } from '../components/charts'
import { Bar, OrgTag, PageHead, Panel, Segmented, Select, Stat } from '../components/ui'

type Metric = 'commits' | 'prs_merged' | 'lines' | 'est_hours' | 'active_repos'
const METRICS: { value: Metric; label: string }[] = [
  { value: 'commits', label: 'Commits' },
  { value: 'prs_merged', label: 'PRs' },
  { value: 'lines', label: 'Lines' },
  { value: 'est_hours', label: 'Est. hours' },
  { value: 'active_repos', label: 'Repos' },
]
const val = (m: WeekMetrics | undefined, k: Metric) =>
  !m ? 0 : k === 'lines' ? m.additions + m.deletions : (m[k] as number)

function sumWeek(by: Record<string, WeekMetrics>, ids: string[]) {
  const z: WeekMetrics = { commits: 0, prs_merged: 0, additions: 0, deletions: 0, active_repos: 0, est_hours: 0 }
  for (const id of ids) {
    const m = by[id]
    if (!m) continue
    z.commits += m.commits
    z.prs_merged += m.prs_merged
    z.additions += m.additions
    z.deletions += m.deletions
    z.active_repos += m.active_repos
    z.est_hours += m.est_hours
  }
  return z
}

export function Velocity() {
  const [range, setRange] = useState<'4' | '8' | '12'>('12')
  const [metric, setMetric] = useState<Metric>('commits')
  const [org, setOrg] = useState('all')

  const weeks = velocity.weeks.slice(-Number(range))
  const allIds = velocity.projects.map((p) => p.id)

  // Series: orgs when viewing everything; that org's projects when one org is picked.
  // Colors follow the entity: orgs keep their registry color, projects keep their slot within the org.
  const series = useMemo(() => {
    if (org === 'all')
      return orgs.map((o) => ({
        key: o.id,
        label: o.name,
        color: o.color,
        ids: velocity.projects.filter((p) => p.org === o.id).map((p) => p.id),
      }))
    return velocity.projects
      .filter((p) => p.org === org)
      .map((p, i) => ({ key: p.id, label: p.id, color: SERIES[i % SERIES.length], ids: [p.id] }))
  }, [org])

  const chartData = weeks.map((w) => {
    const row: Record<string, number | string> = { week: w.week_start }
    for (const s of series) row[s.key] = Math.round(val(sumWeek(w.by_project, s.ids), metric) * 10) / 10
    return row
  })

  const scopeIds = org === 'all' ? allIds : series.flatMap((s) => s.ids)
  const last = sumWeek(velocity.weeks.at(-1)!.by_project, scopeIds)
  const prev = sumWeek(velocity.weeks.at(-2)!.by_project, scopeIds)
  const d = (a: number, b: number) => (b ? (a - b) / b : null)

  const table = velocity.projects
    .filter((p) => scopeIds.includes(p.id))
    .map((p) => {
      const t = weeks.reduce(
        (acc, w) => {
          const m = w.by_project[p.id]
          if (m) {
            acc.commits += m.commits
            acc.prs += m.prs_merged
            acc.add += m.additions
            acc.del += m.deletions
            acc.hours += m.est_hours
            acc.activeWeeks += m.commits > 0 ? 1 : 0
          }
          return acc
        },
        { commits: 0, prs: 0, add: 0, del: 0, hours: 0, activeWeeks: 0 },
      )
      return { ...p, ...t }
    })
    .sort((a, b) => b.commits - a.commits)
  const maxCommits = Math.max(...table.map((t) => t.commits), 1)

  const fmt = (v: number) => (metric === 'lines' ? compact(v) : metric === 'est_hours' ? `${v.toFixed(1)} h` : num(v))

  return (
    <div>
      <PageHead code="02" title="Week-by-week engineering velocity">
        Output across every org, from GitHub, per ISO week (Monday start). Default branches only; bot commits excluded.
      </PageHead>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="Commits / wk" value={num(last.commits)} delta={d(last.commits, prev.commits)} sub="vs prior wk" />
        <Stat label="PRs merged" value={num(last.prs_merged)} delta={d(last.prs_merged, prev.prs_merged)} sub="vs prior wk" />
        <Stat
          label="Lines changed"
          value={compact(last.additions + last.deletions)}
          delta={d(last.additions + last.deletions, prev.additions + prev.deletions)}
          sub={`+${compact(last.additions)} −${compact(last.deletions)}`}
        />
        <Stat label="Active repos" value={last.active_repos} sub={`of ${scopeIds.length} tracked`} />
        <Stat label="Est. eng hours" value={last.est_hours.toFixed(0)} delta={d(last.est_hours, prev.est_hours)} sub="proxy, see below" />
      </div>

      <Panel
        className="mt-5"
        kicker={`week of ${shortDate(velocity.weeks.at(-1)!.week_start)} is the latest`}
        title={`${METRICS.find((m) => m.value === metric)!.label} per week, ${org === 'all' ? 'by org' : `${org} by repo`}`}
        right={
          <div className="flex flex-wrap items-center gap-2">
            <Select
              label="Scope"
              value={org}
              onChange={setOrg}
              options={[{ value: 'all', label: 'All orgs' }, ...orgs.map((o) => ({ value: o.id, label: o.name }))]}
            />
            <Segmented label="Metric" value={metric} onChange={setMetric} options={METRICS} />
            <Segmented
              label="Range"
              value={range}
              onChange={setRange}
              options={[
                { value: '4', label: '4W' },
                { value: '8', label: '8W' },
                { value: '12', label: '12W' },
              ]}
            />
          </div>
        }
      >
        <Legend items={series.map((s) => ({ label: s.label, color: s.color }))} />
        <div className="mt-3 h-[320px]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} margin={{ top: 8, right: 8, left: -12, bottom: 0 }} barCategoryGap="22%">
              <CartesianGrid {...gridProps} />
              <XAxis dataKey="week" {...axisProps} tickFormatter={shortDate} />
              <YAxis {...axisProps} tickFormatter={(v) => compact(Number(v))} width={52} />
              <Tooltip
                cursor={{ fill: 'rgb(255 255 255 / 0.04)' }}
                content={<ChartTooltip fmt={fmt} labelFmt={(l) => `Week of ${shortDate(String(l))}`} total />}
              />
              {series.map((s, i) => (
                <RBar
                  key={s.key}
                  dataKey={s.key}
                  name={s.label}
                  stackId="v"
                  fill={s.color}
                  stroke="var(--color-panel)"
                  strokeWidth={1.5}
                  radius={i === series.length - 1 ? [4, 4, 0, 0] : 0}
                  isAnimationActive={false}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Panel>

      <div className="mt-5 grid gap-5 xl:grid-cols-[1fr_380px]">
        <Panel pad={false} kicker={`last ${range} weeks`} title="By repository">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left">
                  {['Repository', 'Org', 'Commits', 'PRs', 'Lines +/−', 'Est. h', 'Active wks'].map((h) => (
                    <th key={h} className="label whitespace-nowrap px-4 py-2 font-normal">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.map((r) => (
                  <tr key={r.id} className="border-b border-line/70 last:border-0 hover:bg-panel-2/60">
                    <td className="px-4 py-2 font-mono text-xs">
                      <a className="hover:text-scan" href={`https://github.com/${r.repo}`} target="_blank" rel="noreferrer">
                        {r.id}
                      </a>
                    </td>
                    <td className="px-4 py-2">
                      <OrgTag org={r.org} short />
                    </td>
                    <td className="w-40 px-4 py-2">
                      <div className="flex items-center gap-2">
                        <span className="w-8 font-mono text-xs tnum">{r.commits}</span>
                        <div className="flex-1">
                          <div className="h-1.5 rounded-full" style={{ width: `${(r.commits / maxCommits) * 100}%`, background: orgColor(r.org) }} />
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-2 font-mono text-xs tnum">{r.prs}</td>
                    <td className="whitespace-nowrap px-4 py-2 font-mono text-xs text-ink-2 tnum">
                      +{compact(r.add)} −{compact(r.del)}
                    </td>
                    <td className="px-4 py-2 font-mono text-xs tnum">{r.hours.toFixed(0)}</td>
                    <td className="px-4 py-2 font-mono text-xs text-ink-2 tnum">
                      {r.activeWeeks}/{weeks.length}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>

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
      </div>

      <p className="mt-4 text-xs text-ink-3">
        <span className="label mr-2">method</span>
        {velocity.method.est_hours} {velocity.method.sources}.
      </p>
    </div>
  )
}

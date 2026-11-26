import { useState } from 'react'
import {
  Area,
  AreaChart,
  Bar as RBar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { aiUsage, orgColor, orgOfProject } from '../data'
import { compact, num, shortDate } from '../lib/format'
import { axisProps, ChartTooltip, gridProps, Legend, SERIES } from '../components/charts'
import { PageHead, Panel, Segmented, Stat } from '../components/ui'

const { production: prod, engineering: eng } = aiUsage

function Production() {
  const t = prod.totals
  const totalCalls = prod.by_model.reduce((a, m) => a + m.api_calls, 0)
  const daily = prod.daily.map((d) => ({ ...d }))
  return (
    <div className="space-y-5">
      {prod.note && <p className="text-sm text-ink-3">{prod.note}</p>}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="API calls" value={compact(t.api_calls)} sub="30 days" />
        <Stat label="Tokens in" value={compact(t.tokens_in)} />
        <Stat label="Tokens out" value={compact(t.tokens_out)} />
        <Stat label="Pipeline runs" value={num(t.pipeline_runs)} />
        <Stat label="Failed runs" value={num(t.failed_runs)} sub={`${((t.failed_runs / t.pipeline_runs) * 100).toFixed(1)}% of runs`} />
        <Stat label="Est. cost" value={`$${t.est_cost_usd.toFixed(2)}`} sub="metered only" />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Panel kicker="per day" title="Tokens">
          <Legend
            items={[
              { label: 'Input', color: SERIES[0] },
              { label: 'Output', color: SERIES[1] },
            ]}
          />
          <div className="mt-3 h-[240px]">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={daily} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
                <CartesianGrid {...gridProps} />
                <XAxis dataKey="date" {...axisProps} tickFormatter={shortDate} minTickGap={24} />
                <YAxis {...axisProps} tickFormatter={(v) => compact(Number(v))} width={52} />
                <Tooltip cursor={{ stroke: 'var(--color-line-2)' }} content={<ChartTooltip fmt={compact} labelFmt={(l) => shortDate(String(l))} total />} />
                <Area type="monotone" dataKey="tokens_in" name="Input" stackId="t" stroke={SERIES[0]} strokeWidth={2} fill={SERIES[0]} fillOpacity={0.18} isAnimationActive={false} />
                <Area type="monotone" dataKey="tokens_out" name="Output" stackId="t" stroke={SERIES[1]} strokeWidth={2} fill={SERIES[1]} fillOpacity={0.25} isAnimationActive={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </Panel>
        <Panel kicker="per day" title="API calls">
          <div className="h-[262px]">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={daily} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
                <CartesianGrid {...gridProps} />
                <XAxis dataKey="date" {...axisProps} tickFormatter={shortDate} minTickGap={24} />
                <YAxis {...axisProps} tickFormatter={(v) => compact(Number(v))} width={52} />
                <Tooltip cursor={{ stroke: 'var(--color-line-2)' }} content={<ChartTooltip fmt={num} labelFmt={(l) => shortDate(String(l))} />} />
                <Line type="monotone" dataKey="api_calls" name="API calls" stroke="var(--color-scan)" strokeWidth={2} dot={false} activeDot={{ r: 4, stroke: 'var(--color-panel)', strokeWidth: 2 }} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Panel>
      </div>

      <div className="grid gap-5 lg:grid-cols-[1fr_1.3fr]">
        <Panel kicker="share of api calls" title="Model breakdown">
          <ul className="space-y-3">
            {prod.by_model.map((m, i) => {
              const share = m.api_calls / totalCalls
              return (
                <li key={m.model} title={`${num(m.api_calls)} calls · ${compact(m.tokens_in + m.tokens_out)} tokens`}>
                  <div className="flex items-baseline justify-between gap-2 text-sm">
                    <span className="flex items-center gap-2">
                      <span className="h-2.5 w-2.5 rounded-[2px]" style={{ background: SERIES[i] }} />
                      <span className="font-mono text-xs">{m.model}</span>
                    </span>
                    <span className="font-mono text-xs text-ink-2 tnum">{(share * 100).toFixed(0)}%</span>
                  </div>
                  <div className="mt-1 h-1.5 rounded-full bg-line">
                    <div className="h-full rounded-full" style={{ width: `${share * 100}%`, background: SERIES[i] }} />
                  </div>
                  <div className="mt-0.5 text-[0.7rem] text-ink-3">{m.provider}</div>
                </li>
              )
            })}
          </ul>
        </Panel>
        <Panel pad={false} kicker="30 days" title="By app">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left">
                  {['App', 'Calls', 'Tokens', 'Runs', 'Top jobs'].map((h) => (
                    <th key={h} className="label px-4 py-2 font-normal">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {prod.by_app.map((a) => (
                  <tr key={a.project} className="border-b border-line/70 align-top last:border-0">
                    <td className="whitespace-nowrap px-4 py-2 font-mono text-xs">
                      <span className="mr-2 inline-block h-2 w-2 rounded-[2px]" style={{ background: orgColor(orgOfProject(a.project) ?? '') }} />
                      {a.project}
                    </td>
                    <td className="px-4 py-2 font-mono text-xs tnum">{compact(a.api_calls)}</td>
                    <td className="px-4 py-2 font-mono text-xs tnum">{compact(a.tokens)}</td>
                    <td className="px-4 py-2 font-mono text-xs tnum">{num(a.pipeline_runs)}</td>
                    <td className="px-4 py-2 text-xs text-ink-3">{a.top_jobs.join(' · ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      </div>
    </div>
  )
}

function Engineering() {
  const t = eng.totals
  const cats = Object.keys(eng.weekly[0]?.by_category ?? {})
  const weekly = eng.weekly.map((w) => ({ week: w.week_start, ...w.by_category }))
  const catTotals = cats
    .map((c) => ({ c, n: eng.weekly.reduce((a, w) => a + (w.by_category[c] ?? 0), 0) }))
    .sort((a, b) => b.n - a.n)
  const catSum = catTotals.reduce((a, x) => a + x.n, 0)
  return (
    <div className="space-y-5">
      {eng.note && <p className="text-sm text-ink-3">{eng.note}</p>}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="Agent sessions" value={num(t.sessions)} sub="30 days" />
        <Stat label="Session hours" value={t.hours.toFixed(0)} />
        <Stat label="PRs opened w/ AI" value={t.prs_opened_with_ai} />
        <Stat label="PRs AI-reviewed" value={t.prs_reviewed_by_ai} />
        <Stat label="Co-authored commits" value={num(t.commits_co_authored)} />
      </div>

      <Panel kicker="sessions per week" title="What the agents worked on">
        <Legend items={cats.map((c, i) => ({ label: c, color: SERIES[i % SERIES.length] }))} />
        <div className="mt-3 h-[300px]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={weekly} margin={{ top: 8, right: 8, left: -12, bottom: 0 }} barCategoryGap="22%">
              <CartesianGrid {...gridProps} />
              <XAxis dataKey="week" {...axisProps} tickFormatter={shortDate} />
              <YAxis {...axisProps} width={52} allowDecimals={false} />
              <Tooltip cursor={{ fill: 'rgb(255 255 255 / 0.04)' }} content={<ChartTooltip fmt={num} labelFmt={(l) => `Week of ${shortDate(String(l))}`} total />} />
              {cats.map((c, i) => (
                <RBar key={c} dataKey={c} name={c} stackId="e" fill={SERIES[i % SERIES.length]} stroke="var(--color-panel)" strokeWidth={1.5} radius={i === cats.length - 1 ? [4, 4, 0, 0] : 0} isAnimationActive={false} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Panel>

      <div className="grid gap-5 lg:grid-cols-3">
        <Panel pad={false} kicker="hosts and tools" title="By agent">
          <ul className="divide-y divide-line">
            {eng.by_agent.map((a) => (
              <li key={a.agent} className="flex items-center justify-between gap-3 px-4 py-2.5">
                <div className="min-w-0">
                  <div className="truncate text-sm">{a.agent}</div>
                  <div className="font-mono text-[0.7rem] text-ink-3">{a.kind === 'local' ? 'local model' : 'hosted model'}</div>
                </div>
                <div className="text-right font-mono text-xs tnum">
                  <div>{a.sessions} sess</div>
                  <div className="text-ink-3">
                    {a.hours.toFixed(0)} h · {compact(a.tokens)} tok
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </Panel>
        <Panel kicker="share of sessions" title="By project">
          <ul className="space-y-2.5">
            {eng.by_project.map((p) => (
              <li key={p.project}>
                <div className="flex justify-between text-xs">
                  <span className="font-mono">{p.project}</span>
                  <span className="font-mono text-ink-2 tnum">{Math.round(p.share * 100)}%</span>
                </div>
                <div className="mt-1 h-1.5 rounded-full bg-line">
                  <div className="h-full rounded-full" style={{ width: `${p.share * 100 / eng.by_project[0].share}%`, background: orgColor(orgOfProject(p.project) ?? '') }} />
                </div>
              </li>
            ))}
          </ul>
        </Panel>
        <Panel kicker="12 weeks" title="By task type">
          <ul className="space-y-2.5">
            {catTotals.map(({ c, n }) => (
              <li key={c} className="flex items-center justify-between gap-2 text-sm">
                <span className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-[2px]" style={{ background: SERIES[cats.indexOf(c) % SERIES.length] }} />
                  {c}
                </span>
                <span className="font-mono text-xs text-ink-2 tnum">
                  {n} <span className="text-ink-3">· {Math.round((n / catSum) * 100)}%</span>
                </span>
              </li>
            ))}
          </ul>
          {eng.highlights.length > 0 && (
            <div className="mt-5 border-t border-line pt-3">
              <div className="label mb-2">highlights</div>
              <ul className="space-y-1.5 text-xs text-ink-2">
                {eng.highlights.map((h) => (
                  <li key={h} className="flex gap-2">
                    <span className="text-nixie">›</span>
                    {h}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Panel>
      </div>
    </div>
  )
}

export function AiUsage() {
  const [tab, setTab] = useState<'prod' | 'eng'>('prod')
  return (
    <div>
      <PageHead code="05" title="AI & agent usage telemetry">
        {shortDate(aiUsage.period.from)} – {shortDate(aiUsage.period.to)}. In-app usage comes from the worker pool's job
        logs; engineering usage comes from coding-agent session logs on each host.
      </PageHead>
      <div className="mb-4">
        <Segmented
          label="Category"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'prod', label: 'In-app / production' },
            { value: 'eng', label: 'Engineering agents' },
          ]}
        />
      </div>
      {tab === 'prod' ? <Production /> : <Engineering />}
    </div>
  )
}

import { Bar as RBar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { agents, velocity } from '../data'
import { compact, num, shortDate } from '../lib/format'
import { axisProps, ChartTooltip, gridProps, Legend } from '../components/charts'
import { Panel, Stat } from '../components/ui'

const YOU = 'var(--color-nixie)'
const AGENTS = 'var(--color-scan)'

/**
 * How much of the work is delegated: your attention vs agent working time, how many agents ran at once,
 * and what the tokens bought. Joined to velocity by local date; follows the page's range and org scope.
 */
export function DelegationPanel({ start, end, org, rangeLabel }: { start: string; end: string; org: string; rangeLabel: string }) {
  const inOrg = (p: string) => org === 'all' || p.startsWith(org + '/')
  const days = agents.days.filter((d) => d.date >= start && d.date <= end)
  if (!days.length) return null
  const first = agents.days[0]?.date

  let you = 0
  let busy = 0
  let anyBusy = 0
  let agentBusy = 0
  let peak = 0
  let prompts = 0
  let tokens = 0
  let cache = 0
  let jobs = 0
  let jobTokens = 0
  const chart = days.map((d) => {
    let dayBusy = 0
    for (const [p, m] of Object.entries(d.interactive)) {
      if (!inOrg(p)) continue
      dayBusy += m.busy_h
      prompts += m.prompts
      tokens += m.tokens_in + m.tokens_out
      cache += m.cache_read
    }
    for (const m of Object.values(d.automated)) {
      jobs += m.sessions
      jobTokens += m.tokens_in + m.tokens_out + m.cache_read
    }
    busy += dayBusy
    // Your attention and parallelism are only known across everything at once, not per org.
    you += d.attention_h
    anyBusy += d.parallel.any_busy_h
    agentBusy += d.parallel.agent_busy_h
    peak = Math.max(peak, d.parallel.peak)
    return { at: d.date, you: d.attention_h, agents: Math.round(dayBusy * 100) / 100 }
  })

  // Tokens per senior-equivalent hour, over the days that have session data.
  const dates = new Set(days.map((d) => d.date))
  let senior = 0
  let sets = 0
  let judged = 0
  for (const d of velocity.days) {
    if (!dates.has(d.date)) continue
    for (const [p, m] of Object.entries(d.by_project)) {
      if (!inOrg(p)) continue
      senior += m.senior ?? 0
      sets += m.sets ?? 0
      judged += m.judged ?? 0
    }
  }
  const allTokens = tokens + cache
  const judgedShare = sets ? judged / sets : 0

  return (
    <Panel
      className="mt-5"
      kicker={`${rangeLabel} · session data since ${shortDate(first)} · ${agents.hosts.map((h) => h.name).join(', ')}`}
      title="Delegation: your time vs the agents'"
    >
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="Your attention" value={`${you.toFixed(0)} h`} sub={`${num(prompts)} prompts${org !== 'all' ? ' · all orgs' : ''}`} />
        <Stat label="Agent working time" value={`${busy.toFixed(0)} h`} sub="interactive sessions + subagents" />
        <Stat label="Delegation" value={you ? `${(busy / you).toFixed(1)}×` : '—'} sub="agent hours per hour of yours" />
        <Stat
          label="Agents at once"
          value={anyBusy ? (agentBusy / anyBusy).toFixed(1) : '—'}
          sub={`average while any worked · peak ${peak}`}
        />
        <Stat
          label="Tokens per senior hour"
          value={senior ? compact(allTokens / senior) : '—'}
          sub={
            senior
              ? `${compact(allTokens)} tokens (${Math.round((cache / Math.max(allTokens, 1)) * 100)}% cache reads)${judgedShare < 0.95 ? ` · ${Math.round(judgedShare * 100)}% judged` : ''}`
              : 'needs judged change sets'
          }
        />
        <Stat label="App AI jobs" value={num(jobs)} sub={`${compact(jobTokens)} tokens, automated`} />
      </div>
      <div className="mt-4">
        <Legend
          items={[
            { label: 'Your attention', color: YOU },
            { label: 'Agent working time', color: AGENTS },
          ]}
        />
        <div className="mt-3 h-[240px]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chart} margin={{ top: 8, right: 8, left: -12, bottom: 0 }} barCategoryGap="18%" barGap={1}>
              <CartesianGrid {...gridProps} />
              <XAxis dataKey="at" {...axisProps} tickFormatter={shortDate} minTickGap={16} />
              <YAxis {...axisProps} tickFormatter={(v) => `${v}h`} width={44} />
              <Tooltip cursor={{ fill: 'rgb(255 255 255 / 0.04)' }} content={<ChartTooltip fmt={(v) => `${v.toFixed(1)} h`} labelFmt={(l) => shortDate(String(l))} />} />
              <RBar dataKey="you" name="Your attention" fill={YOU} radius={[3, 3, 0, 0]} isAnimationActive={false} />
              <RBar dataKey="agents" name="Agent working time" fill={AGENTS} radius={[3, 3, 0, 0]} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
      <div className="mt-3 space-y-1 text-xs text-ink-3">
        <p>{agents.method.attention}</p>
        <p>
          {agents.method.busy} {agents.method.parallel} {agents.method.automated}
        </p>
        <p>{agents.method.sources}</p>
      </div>
    </Panel>
  )
}

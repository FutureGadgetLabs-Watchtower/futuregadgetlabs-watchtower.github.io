import { useMemo, useState } from 'react'
import { changelog, orgs, roadmap } from '../data'
import { shortDate } from '../lib/format'
import type { ChangeType, RoadmapStatus } from '../types'
import { Bar, OrgTag, PageHead, Panel, Segmented, Select } from '../components/ui'

const COLUMNS: { id: RoadmapStatus; label: string; accent: string }[] = [
  { id: 'in_progress', label: 'In Progress', accent: 'text-nixie' },
  { id: 'planned', label: 'Planned', accent: 'text-scan' },
  { id: 'shipped', label: 'Shipped', accent: 'text-ink-2' },
]
const TYPE_LABEL: Record<ChangeType, string> = {
  feature: 'FEAT',
  fix: 'FIX',
  perf: 'PERF',
  infra: 'INFRA',
  security: 'SEC',
  docs: 'DOCS',
  breaking: 'BREAKING',
}
const PRIORITY_STYLE: Record<string, string> = {
  P0: 'border-nixie/60 text-nixie',
  P1: 'border-line-2 text-ink',
  P2: 'border-line text-ink-2',
  P3: 'border-line text-ink-3',
}

function Board() {
  const [org, setOrg] = useState('all')
  const [ms, setMs] = useState('all')
  const items = roadmap.items.filter((i) => (org === 'all' || i.org === org) && (ms === 'all' || i.milestone === ms))
  return (
    <>
      <div className="mb-4 flex flex-wrap gap-3">
        <Select
          label="Org"
          value={org}
          onChange={setOrg}
          options={[{ value: 'all', label: 'All orgs' }, ...orgs.map((o) => ({ value: o.id, label: o.name }))]}
        />
        <Select
          label="Milestone"
          value={ms}
          onChange={setMs}
          options={[{ value: 'all', label: 'All milestones' }, ...roadmap.milestones.map((m) => ({ value: m.id, label: m.title }))]}
        />
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        {COLUMNS.map((c) => {
          const col = items
            .filter((i) => i.status === c.id)
            .sort((a, b) => a.priority.localeCompare(b.priority) || a.target.localeCompare(b.target))
          return (
            <section key={c.id} className="rounded-xl border border-line bg-panel/60">
              <header className="flex items-center justify-between border-b border-line px-4 py-2.5">
                <h3 className={`font-mono text-xs font-semibold tracking-[0.14em] uppercase ${c.accent}`}>{c.label}</h3>
                <span className="font-mono text-xs text-ink-3">{col.length}</span>
              </header>
              <ul className="space-y-2.5 p-3">
                {col.map((i) => (
                  <li key={i.id} className="rounded-lg border border-line bg-void/50 p-3 hover:border-line-2">
                    <div className="flex items-start justify-between gap-2">
                      <a href={i.url ?? undefined} target="_blank" rel="noreferrer" className="text-sm font-medium leading-snug hover:text-scan">
                        {i.title}
                      </a>
                      <span className={`shrink-0 rounded border px-1.5 font-mono text-[0.65rem] ${PRIORITY_STYLE[i.priority]}`}>{i.priority}</span>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                      <OrgTag org={i.org} short />
                      <span className="font-mono text-[0.7rem] text-ink-3">{i.project}</span>
                    </div>
                    {c.id !== 'shipped' && i.progress > 0 && (
                      <div className="mt-2.5 flex items-center gap-2">
                        <div className="flex-1">
                          <Bar value={i.progress} tone={c.id === 'in_progress' ? 'nixie' : 'scan'} />
                        </div>
                        <span className="font-mono text-[0.7rem] text-ink-3 tnum">{i.progress}%</span>
                      </div>
                    )}
                    <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[0.7rem] text-ink-3">
                      <span className="font-mono">
                        {c.id === 'shipped' ? 'shipped' : 'target'} {shortDate(i.target)}
                      </span>
                      {i.tags.map((t) => (
                        <span key={t} className="rounded bg-panel-2 px-1.5 py-px">
                          {t}
                        </span>
                      ))}
                    </div>
                  </li>
                ))}
                {col.length === 0 && <li className="py-4 text-center text-xs text-ink-3">Empty</li>}
              </ul>
            </section>
          )
        })}
      </div>
    </>
  )
}

function Feed() {
  const [org, setOrg] = useState('all')
  const [type, setType] = useState('all')
  const [q, setQ] = useState('')
  const entries = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return changelog.entries
      .filter((e) => (org === 'all' || e.org === org) && (type === 'all' || e.type === type))
      .filter((e) => !needle || `${e.title} ${e.body ?? ''} ${e.project} ${e.version}`.toLowerCase().includes(needle))
      .sort((a, b) => b.date.localeCompare(a.date))
  }, [org, type, q])

  // group by month
  const groups = entries.reduce<Record<string, typeof entries>>((acc, e) => {
    const k = new Date(e.date + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
    ;(acc[k] ??= []).push(e)
    return acc
  }, {})
  const types = [...new Set(changelog.entries.map((e) => e.type))]

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Select
          label="Org"
          value={org}
          onChange={setOrg}
          options={[{ value: 'all', label: 'All orgs' }, ...orgs.map((o) => ({ value: o.id, label: o.name }))]}
        />
        <Select
          label="Type"
          value={type}
          onChange={setType}
          options={[{ value: 'all', label: 'All types' }, ...types.map((t) => ({ value: t, label: TYPE_LABEL[t] }))]}
        />
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search notes…"
          className="w-full rounded-lg border border-line bg-void/60 px-3 py-1.5 text-sm text-ink placeholder:text-ink-3 focus:border-scan sm:w-64"
        />
        <span className="font-mono text-xs text-ink-3">{entries.length} entries</span>
      </div>
      <div className="space-y-6">
        {Object.entries(groups).map(([month, list]) => (
          <section key={month}>
            <h3 className="label mb-2">{month}</h3>
            <ol className="relative ml-2 border-l border-line">
              {list.map((e) => (
                <li key={e.id} className="relative pb-4 pl-5 last:pb-0">
                  <span
                    className={`absolute top-1.5 -left-[5px] h-[9px] w-[9px] rounded-full border-2 border-void ${
                      e.type === 'breaking' ? 'bg-bad' : e.type === 'security' ? 'bg-warn' : 'bg-line-2'
                    }`}
                  />
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="font-mono text-xs text-ink-3 tnum">{shortDate(e.date)}</span>
                    <span
                      className={`rounded border px-1.5 font-mono text-[0.62rem] tracking-wider ${
                        e.type === 'breaking' ? 'border-bad/50 text-bad' : e.type === 'security' ? 'border-warn/50 text-warn' : 'border-line-2 text-ink-2'
                      }`}
                    >
                      {TYPE_LABEL[e.type]}
                    </span>
                    <OrgTag org={e.org} short />
                    <a href={e.url ?? undefined} target="_blank" rel="noreferrer" className="font-mono text-xs text-ink-2 hover:text-scan">
                      {e.project}@{e.version}
                    </a>
                  </div>
                  <div className="mt-1 text-sm text-ink">{e.title}</div>
                  {e.body && <p className="mt-0.5 text-sm text-ink-3">{e.body}</p>}
                </li>
              ))}
            </ol>
          </section>
        ))}
        {entries.length === 0 && <p className="text-sm text-ink-3">No entries match.</p>}
      </div>
    </>
  )
}

export function Roadmap() {
  const [tab, setTab] = useState<'board' | 'feed'>(() => (window.location.hash.includes('feed') ? 'feed' : 'board'))
  const shipped = roadmap.items.filter((i) => i.status === 'shipped').length
  return (
    <div>
      <PageHead code="04" title="Features, patch notes & roadmap">
        One roadmap and one release feed for every org. Items come from GitHub milestones and issues; notes come from
        releases.
      </PageHead>
      <Panel
        kicker={`${roadmap.items.length} roadmap items · ${shipped} shipped · ${changelog.entries.length} release notes`}
        title={tab === 'board' ? 'Roadmap' : 'Patch notes'}
        right={
          <Segmented
            label="View"
            value={tab}
            onChange={(v) => {
              setTab(v)
              history.replaceState(null, '', v === 'feed' ? '#/roadmap?feed' : '#/roadmap')
            }}
            options={[
              { value: 'board', label: 'Roadmap' },
              { value: 'feed', label: 'Patch notes' },
            ]}
          />
        }
      >
        {tab === 'board' ? <Board /> : <Feed />}
      </Panel>
    </div>
  )
}

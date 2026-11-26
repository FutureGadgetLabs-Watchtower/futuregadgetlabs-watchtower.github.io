import { useMemo, useState } from 'react'
import { health, orgs } from '../data'
import { effectiveStatus, streak, timeAgo } from '../lib/format'
import type { DisplayStatus, Service } from '../types'
import { Bar, OrgTag, PageHead, Panel, Select, StatusBadge, statusDot } from '../components/ui'

const ORDER: DisplayStatus[] = ['OFFLINE', 'DEGRADED', 'STALE', 'ONLINE']
const KIND_LABEL: Record<Service['kind'], string> = {
  node: 'Proxmox node',
  lxc: 'LXC',
  vm: 'VM',
  pages: 'Static site',
  worker: 'Agent worker',
  network: 'Network',
  external: 'External',
}

function History({ h }: { h: Service['history'] }) {
  return (
    <div className="flex h-4 items-end gap-[2px]" aria-label={`Last ${h.length} checks`}>
      {h.map((s, i) => (
        <span
          key={i}
          title={s}
          className={`w-[3px] rounded-[1px] ${statusDot(s)} ${s === 'ONLINE' ? 'h-full opacity-60' : 'h-full'}`}
        />
      ))}
    </div>
  )
}

export function Health({ now }: { now: number }) {
  const [org, setOrg] = useState('all')
  const [kind, setKind] = useState('all')
  const [problemsOnly, setProblemsOnly] = useState(false)

  const services = useMemo(
    () =>
      health.services
        .map((s) => ({ ...s, display: effectiveStatus(s, now) }))
        .filter((s) => (org === 'all' || s.org === org) && (kind === 'all' || s.kind === kind))
        .filter((s) => !problemsOnly || s.display !== 'ONLINE')
        .sort((a, b) => ORDER.indexOf(a.display) - ORDER.indexOf(b.display) || a.name.localeCompare(b.name)),
    [org, kind, problemsOnly, now],
  )

  const counts = useMemo(() => {
    const c: Record<DisplayStatus, number> = { ONLINE: 0, DEGRADED: 0, OFFLINE: 0, STALE: 0 }
    health.services.forEach((s) => c[effectiveStatus(s, now)]++)
    return c
  }, [now])
  const total = health.services.length
  const kinds = [...new Set(health.services.map((s) => s.kind))]

  return (
    <div>
      <PageHead code="01" title="System healthcheck & node status">
        Every service across the orgs and the Proxmox cluster, as of the last collector run. A service whose last check
        is more than 24 hours old shows as STALE, whatever its last known state.
      </PageHead>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {(['ONLINE', 'DEGRADED', 'OFFLINE', 'STALE'] as DisplayStatus[]).map((s) => (
          <button
            key={s}
            onClick={() => setProblemsOnly(s !== 'ONLINE' && !problemsOnly)}
            className="rounded-xl border border-line bg-panel/85 px-4 py-3 text-left hover:border-line-2"
          >
            <StatusBadge status={s} />
            <div className="mt-2 font-mono text-3xl font-semibold tnum">
              {counts[s]}
              <span className="ml-1 text-sm text-ink-3">/ {total}</span>
            </div>
          </button>
        ))}
      </div>

      <div className="mt-5 grid gap-3 lg:grid-cols-2">
        {health.nodes.map((n) => (
          <Panel
            key={n.id}
            kicker={`proxmox ve ${n.pve_version}`}
            title={
              <span className="font-mono">
                {n.name} <span className="font-sans text-sm font-normal text-ink-3">· {n.role}</span>
              </span>
            }
            right={<span className="font-mono text-xs text-ink-3">up {n.uptime_days}d</span>}
          >
            <div className="mb-3 text-xs text-ink-3">{n.cpu}</div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              {[
                { l: 'CPU', v: n.cpu_pct, t: `${n.cpu_pct.toFixed(0)}%`, max: 100 },
                { l: 'Memory', v: n.mem_used_gb, t: `${n.mem_used_gb.toFixed(0)} / ${n.mem_total_gb} GB`, max: n.mem_total_gb },
                { l: 'Disk', v: n.disk_used_tb, t: `${n.disk_used_tb} / ${n.disk_total_tb} TB`, max: n.disk_total_tb },
              ].map((m) => (
                <div key={m.l}>
                  <div className="mb-1 flex justify-between text-xs">
                    <span className="label">{m.l}</span>
                    <span className="font-mono text-ink-2 tnum">{m.t}</span>
                  </div>
                  <Bar value={m.v} max={m.max} tone={m.v / m.max > 0.85 ? 'warn' : 'scan'} />
                </div>
              ))}
            </div>
            <div className="mt-3 text-xs text-ink-3">
              Guests running <span className="font-mono text-ink-2">{n.guests_running}</span> / {n.guests_total}
            </div>
          </Panel>
        ))}
      </div>

      <Panel
        className="mt-5"
        pad={false}
        kicker="services"
        title={`${services.length} shown`}
        right={
          <div className="flex flex-wrap items-center gap-3">
            <Select
              label="Org"
              value={org}
              onChange={setOrg}
              options={[{ value: 'all', label: 'All orgs' }, ...orgs.map((o) => ({ value: o.id, label: o.name }))]}
            />
            <Select
              label="Type"
              value={kind}
              onChange={setKind}
              options={[{ value: 'all', label: 'All types' }, ...kinds.map((k) => ({ value: k, label: KIND_LABEL[k] }))]}
            />
            <label className="flex items-center gap-2 text-xs text-ink-2">
              <input type="checkbox" checked={problemsOnly} onChange={(e) => setProblemsOnly(e.target.checked)} className="accent-[var(--color-nixie)]" />
              Problems only
            </label>
          </div>
        }
      >
        {/* table on wide screens */}
        <div className="hidden overflow-x-auto md:block">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left">
                {['Service', 'Org', 'Where', 'Status', 'Latency', 'Streak', '30d', 'Last 48 checks', 'Checked'].map((h) => (
                  <th key={h} className="label px-4 py-2 font-normal">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {services.map((s) => (
                <tr key={s.id} className="border-b border-line/70 align-top last:border-0 hover:bg-panel-2/60">
                  <td className="px-4 py-2.5">
                    <div className="font-medium text-ink">{s.name}</div>
                    {s.notes && <div className="mt-0.5 max-w-xs text-xs text-ink-3">{s.notes}</div>}
                  </td>
                  <td className="px-4 py-2.5">
                    <OrgTag org={s.org} short />
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-xs text-ink-2">
                    <div>{s.host}</div>
                    <div className="text-ink-3">
                      {KIND_LABEL[s.kind]} · {s.check}
                    </div>
                  </td>
                  <td className="px-4 py-2.5">
                    <StatusBadge status={s.display} />
                  </td>
                  <td className="px-4 py-2.5 font-mono text-xs text-ink-2 tnum">
                    {s.latency_ms == null ? '—' : `${s.latency_ms} ms`}
                  </td>
                  <td className="px-4 py-2.5 font-mono text-xs text-ink-2 tnum">{streak(s.uptime_streak_hours)}</td>
                  <td className="px-4 py-2.5 font-mono text-xs text-ink-2 tnum">{s.uptime_30d_pct.toFixed(2)}%</td>
                  <td className="px-4 py-2.5">
                    <History h={s.history} />
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-xs text-ink-3" title={s.last_checked}>
                    {timeAgo(s.last_checked, now)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* cards on phones */}
        <ul className="divide-y divide-line md:hidden">
          {services.map((s) => (
            <li key={s.id} className="px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-medium">{s.name}</div>
                  <div className="mt-0.5 text-xs text-ink-3">
                    {s.host} · {KIND_LABEL[s.kind]}
                  </div>
                </div>
                <StatusBadge status={s.display} />
              </div>
              {s.notes && <div className="mt-1.5 text-xs text-ink-3">{s.notes}</div>}
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs text-ink-2">
                <span>{s.latency_ms == null ? '—' : `${s.latency_ms} ms`}</span>
                <span>streak {streak(s.uptime_streak_hours)}</span>
                <span>{s.uptime_30d_pct.toFixed(1)}% 30d</span>
                <span className="text-ink-3">{timeAgo(s.last_checked, now)}</span>
              </div>
              <div className="mt-2">
                <History h={s.history} />
              </div>
            </li>
          ))}
        </ul>
        {services.length === 0 && <p className="p-6 text-center text-sm text-ink-3">Nothing matches these filters.</p>}
      </Panel>
    </div>
  )
}

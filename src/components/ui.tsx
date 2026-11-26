import type { ReactNode } from 'react'
import type { DisplayStatus } from '../types'
import { orgColor } from '../data'

export function Panel({
  title,
  kicker,
  right,
  children,
  className = '',
  pad = true,
}: {
  title?: ReactNode
  kicker?: string
  right?: ReactNode
  children: ReactNode
  className?: string
  pad?: boolean
}) {
  return (
    <section className={`rounded-xl border border-line bg-panel/85 backdrop-blur-sm ${className}`}>
      {(title || right) && (
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
          <div>
            {kicker && <div className="label">{kicker}</div>}
            {title && <h2 className="text-[0.95rem] font-semibold text-ink">{title}</h2>}
          </div>
          {right}
        </header>
      )}
      <div className={pad ? 'p-4' : ''}>{children}</div>
    </section>
  )
}

export function PageHead({ code, title, children }: { code: string; title: string; children?: ReactNode }) {
  return (
    <div className="mb-5">
      <div className="label">
        <span className="text-nixie">MODULE {code}</span> // {title}
      </div>
      {children && <p className="mt-1.5 max-w-3xl text-sm text-ink-2">{children}</p>}
    </div>
  )
}

export function Stat({
  label,
  value,
  sub,
  delta,
}: {
  label: string
  value: ReactNode
  sub?: ReactNode
  delta?: number | null
}) {
  return (
    <div className="rounded-xl border border-line bg-panel/85 px-4 py-3">
      <div className="label">{label}</div>
      <div className="mt-1 font-mono text-2xl font-semibold text-ink tnum">{value}</div>
      <div className="mt-0.5 flex items-center gap-2 text-xs text-ink-3">
        {delta != null && Number.isFinite(delta) && (
          <span className={`font-mono ${delta >= 0 ? 'text-ink-2' : 'text-ink-3'}`}>
            {delta >= 0 ? '▲' : '▼'} {Math.abs(Math.round(delta * 100))}%
          </span>
        )}
        {sub}
      </div>
    </div>
  )
}

const STATUS_STYLE: Record<DisplayStatus, { dot: string; text: string; ring: string; glyph: string }> = {
  ONLINE: { dot: 'bg-ok', text: 'text-ok', ring: 'border-ok/35 bg-ok/8', glyph: '●' },
  DEGRADED: { dot: 'bg-warn', text: 'text-warn', ring: 'border-warn/40 bg-warn/8', glyph: '▲' },
  OFFLINE: { dot: 'bg-bad', text: 'text-bad', ring: 'border-bad/40 bg-bad/8', glyph: '■' },
  STALE: { dot: 'bg-stale', text: 'text-stale', ring: 'border-stale/40 bg-stale/8', glyph: '◌' },
}
export const statusDot = (s: DisplayStatus) => STATUS_STYLE[s].dot

export function StatusBadge({ status }: { status: DisplayStatus }) {
  const s = STATUS_STYLE[status]
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 font-mono text-[0.68rem] font-semibold tracking-[0.12em] ${s.ring} ${s.text}`}
    >
      <span aria-hidden>{s.glyph}</span>
      {status}
    </span>
  )
}

export function OrgTag({ org, short = false }: { org: string; short?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-ink-2">
      <span className="h-2 w-2 shrink-0 rounded-[2px]" style={{ background: orgColor(org) }} aria-hidden />
      <span className="truncate">{short ? org.replace('FutureGadgetLabs-', 'FGL-') : org}</span>
    </span>
  )
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
  label: string
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-lg border border-line bg-void/60 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={`rounded-md px-2.5 py-1 font-mono text-[0.7rem] tracking-wider transition-colors ${
            value === o.value ? 'bg-panel-2 text-ink shadow-[inset_0_0_0_1px_var(--color-line-2)]' : 'text-ink-3 hover:text-ink-2'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Select({
  value,
  onChange,
  options,
  label,
}: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
  label: string
}) {
  return (
    <label className="inline-flex items-center gap-2">
      <span className="label">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-lg border border-line bg-void/60 px-2 py-1 text-xs text-ink focus:border-scan"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  )
}

export function Bar({ value, max = 100, tone = 'scan' }: { value: number; max?: number; tone?: 'scan' | 'nixie' | 'warn' }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100))
  const bg = tone === 'nixie' ? 'bg-nixie' : tone === 'warn' ? 'bg-warn' : 'bg-scan'
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-line" role="presentation">
      <div className={`h-full rounded-full ${bg}`} style={{ width: `${pct}%` }} />
    </div>
  )
}

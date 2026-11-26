import type { ReactNode } from 'react'

// Shared Recharts styling. Grid and axes stay recessive; text uses ink tokens, never series colors.
export const axisProps = {
  stroke: 'var(--color-line-2)',
  tick: { fill: 'var(--color-ink-3)', fontSize: 11, fontFamily: 'var(--font-mono)' },
  tickLine: false,
  axisLine: false,
} as const
export const gridProps = { stroke: 'var(--color-line)', strokeDasharray: '0', vertical: false } as const

/** 7-slot categorical order validated for the dark surface (dataviz validator, adjacent pairs). */
export const SERIES = ['#338ced', '#e76624', '#00a888', '#d28e05', '#e24d8b', '#0aac23', '#9887ef']

type TipPayload = { name?: string | number; value?: number | string; color?: string; dataKey?: string | number }
export function ChartTooltip({
  active,
  payload,
  label,
  fmt = (v) => String(v),
  labelFmt = (l) => String(l),
  total = false,
}: {
  active?: boolean
  payload?: TipPayload[]
  label?: string | number
  fmt?: (v: number) => string
  labelFmt?: (l: string | number) => ReactNode
  total?: boolean
}) {
  if (!active || !payload?.length) return null
  const rows = [...payload].reverse()
  const sum = payload.reduce((a, p) => a + (Number(p.value) || 0), 0)
  return (
    <div className="min-w-44 rounded-lg border border-line-2 bg-panel/95 px-3 py-2 text-xs shadow-xl">
      <div className="mb-1.5 font-mono text-ink-2">{label != null ? labelFmt(label) : ''}</div>
      {rows.map((p) => (
        <div key={String(p.dataKey)} className="flex items-center justify-between gap-4 py-0.5">
          <span className="flex items-center gap-1.5 text-ink-2">
            <span className="h-2 w-2 rounded-[2px]" style={{ background: p.color }} />
            {p.name}
          </span>
          <span className="font-mono text-ink tnum">{fmt(Number(p.value))}</span>
        </div>
      ))}
      {total && rows.length > 1 && (
        <div className="mt-1 flex justify-between border-t border-line pt-1 text-ink-2">
          <span>Total</span>
          <span className="font-mono text-ink tnum">{fmt(sum)}</span>
        </div>
      )}
    </div>
  )
}

export function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-ink-2">
      {items.map((i) => (
        <li key={i.label} className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-[2px]" style={{ background: i.color }} aria-hidden />
          {i.label}
        </li>
      ))}
    </ul>
  )
}

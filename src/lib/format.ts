import type { DisplayStatus, Service } from '../types'

export const STALE_AFTER_MS = 24 * 60 * 60 * 1000

export function ageMs(iso: string, now: number) {
  return now - new Date(iso).getTime()
}

export function timeAgo(iso: string, now: number) {
  const s = Math.max(0, Math.round(ageMs(iso, now) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

export function effectiveStatus(s: Service, now: number): DisplayStatus {
  return ageMs(s.last_checked, now) > STALE_AFTER_MS ? 'STALE' : s.status
}

const nf = new Intl.NumberFormat('en-US')
export const num = (n: number) => nf.format(n)
export function compact(n: number) {
  if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (Math.abs(n) >= 1e4) return `${(n / 1e3).toFixed(1)}k`
  return nf.format(Math.round(n))
}

export function utcStamp(iso: string) {
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}.${p(d.getUTCMonth() + 1)}.${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
}

export function shortDate(iso: string) {
  return new Date(iso + (iso.length === 10 ? 'T00:00:00Z' : '')).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
}

export function streak(hours: number) {
  if (hours <= 0) return '—'
  if (hours < 48) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

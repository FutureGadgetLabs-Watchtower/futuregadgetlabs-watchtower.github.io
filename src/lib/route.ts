import { useEffect, useState } from 'react'

// Hash routing: GitHub Pages has no SPA fallback, and #/velocity deep links survive any base path.
export const ROUTES = [
  { id: 'health', label: 'Health', code: '01' },
  { id: 'velocity', label: 'Velocity', code: '02' },
  { id: 'architecture', label: 'Architecture', code: '03' },
  { id: 'roadmap', label: 'Roadmap', code: '04' },
  { id: 'ai', label: 'AI Telemetry', code: '05' },
] as const
export type RouteId = (typeof ROUTES)[number]['id']

function read(): RouteId {
  const h = window.location.hash.replace(/^#\/?/, '').split('?')[0]
  return (ROUTES.find((r) => r.id === h)?.id ?? 'health') as RouteId
}

export function useRoute() {
  const [route, setRoute] = useState<RouteId>(read)
  useEffect(() => {
    const on = () => {
      setRoute(read())
      window.scrollTo({ top: 0 })
    }
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return route
}

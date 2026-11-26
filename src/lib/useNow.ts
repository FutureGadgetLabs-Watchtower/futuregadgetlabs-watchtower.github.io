import { useEffect, useState } from 'react'

/** Wall clock that ticks once a minute so "x ago" labels and STALE badges update in an open tab. */
export function useNow(intervalMs = 60_000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(t)
  }, [intervalMs])
  return now
}

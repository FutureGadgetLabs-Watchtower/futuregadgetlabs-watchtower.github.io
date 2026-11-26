import { BUILT_AT, health, isMock, syncTimes } from '../data'
import { ageMs, STALE_AFTER_MS, timeAgo, utcStamp } from '../lib/format'
import { ROUTES, type RouteId } from '../lib/route'

function syncState(now: number) {
  const oldest = syncTimes.reduce((a, b) => (a.at < b.at ? a : b))
  const newest = syncTimes.reduce((a, b) => (a.at > b.at ? a : b))
  const age = ageMs(newest.at, now)
  const state = age > STALE_AFTER_MS ? 'CACHED' : age > 60 * 60 * 1000 ? 'RECENT' : 'LIVE'
  return { newest, oldest, state }
}

export function Header({ route, now }: { route: RouteId; now: number }) {
  const { newest, oldest, state } = syncState(now)
  const stale = state === 'CACHED'
  const stamp = utcStamp(newest.at)
  return (
    <header className="sticky top-0 z-30 border-t-3 border-b border-t-band border-b-line bg-void/85 backdrop-blur-md">
      <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3">
        <a href="#/health" className="flex items-center gap-3">
          <img src={`${import.meta.env.BASE_URL}mark-dark.svg`} alt="" className="h-10 w-auto" width={27} height={40} />
          <div className="leading-none">
            <div className="font-display text-[0.68rem] font-medium tracking-[0.18em] text-ink-2 uppercase">
              Future Gadget Labs
            </div>
            <div className="mt-1 font-display text-2xl font-semibold tracking-[0.01em] text-white">Watchtower</div>
          </div>
        </a>

        <div
          className="ml-auto flex items-center gap-3 rounded-lg border border-line bg-panel/80 px-3 py-2"
          title={`Newest: ${newest.file} ${newest.at}\nOldest: ${oldest.file} ${oldest.at}\nCollector: ${health.collector.host} v${health.collector.version}\nSite built: ${BUILT_AT}`}
        >
          <div className="hidden sm:block">
            <div className="label !text-[0.6rem]">Last Proxmox sync (UTC)</div>
            <div className="text-[0.7rem] text-ink-3">
              {timeAgo(newest.at, now)} · via {health.collector.host}
            </div>
          </div>
          <div className="nixie-cell rounded-md px-2.5 py-1">
            <span className={`nixie text-base sm:text-lg ${stale ? 'is-stale' : ''}`}>{stamp}</span>
          </div>
          <span
            className={`rounded-md border px-2 py-1 font-mono text-[0.65rem] font-semibold tracking-[0.14em] ${
              stale
                ? 'border-stale/50 text-stale'
                : state === 'LIVE'
                  ? 'border-ok/50 text-ok'
                  : 'border-scan/50 text-scan'
            }`}
          >
            {stale ? '◌ CACHED' : state === 'LIVE' ? '● LIVE' : '● RECENT'}
          </span>
        </div>
      </div>

      <nav aria-label="Modules" className="mx-auto max-w-[1400px] overflow-x-auto px-2">
        <ul className="flex min-w-max gap-1 px-2">
          {ROUTES.map((r) => {
            const active = r.id === route
            return (
              <li key={r.id}>
                <a
                  href={`#/${r.id}`}
                  aria-current={active ? 'page' : undefined}
                  className={`flex items-center gap-2 border-b-2 px-3 py-2.5 text-sm transition-colors ${
                    active ? 'border-nixie text-ink' : 'border-transparent text-ink-3 hover:text-ink-2'
                  }`}
                >
                  <span className={`font-mono text-[0.65rem] ${active ? 'text-nixie' : ''}`}>{r.code}</span>
                  {r.label}
                </a>
              </li>
            )
          })}
        </ul>
      </nav>

      {(stale || isMock) && (
        <div className={`border-t ${stale ? 'border-stale/30 bg-stale/8' : 'border-nixie/25 bg-nixie/6'}`}>
          <p className="mx-auto max-w-[1400px] px-4 py-1.5 text-xs text-ink-2">
            {stale && (
              <>
                <span className="font-mono text-stale">HOMELAB OFFLINE OR COLLECTOR PAUSED.</span> Showing data cached
                at {stamp} UTC ({timeAgo(newest.at, now)}). Everything below is a snapshot.{' '}
              </>
            )}
            {isMock && (
              <>
                <span className="font-mono text-nixie">SAMPLE DATA.</span> These numbers are mock values until the
                collector's first real run.
              </>
            )}
          </p>
        </div>
      )}
    </header>
  )
}

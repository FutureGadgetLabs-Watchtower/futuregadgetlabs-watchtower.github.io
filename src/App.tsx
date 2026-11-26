import { lazy, Suspense } from 'react'
import { Header } from './components/Header'
import { BUILT_AT, health } from './data'
import { utcStamp } from './lib/format'
import { useRoute } from './lib/route'
import { useNow } from './lib/useNow'
import { Health } from './views/Health'

// Views other than Health load on demand so the first paint stays small.
const Velocity = lazy(() => import('./views/Velocity').then((m) => ({ default: m.Velocity })))
const Architecture = lazy(() => import('./views/Architecture').then((m) => ({ default: m.Architecture })))
const Roadmap = lazy(() => import('./views/Roadmap').then((m) => ({ default: m.Roadmap })))
const AiUsage = lazy(() => import('./views/AiUsage').then((m) => ({ default: m.AiUsage })))

export default function App() {
  const route = useRoute()
  const now = useNow()
  return (
    <>
      <Header route={route} now={now} />
      <main className="relative mx-auto max-w-[1400px] px-4 py-6">
        <Suspense fallback={<div className="py-20 text-center font-mono text-xs text-ink-3">loading module…</div>}>
          {route === 'health' && <Health now={now} />}
          {route === 'velocity' && <Velocity />}
          {route === 'architecture' && <Architecture />}
          {route === 'roadmap' && <Roadmap />}
          {route === 'ai' && <AiUsage />}
        </Suspense>
      </main>
      <footer className="mx-auto flex max-w-[1400px] flex-wrap justify-between gap-2 px-4 pt-4 pb-10 font-mono text-[0.68rem] text-ink-3">
        <span>
          static build {utcStamp(BUILT_AT)} UTC · collector v{health.collector.version} · no runtime API calls
        </span>
        <a className="hover:text-ink-2" href="https://github.com/FutureGadgetLabs-Watchtower" target="_blank" rel="noreferrer">
          github.com/FutureGadgetLabs-Watchtower
        </a>
      </footer>
    </>
  )
}

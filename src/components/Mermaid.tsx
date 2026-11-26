import { useEffect, useId, useRef, useState } from 'react'

let mermaidReady: Promise<typeof import('mermaid').default> | null = null
function loadMermaid() {
  // Mermaid is large; load it only when the Architecture view is opened.
  mermaidReady ??= import('mermaid').then(({ default: m }) => {
    m.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'base',
      fontFamily: 'JetBrains Mono, ui-monospace, monospace',
      themeVariables: {
        darkMode: true,
        background: '#0b1626',
        primaryColor: '#172b46',
        primaryBorderColor: '#3dd6c6',
        primaryTextColor: '#e6ecf3',
        secondaryColor: '#140b02',
        tertiaryColor: '#12233a',
        lineColor: '#8494aa',
        textColor: '#e6ecf3',
        clusterBkg: '#0e1d33',
        clusterBorder: '#2a4266',
        edgeLabelBackground: '#12233a',
        actorBkg: '#172b46',
        actorBorder: '#ff9f1c',
        actorTextColor: '#e6ecf3',
        signalColor: '#9aa8ba',
        signalTextColor: '#e6ecf3',
        noteBkgColor: '#140b02',
        noteBorderColor: '#ff9f1c',
        noteTextColor: '#e6ecf3',
        fontSize: '13px',
      },
    })
    return m
  })
  return mermaidReady
}

export function Mermaid({ code, title }: { code: string; title?: string }) {
  const id = 'm' + useId().replace(/[^a-zA-Z0-9]/g, '')
  const [svg, setSvg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [zoom, setZoom] = useState(1)
  const [full, setFull] = useState(false)
  const [showSrc, setShowSrc] = useState(false)
  const viewport = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; y: number; sl: number; st: number } | null>(null)

  useEffect(() => {
    let alive = true
    loadMermaid()
      .then((m) => m.render(id, code))
      .then(({ svg }) => alive && setSvg(svg))
      .catch((e: unknown) => alive && setErr(String(e instanceof Error ? e.message : e)))
    return () => {
      alive = false
    }
  }, [code, id])

  useEffect(() => {
    if (!full) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setFull(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [full])

  const btn = 'rounded-md border border-line px-2 py-0.5 font-mono text-xs text-ink-2 hover:border-line-2 hover:text-ink'
  const frame = full
    ? 'fixed inset-3 z-50 flex flex-col rounded-xl border border-line-2 bg-panel shadow-2xl'
    : 'relative flex flex-col rounded-xl border border-line bg-[#0e1d33]'

  return (
    <>
      {full && <div className="fixed inset-0 z-40 bg-void/80" onClick={() => setFull(false)} />}
      <figure className={`${frame} my-4`}>
        <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
          <figcaption className="label">{title ?? 'diagram'}</figcaption>
          <div className="flex gap-1.5">
            <button className={btn} onClick={() => setZoom((z) => Math.max(0.4, z - 0.2))} aria-label="Zoom out">
              −
            </button>
            <button className={btn} onClick={() => setZoom(1)} aria-label="Reset zoom">
              {Math.round(zoom * 100)}%
            </button>
            <button className={btn} onClick={() => setZoom((z) => Math.min(3, z + 0.2))} aria-label="Zoom in">
              +
            </button>
            <button className={btn} onClick={() => setShowSrc((s) => !s)}>
              {showSrc ? 'diagram' : 'source'}
            </button>
            <button className={btn} onClick={() => setFull((f) => !f)}>
              {full ? 'close' : 'expand'}
            </button>
          </div>
        </div>
        <div
          ref={viewport}
          className={`overflow-auto ${full ? 'flex-1' : 'max-h-[620px]'} cursor-grab active:cursor-grabbing`}
          onPointerDown={(e) => {
            const v = viewport.current
            if (!v) return
            drag.current = { x: e.clientX, y: e.clientY, sl: v.scrollLeft, st: v.scrollTop }
          }}
          onPointerMove={(e) => {
            const v = viewport.current
            if (!v || !drag.current) return
            v.scrollLeft = drag.current.sl - (e.clientX - drag.current.x)
            v.scrollTop = drag.current.st - (e.clientY - drag.current.y)
          }}
          onPointerUp={() => (drag.current = null)}
          onPointerLeave={() => (drag.current = null)}
        >
          {showSrc ? (
            <pre className="p-4 font-mono text-xs leading-relaxed text-ink-2">{code}</pre>
          ) : err ? (
            <div className="p-4 text-sm text-bad">
              Diagram failed to render: {err}
              <pre className="mt-3 font-mono text-xs text-ink-3">{code}</pre>
            </div>
          ) : svg ? (
            <div
              className="mermaid-host flex min-w-fit justify-center p-6"
              style={{ zoom }}
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          ) : (
            <div className="p-8 text-center font-mono text-xs text-ink-3">rendering…</div>
          )}
        </div>
      </figure>
    </>
  )
}

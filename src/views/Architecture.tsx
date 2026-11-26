import { Fragment, useMemo } from 'react'
import { marked, type Token, type Tokens } from 'marked'
import { architecture } from '../data'
import { Mermaid } from '../components/Mermaid'
import { PageHead } from '../components/ui'

type Block = { kind: 'html'; html: string } | { kind: 'mermaid'; code: string; title: string }

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')

// Split /data/architecture.md into HTML runs and ```mermaid blocks, so each diagram becomes a live component.
// The markdown is our own repo content, rendered at build time into the bundle; it is trusted.
function parse(md: string) {
  const tokens = marked.lexer(md)
  const blocks: Block[] = []
  const toc: { id: string; text: string }[] = []
  let run: Token[] = []
  let lastHeading = 'diagram'
  const flush = () => {
    if (!run.length) return
    blocks.push({ kind: 'html', html: wrapTables(marked.parser(Object.assign(run, { links: tokens.links }))) })
    run = []
  }
  for (const t of tokens) {
    if (t.type === 'heading') {
      lastHeading = (t as Tokens.Heading).text
      if ((t as Tokens.Heading).depth === 2) toc.push({ id: slug(lastHeading), text: lastHeading })
    }
    if (t.type === 'code' && (t as Tokens.Code).lang === 'mermaid') {
      flush()
      blocks.push({ kind: 'mermaid', code: (t as Tokens.Code).text, title: lastHeading })
    } else run.push(t)
  }
  flush()
  return { blocks, toc }
}

marked.use({
  gfm: true,
  renderer: {
    heading({ tokens, depth }) {
      const text = this.parser.parseInline(tokens)
      return `<h${depth} id="${slug(text.replace(/<[^>]+>/g, ''))}">${text}</h${depth}>`
    },
  },
})
// wide tables scroll inside their own box instead of the page
const wrapTables = (html: string) =>
  html.replace(/<table>/g, '<div class="table-wrap"><table>').replace(/<\/table>/g, '</table></div>')

export function Architecture() {
  const { blocks, toc } = useMemo(() => parse(architecture), [])
  return (
    <div>
      <PageHead code="03" title="Homelab infrastructure, architecture & CI/CD">
        Rendered from <code className="font-mono text-ink">data/architecture.md</code>. Diagrams are Mermaid: drag to pan,
        zoom, expand, or view the source.
      </PageHead>
      <div className="grid gap-8 lg:grid-cols-[200px_1fr]">
        <aside className="hidden lg:block">
          <nav className="sticky top-36 space-y-1 border-l border-line pl-3" aria-label="Sections">
            <div className="label mb-2">sections</div>
            {toc.map((t) => (
              <a
                key={t.id}
                href={`#/architecture`}
                onClick={(e) => {
                  e.preventDefault()
                  document.getElementById(t.id)?.scrollIntoView({ behavior: 'smooth' })
                }}
                className="block py-0.5 text-sm text-ink-3 hover:text-ink"
              >
                {t.text}
              </a>
            ))}
          </nav>
        </aside>
        <article className="prose-wt min-w-0">
          {blocks.map((b, i) => (
            <Fragment key={i}>
              {b.kind === 'html' ? (
                <div dangerouslySetInnerHTML={{ __html: b.html }} />
              ) : (
                <Mermaid code={b.code} title={b.title} />
              )}
            </Fragment>
          ))}
        </article>
      </div>
    </div>
  )
}

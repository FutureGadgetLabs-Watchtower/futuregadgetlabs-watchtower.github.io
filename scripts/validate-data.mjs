// Sanity checks on /data before a build. Catches a truncated or malformed collector push so the
// Pages deploy fails and the previous good site stays live. Not a full schema validator.
import fs from 'node:fs'

const dir = new URL('../data/', import.meta.url)
const errors = []
const read = (f) => {
  try {
    return JSON.parse(fs.readFileSync(new URL(f, dir), 'utf8'))
  } catch (e) {
    errors.push(`${f}: ${e.message}`)
    return null
  }
}
const need = (f, obj, keys) => keys.forEach((k) => obj?.[k] === undefined && errors.push(`${f}: missing "${k}"`))
const isIso = (s) => typeof s === 'string' && !Number.isNaN(Date.parse(s))

const files = {
  'health.json': ['orgs', 'nodes', 'services'],
  'velocity.json': ['orgs', 'projects', 'days', 'sprints', 'method', 'excluded'],
  'changelog.json': ['orgs', 'entries'],
  'roadmap.json': ['orgs', 'milestones', 'items'],
  'ai_usage.json': ['period', 'production', 'engineering'],
}
const SCHEMA = { 'velocity.json': 2 }
for (const [f, keys] of Object.entries(files)) {
  const d = read(f)
  if (!d) continue
  need(f, d, ['schema_version', 'generated_at', 'collector', ...keys])
  const want = SCHEMA[f] ?? 1
  if (d.schema_version !== want) errors.push(`${f}: schema_version ${d.schema_version}, site expects ${want}`)
  if (!isIso(d.generated_at)) errors.push(`${f}: generated_at is not a timestamp`)
}

const h = read('health.json')
const STATUSES = new Set(['ONLINE', 'DEGRADED', 'OFFLINE'])
h?.services?.forEach((s, i) => {
  need(`health.json services[${i}]`, s, ['id', 'name', 'org', 'kind', 'status', 'last_checked', 'history'])
  if (!STATUSES.has(s.status)) errors.push(`health.json ${s.id}: bad status ${s.status}`)
  // health.json is public: refuse to build if a private check target leaked into it
  if (JSON.stringify(s).match(/\b(10|192\.168|172\.(1[6-9]|2\d|3[01]))\.\d+\.\d+/)) errors.push(`health.json ${s.id}: contains a private IP`)
})
const v = read('velocity.json')
if (v && !v.days?.length) errors.push('velocity.json: no days')
v?.days?.forEach((d) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date)) errors.push(`velocity.json: bad day ${d.date}`)
})
const r = read('roadmap.json')
r?.items?.forEach((it) => {
  if (!['in_progress', 'planned', 'shipped'].includes(it.status)) errors.push(`roadmap.json ${it.id}: bad status ${it.status}`)
})
if (!fs.existsSync(new URL('architecture.md', dir))) errors.push('architecture.md missing')

// Everything in data/ is public (and so is its git history). Fail closed on anything that looks private.
const PRIVATE = [
  [/\b(10\.\d{1,3}|192\.168|172\.(1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/, 'a private IP address'],
  [/[A-Za-z0-9._%+-]+@(?!users\.noreply\.github\.com)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, 'an email address'],
  [/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16})\b/, 'a token or key'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
]
for (const f of fs.readdirSync(dir)) {
  const text = fs.readFileSync(new URL(f, dir), 'utf8')
  for (const [rx, what] of PRIVATE) if (rx.test(text)) errors.push(`${f}: contains ${what}; refusing to publish`)
}

if (errors.length) {
  console.error('data validation failed:\n  ' + errors.join('\n  '))
  process.exit(1)
}
console.log('data ok:', Object.keys(files).join(', '), '+ architecture.md')

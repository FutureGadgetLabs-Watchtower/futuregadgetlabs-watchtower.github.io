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
  'velocity.json': ['orgs', 'projects', 'weeks', 'sprints', 'method'],
  'changelog.json': ['orgs', 'entries'],
  'roadmap.json': ['orgs', 'milestones', 'items'],
  'ai_usage.json': ['period', 'production', 'engineering'],
}
for (const [f, keys] of Object.entries(files)) {
  const d = read(f)
  if (!d) continue
  need(f, d, ['schema_version', 'generated_at', 'collector', ...keys])
  if (d.schema_version !== 1) errors.push(`${f}: schema_version ${d.schema_version}, site expects 1`)
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
if (v && !v.weeks?.length) errors.push('velocity.json: no weeks')
const r = read('roadmap.json')
r?.items?.forEach((it) => {
  if (!['in_progress', 'planned', 'shipped'].includes(it.status)) errors.push(`roadmap.json ${it.id}: bad status ${it.status}`)
})
if (!fs.existsSync(new URL('architecture.md', dir))) errors.push('architecture.md missing')

if (errors.length) {
  console.error('data validation failed:\n  ' + errors.join('\n  '))
  process.exit(1)
}
console.log('data ok:', Object.keys(files).join(', '), '+ architecture.md')

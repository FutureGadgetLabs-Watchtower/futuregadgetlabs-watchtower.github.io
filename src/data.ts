// Every byte of data the site shows is bundled here at build time. No runtime fetches,
// so the site works the same whether the homelab is up or not.
import healthJson from '../data/health.json'
import velocityJson from '../data/velocity.json'
import changelogJson from '../data/changelog.json'
import roadmapJson from '../data/roadmap.json'
import aiJson from '../data/ai_usage.json'
import architectureMd from '../data/architecture.md?raw'
import type { AiUsageData, ChangelogData, HealthData, Org, RoadmapData, VelocityData } from './types'

export const health = healthJson as HealthData
// Cast through unknown: TS infers a different literal type for each of the ~150 day objects in the JSON.
// scripts/validate-data.mjs checks the shape before every build.
export const velocity = velocityJson as unknown as VelocityData
export const changelog = changelogJson as ChangelogData
export const roadmap = roadmapJson as RoadmapData
export const aiUsage = aiJson as AiUsageData
export const architecture = architectureMd

export const BUILT_AT = __BUILD_TIME__

// Velocity's org list is collector-generated from the GitHub App installs, so it leads; health adds any extras.
export const orgs: Org[] = [...velocity.orgs, ...health.orgs.filter((o) => !velocity.orgs.some((v) => v.id === o.id))]
const orgMap = new Map(orgs.map((o) => [o.id, o]))
export const orgColor = (id: string) => orgMap.get(id)?.color ?? '#7d8a99'

// Projects are "Org/repo"; other files may still use the bare repo name, so map both (first org wins).
const projectOrg = new Map<string, string>()
for (const p of velocity.projects) {
  projectOrg.set(p.id, p.org)
  if (!projectOrg.has(p.name)) projectOrg.set(p.name, p.org)
}
export const orgOfProject = (project: string) => projectOrg.get(project)

/** Per-file sync times, so the header can show the oldest one. */
export const syncTimes = [
  { file: 'health.json', at: health.generated_at },
  { file: 'velocity.json', at: velocity.generated_at },
  { file: 'changelog.json', at: changelog.generated_at },
  { file: 'roadmap.json', at: roadmap.generated_at },
  { file: 'ai_usage.json', at: aiUsage.generated_at },
]
/** Which modules still show sample data, so the banner only appears where it's true. */
const mock = (d: { collector: { mock?: boolean } }) => d.collector.mock === true
export const mockByRoute: Record<string, boolean> = {
  health: mock(health),
  velocity: mock(velocity),
  architecture: architecture.includes('> Sample data'),
  roadmap: mock(roadmap) || mock(changelog),
  ai: mock(aiUsage),
}

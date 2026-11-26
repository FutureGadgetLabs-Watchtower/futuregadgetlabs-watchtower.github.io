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
export const velocity = velocityJson as VelocityData
export const changelog = changelogJson as ChangelogData
export const roadmap = roadmapJson as RoadmapData
export const aiUsage = aiJson as AiUsageData
export const architecture = architectureMd

export const BUILT_AT = __BUILD_TIME__

export const orgs: Org[] = health.orgs
const orgMap = new Map(orgs.map((o) => [o.id, o]))
export const orgColor = (id: string) => orgMap.get(id)?.color ?? '#7d8a99'

const projectOrg = new Map(velocity.projects.map((p) => [p.id, p.org]))
export const orgOfProject = (project: string) => projectOrg.get(project)

/** Per-file sync times, so the header can show the oldest one. */
export const syncTimes = [
  { file: 'health.json', at: health.generated_at },
  { file: 'velocity.json', at: velocity.generated_at },
  { file: 'changelog.json', at: changelog.generated_at },
  { file: 'roadmap.json', at: roadmap.generated_at },
  { file: 'ai_usage.json', at: aiUsage.generated_at },
]
export const isMock = health.collector.mock === true

/**
 * 今天的日程判断记录(spec 2026-09-05-companion-plan §3)。只做两件事:
 * 喂回 prompt 的「今天之前的判断」;实现「说了不做就 90 分钟别再问」。
 * 留最近 14 天(手机 feed 要看历史),`readPlanLog(today)` 仍只回今天的。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readJsonFile } from '../../lib/read-json-file'
import type { PlanLogEntry } from '../../core/companion-plan'

const dirOf = (stateDir: string) => join(stateDir, 'companion')
const pathOf = (stateDir: string) => join(dirOf(stateDir), 'plan-log.json')

function writeJson(stateDir: string, value: unknown): void {
  const dir = dirOf(stateDir)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(pathOf(stateDir), JSON.stringify(value, null, 2))
}

/** 留几天。spec 2026-09-06-mobile-home-feed §5.1:手机 feed 要看历史,不再每天清零。 */
export const PLAN_LOG_KEEP_DAYS = 14

type DaysShape = { days: Record<string, PlanLogEntry[]> }

const isEntry = (x: unknown): x is PlanLogEntry =>
  !!x && typeof x === 'object' && typeof (x as PlanLogEntry).at === 'string' && typeof (x as PlanLogEntry).chatId === 'string'

/** 读整个文件成 {days};旧形状 {day, entries} 视为只有那一天。坏文件 → 空。 */
function readAll(stateDir: string): DaysShape {
  try {
    const raw = readJsonFile<{ day?: unknown; entries?: unknown; days?: unknown }>(pathOf(stateDir))
    if (!raw || typeof raw !== 'object') return { days: {} }
    if (raw.days && typeof raw.days === 'object' && !Array.isArray(raw.days)) {
      const days: Record<string, PlanLogEntry[]> = {}
      for (const [day, list] of Object.entries(raw.days as Record<string, unknown>)) {
        if (Array.isArray(list)) days[day] = list.filter(isEntry)
      }
      return { days }
    }
    if (typeof raw.day === 'string' && Array.isArray(raw.entries)) {
      return { days: { [raw.day]: raw.entries.filter(isEntry) } }
    }
    return { days: {} }
  } catch { return { days: {} } }
}

export function readPlanLog(stateDir: string, today: string): PlanLogEntry[] {
  return readAll(stateDir).days[today] ?? []
}

/** 最近 `days` 个有记录的天,按 at 升序拍平。days ≤ 0 → []。 */
export function readPlanLogDays(stateDir: string, days: number): PlanLogEntry[] {
  if (!(days > 0)) return []
  const all = readAll(stateDir).days
  const keys = Object.keys(all).sort().slice(-days)
  return keys.flatMap(k => all[k] ?? []).sort((a, b) => a.at.localeCompare(b.at))
}

export function appendPlanLog(stateDir: string, today: string, entry: PlanLogEntry): void {
  const all = readAll(stateDir).days
  all[today] = [...(all[today] ?? []), entry]
  const keep = Object.keys(all).sort().slice(-PLAN_LOG_KEEP_DAYS)
  const days: Record<string, PlanLogEntry[]> = {}
  for (const k of keep) days[k] = all[k]!
  writeJson(stateDir, { days })
}

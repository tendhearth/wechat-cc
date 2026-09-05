/**
 * 今天的日程判断记录(spec 2026-09-05-companion-plan §3)。只做两件事:
 * 喂回 prompt 的「今天之前的判断」;实现「说了不做就 90 分钟别再问」。
 * 每天清零 —— 文件里的 day 不是今天就整个丢掉。照 wish-memory.ts 的读写。
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

export function readPlanLog(stateDir: string, today: string): PlanLogEntry[] {
  try {
    const raw = readJsonFile<{ day?: unknown; entries?: unknown }>(pathOf(stateDir))
    if (!raw || raw.day !== today || !Array.isArray(raw.entries)) return []
    return raw.entries.filter((x): x is PlanLogEntry =>
      !!x && typeof x === 'object' && typeof (x as PlanLogEntry).at === 'string' && typeof (x as PlanLogEntry).chatId === 'string')
  } catch { return [] }
}

export function appendPlanLog(stateDir: string, today: string, entry: PlanLogEntry): void {
  const entries = readPlanLog(stateDir, today)
  entries.push(entry)
  writeJson(stateDir, { day: today, entries })
}

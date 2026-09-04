/**
 * journal-seen.ts — 「主人看到哪了」的水位(spec 2026-09-03-companion-presence §2.3)。
 *
 * 不借 journal.status:那列的 `new` 在桌面是「没试过」(这条战利品用上了没),
 * 和「没看过」是两个概念。水位 = 主人上次打开觅食台的时刻;之后新增的条目
 * 就是桌宠脚边包袱里的东西。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readJsonFile } from '../lib/read-json-file'

const file = (stateDir: string) => join(stateDir, 'companion', 'journal-seen.json')

export function readJournalSeen(stateDir: string): string | null {
  try {
    const raw = readJsonFile<{ seenUntil?: unknown }>(file(stateDir))
    return typeof raw.seenUntil === 'string' && !Number.isNaN(Date.parse(raw.seenUntil)) ? raw.seenUntil : null
  } catch { return null }
}

export function writeJournalSeen(stateDir: string, iso: string): void {
  const dir = join(stateDir, 'companion')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(file(stateDir), JSON.stringify({ seenUntil: iso }, null, 2))
}

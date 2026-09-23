/**
 * neighbor-memory.ts — 邻居的记忆:上次去谁家、每家聊到哪、去过几次。
 * 存在 companion/neighbors.json。串门(wire-visit)写,关系视图(routes-social)读。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readJsonFile } from '../../lib/read-json-file'

export interface NeighborMemory {
  lastId: string | null
  notes: Record<string, { at: string; note: string; visits?: number }>
  introduced: boolean
}

export function readNeighborMemory(stateDir: string): NeighborMemory {
  try {
    const j = readJsonFile<Partial<NeighborMemory>>(join(stateDir, 'companion', 'neighbors.json'))
    return { lastId: j.lastId ?? null, notes: j.notes ?? {}, introduced: j.introduced === true }
  } catch { return { lastId: null, notes: {}, introduced: false } }
}

export function writeNeighborMemory(stateDir: string, m: NeighborMemory): void {
  const dir = join(stateDir, 'companion')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'neighbors.json'), JSON.stringify(m, null, 2))
}

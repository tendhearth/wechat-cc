/** intro-memory.ts — introductions.json 的读写(spec 2026-09-04-introduction §1/§3)。照 wish-memory.ts。 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readJsonFile } from '../../lib/read-json-file'
import { emptyIntroIndex, type IntroIndex } from '../../core/intro'

const file = (stateDir: string) => join(stateDir, 'companion', 'introductions.json')
const isRec = (v: unknown): v is Record<string, never> => !!v && typeof v === 'object' && !Array.isArray(v)

export function readIntroIndex(stateDir: string): IntroIndex {
  try {
    const raw = readJsonFile<Partial<Record<keyof IntroIndex, unknown>>>(file(stateDir))
    const e = emptyIntroIndex()
    return {
      forwards: isRec(raw.forwards) ? raw.forwards as IntroIndex['forwards'] : e.forwards,
      replies: isRec(raw.replies) ? raw.replies as IntroIndex['replies'] : e.replies,
      pending: isRec(raw.pending) ? raw.pending as IntroIndex['pending'] : e.pending,
      offers: isRec(raw.offers) ? raw.offers as IntroIndex['offers'] : e.offers,
    }
  } catch { return emptyIntroIndex() }
}

export function writeIntroIndex(stateDir: string, idx: IntroIndex): void {
  const dir = join(stateDir, 'companion')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(file(stateDir), JSON.stringify(idx, null, 2))
}

/**
 * mailbox-cursor-store.ts — per-relay fetch high-water cursor, persisted to a
 * state-dir JSON file (0600, tmp-then-rename). Survives a daemon restart so the
 * poller resumes after the last acked item. See spec §3.3.
 */
import { join } from 'node:path'
import { readJsonFile } from '../lib/read-json-file'
import { writeJsonAtomic } from '../lib/json-file'

export interface CursorStore { get(relay: string): number; set(relay: string, cursor: number): void }

const FILE = 'mailbox-cursors.json'

export function makeCursorStore(stateDir: string): CursorStore {
  const path = join(stateDir, FILE)
  const read = (): Record<string, number> => { try { return readJsonFile(path) as Record<string, number> } catch { return {} } }
  return {
    get(relay) { return read()[relay] ?? 0 },
    set(relay, cursor) {
      const all = read(); all[relay] = cursor
      writeJsonAtomic(path, all)
    },
  }
}

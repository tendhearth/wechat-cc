/**
 * mailbox-cursor-store.ts — per-relay fetch high-water cursor, persisted to a
 * state-dir JSON file (0600, tmp-then-rename). Survives a daemon restart so the
 * poller resumes after the last acked item. See spec §3.3.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface CursorStore { get(relay: string): number; set(relay: string, cursor: number): void }

const FILE = 'mailbox-cursors.json'

export function makeCursorStore(stateDir: string): CursorStore {
  const path = join(stateDir, FILE)
  const read = (): Record<string, number> => { try { return JSON.parse(readFileSync(path, 'utf8')) as Record<string, number> } catch { return {} } }
  return {
    get(relay) { return read()[relay] ?? 0 },
    set(relay, cursor) {
      const all = read(); all[relay] = cursor
      mkdirSync(stateDir, { recursive: true, mode: 0o700 })
      const tmp = `${path}.tmp`
      writeFileSync(tmp, JSON.stringify(all, null, 2) + '\n', { mode: 0o600 })
      renameSync(tmp, path)
    },
  }
}

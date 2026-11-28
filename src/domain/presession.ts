export const PRESESSION_RECENT_MS = 30 * 60_000
export const PRESESSION_EXPIRY_MS = 2 * 60 * 60_000
export const PRESESSION_LIMIT = 10

export interface SessionTranscript {
  path: string
  source: 'claude' | 'codex'
  mtimeMs: number
  sessionId: string | null
  cwd: string | null
  ended: boolean
}

export type Presession = SessionTranscript & { sessionId: string; cwd: string }

export function selectPresessions(files: readonly SessionTranscript[], registered: ReadonlySet<string>, now: number): Presession[] {
  const seen = new Set(registered)
  const selected: Presession[] = []
  const ordered = files.filter(file => file.mtimeMs >= now - PRESESSION_RECENT_MS && file.mtimeMs <= now)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
  for (const file of ordered) {
    const { sessionId, cwd, ended } = file
    if (!sessionId?.trim() || !cwd?.trim() || ended || seen.has(sessionId)) continue
    seen.add(sessionId)
    selected.push({ ...file, sessionId, cwd })
    if (selected.length === PRESESSION_LIMIT) break
  }
  return selected
}

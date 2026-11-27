import { constants } from 'node:fs'
import { opendir, open, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { PRESESSION_RECENT_MS, selectPresessions, type Presession, type SessionTranscript } from '../../domain/presession'
import { parseJsonlRecord } from '../../lib/jsonl-record'
import type { LocalHistoryRoots } from '../../daemon/local-import'

const SLICE_BYTES = 32 * 1024
export const PRESESSION_SCAN_MS = 750

function transcriptMetadata(source: SessionTranscript['source'], head: string, tail: string) {
  let sessionId: string | null = null
  let cwd: string | null = null
  let ended = false
  for (const line of [...head.split('\n'), ...tail.split('\n')]) {
    const record = parseJsonlRecord(line)
    if (!record) continue
    const payload = record.payload as Record<string, unknown> | undefined
    if (record.type === 'session_end'
      || (source === 'claude' && record.type === 'system' && record.subtype === 'session_end')
      || (source === 'codex' && record.type === 'event_msg' && payload?.type === 'session_end')) ended = true
    const identity = source === 'claude' ? record : record.type === 'session_meta' ? payload : undefined
    const id = source === 'claude' ? identity?.sessionId : identity?.id
    if (typeof id !== 'string' || !id.trim()) continue
    sessionId ??= id
    if (sessionId === id && typeof identity?.cwd === 'string' && identity.cwd.trim()) cwd ??= identity.cwd
  }
  return { sessionId, cwd, ended }
}

async function readTranscript(path: string, source: SessionTranscript['source'], since: number, signal: AbortSignal): Promise<SessionTranscript | null> {
  const entry = await lstat(path)
  if (signal.aborted || !entry.isFile() || entry.mtimeMs < since) return null
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const stat = await file.stat()
    if (signal.aborted || !stat.isFile() || stat.mtimeMs < since) return null
    const buffer = Buffer.alloc(Math.min(stat.size, SLICE_BYTES))
    const first = await file.read(buffer, 0, buffer.length, 0)
    const head = buffer.toString('utf8', 0, first.bytesRead)
    if (stat.size <= SLICE_BYTES || signal.aborted) {
      return signal.aborted ? null : { path, source, mtimeMs: stat.mtimeMs, ...transcriptMetadata(source, head, '') }
    }
    const tailBuffer = Buffer.alloc(SLICE_BYTES + 1)
    const last = await file.read(tailBuffer, 0, tailBuffer.length, stat.size - tailBuffer.length)
    const tail = tailBuffer.toString('utf8', 0, last.bytesRead)
    // Include a tail record only after a known newline. A head record also
    // needs its delimiter when the file continues beyond the bytes we read.
    const completeHead = head.slice(0, head.lastIndexOf('\n') + 1)
    const firstNewline = tail.indexOf('\n')
    const completeTail = firstNewline < 0 ? '' : tail.slice(firstNewline + 1)
    return { path, source, mtimeMs: stat.mtimeMs, ...transcriptMetadata(source, completeHead, completeTail) }
  } finally { await file.close() }
}

export async function discoverPresessions(deps: {
  roots: LocalHistoryRoots
  registered: ReadonlySet<string>
  now?: () => number
  timeoutMs?: number
  log: (line: string) => void
}): Promise<Presession[]> {
  const now = deps.now ?? Date.now
  const since = now() - PRESESSION_RECENT_MS
  const files: SessionTranscript[] = []
  const abort = new AbortController()
  let unreadable = 0
  const failed = (error: unknown) => {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') unreadable++
  }
  async function walk(path: string, source: SessionTranscript['source'], depth: number): Promise<void> {
    if (abort.signal.aborted) return
    try {
      for await (const entry of await opendir(path)) {
        if (abort.signal.aborted) return
        const child = join(path, entry.name)
        if (depth > 0 && entry.isDirectory()) {
          await walk(child, source, depth - 1)
        } else if (depth === 0 && entry.isFile() && entry.name.endsWith('.jsonl') && (source === 'claude' || entry.name.startsWith('rollout-'))) {
          try {
            const record = await readTranscript(child, source, since, abort.signal)
            if (record && !abort.signal.aborted) files.push(record)
          } catch (error) { failed(error) }
        }
      }
    } catch (error) { failed(error) }
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.all([walk(deps.roots.claudeProjectsRoot, 'claude', 1), walk(deps.roots.codexRoot, 'codex', 3)]),
      new Promise<void>(resolve => { timer = setTimeout(() => { abort.abort(); resolve() }, deps.timeoutMs ?? PRESESSION_SCAN_MS) }),
    ])
  } finally { clearTimeout(timer) }
  if (abort.signal.aborted || unreadable) deps.log(`scan incomplete: timeout=${abort.signal.aborted} unreadable=${unreadable}`)
  return selectPresessions(files, deps.registered, now())
}

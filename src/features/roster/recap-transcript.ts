import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs'

const TAIL_BYTES = 256 * 1024
export const clipRecap = (text: string) => [...text.trim()].slice(0, 400).join('').trimEnd()

export function findAwaySummary(tail: string, lastReplyAt = 0): string | null {
  let latest: { at: number; text: string } | undefined
  for (const line of tail.split('\n')) {
    try {
      const entry = JSON.parse(line)
      const at = typeof entry?.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN
      if (!Number.isFinite(at)) continue
      // Anything said after the summary, by either side, means it describes an earlier stop.
      if (entry.type === 'assistant' || entry.type === 'user') lastReplyAt = Math.max(lastReplyAt, at)
      if (entry.type !== 'system' || entry.subtype !== 'away_summary' || typeof entry.content !== 'string') continue
      const text = clipRecap(entry.content)
      if (text && (!latest || at >= latest.at)) latest = { at, text }
    } catch { /* A partial or malformed line carries no transcript facts. */ }
  }
  return latest && latest.at > lastReplyAt ? latest.text : null
}

export function readAwaySummary(path: string, lastReplyAt: number): string | null {
  try {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK)
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile()) return null
      const offset = Math.max(0, stat.size - TAIL_BYTES - 1)
      const bytes = Buffer.alloc(stat.size - offset)
      const length = readSync(fd, bytes, 0, bytes.length, offset)
      const tail = bytes.toString('utf8', 0, length)
      return findAwaySummary(offset > 0 ? tail.slice(tail.indexOf('\n') < 0 ? tail.length : tail.indexOf('\n') + 1) : tail, lastReplyAt)
    } finally { closeSync(fd) }
  } catch { return null }
}

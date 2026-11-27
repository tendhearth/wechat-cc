import { expect, it } from 'vitest'
import { PRESESSION_RECENT_MS, selectPresessions, type SessionTranscript } from './presession'

const now = 3_600_000
const record = (patch: Partial<SessionTranscript> = {}): SessionTranscript => ({
  path: '/transcripts/s.jsonl', source: 'claude', mtimeMs: now, sessionId: 's', cwd: '/project', ended: false, ...patch,
})

it.each([
  ['刚写过', {}, [], true],
  ['恰好半小时', { mtimeMs: now - PRESESSION_RECENT_MS }, [], true],
  ['超过半小时', { mtimeMs: now - PRESESSION_RECENT_MS - 1 }, [], false],
  ['未来时间', { mtimeMs: now + 1 }, [], false],
  ['无效时间', { mtimeMs: NaN }, [], false],
  ['在登记处', {}, ['s'], false],
  ['已结束', { ended: true }, [], false],
  ['无会话 ID', { sessionId: null }, [], false],
  ['无目录', { cwd: null }, [], false],
  ['目录只有空格', { cwd: ' ' }, [], false],
] satisfies [string, Partial<SessionTranscript>, string[], boolean][])('%s', (_label, patch, registered, selected) => {
  expect(selectPresessions([record(patch)], new Set(registered), now)).toHaveLength(selected ? 1 : 0)
})

it('按 mtime 取最新十条，同一会话只取一条', () => {
  const files = Array.from({ length: 12 }, (_, i) => record({ sessionId: String(i), mtimeMs: now - 12 + i }))
  const duplicate = record({ sessionId: '11', source: 'codex' })
  const result = selectPresessions([...files, duplicate], new Set(), now)
  expect(result.map(file => file.sessionId)).toEqual(['11', '10', '9', '8', '7', '6', '5', '4', '3', '2'])
  expect(result[0]).toEqual(duplicate)
})

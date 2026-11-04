import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { activityOfTranscript, clearActivityCache } from './phone-actions'
import { parseActivity } from './cli-activity'
import { readTail } from './reply-handler'
import { removeTempDir } from '../../lib/test-temp'

/** 「看着它跑」的解析按(文件, 大小, 修改时间)缓存(M4b 第一步):没变不重解析,变了照旧;结果和直接解析一字不差。 */
let dir: string, path: string
const L = (o: object) => JSON.stringify(o) + '\n'
beforeEach(() => {
  clearActivityCache()
  dir = mkdtempSync(join(tmpdir(), 'cc-activity-cache-'))
  path = join(dir, 's.jsonl')
  writeFileSync(path, L({ type: 'user', timestamp: '2026-11-04T01:00:00.000Z', message: { role: 'user', content: '修一下登录' } })
    + L({ type: 'assistant', timestamp: '2026-11-04T01:00:03.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/w/a.ts' } }] } }))
})
afterEach(() => removeTempDir(dir))

describe('activityOfTranscript', () => {
  it('和直接解析一字不差;文件没变 ⇒ 给同一份结果(没重新读、没重新解析);追加一行 ⇒ 重新解析,带上新的那一步', () => {
    let reads = 0
    const counting = (p: string, max: number) => { reads++; return readTail(p, max) }
    const first = activityOfTranscript(path, 'claude', 256 * 1024, undefined, counting)
    expect(first).toEqual(parseActivity(readTail(path, 256 * 1024), 'claude'))
    expect(activityOfTranscript(path, 'claude', 256 * 1024, undefined, counting)).toBe(first)
    expect(reads).toBe(1)
    appendFileSync(path, L({ type: 'assistant', timestamp: '2026-11-04T01:00:09.000Z', message: { role: 'assistant', content: [{ type: 'text', text: '改好了。' }] } }))
    const next = activityOfTranscript(path, 'claude', 256 * 1024, undefined, counting)
    expect(reads).toBe(2)
    expect(next).toEqual(parseActivity(readTail(path, 256 * 1024), 'claude'))
    expect(next.at(-1)).toMatchObject({ kind: 'said', text: '改好了。' })
  })
  it('读多少、取几条不同的调用各算各的(详情 256KB / 列表 64KB 取 20 条不混)', () => {
    const a = activityOfTranscript(path, 'claude', 256 * 1024, undefined)
    const b = activityOfTranscript(path, 'claude', 64 * 1024, 20)
    expect(b).not.toBe(a)
    expect(b).toEqual(parseActivity(readTail(path, 64 * 1024), 'claude', 20))
  })
  it('stat 不了的路径(测试里的假路径)⇒ 不缓存,每次都读', () => {
    let reads = 0
    const fake = () => { reads++; return L({ type: 'user', timestamp: '2026-11-04T01:00:00.000Z', message: { role: 'user', content: 'hi' } }) }
    activityOfTranscript('/no/such/file.jsonl', 'claude', 1024, undefined, fake)
    activityOfTranscript('/no/such/file.jsonl', 'claude', 1024, undefined, fake)
    expect(reads).toBe(2)
  })
})

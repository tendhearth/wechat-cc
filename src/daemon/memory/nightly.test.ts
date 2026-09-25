import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runMemoryNightly, readNightlyState, writeNightlyState, type NightlyRunDeps } from './nightly'
import { parseMemoryDoc } from './curated-doc'

const OWNER = 'owner@im.wechat'
let stateDir: string, root: string, calls: string[], reply: string, now: number
let n = 0

function deps(over: Partial<NightlyRunDeps> = {}): NightlyRunDeps {
  return {
    stateDir,
    ownerChatId: () => OWNER,
    config: () => ({ enabled: true, at: '04:00', timezone: 'UTC' }),
    sources: {
      observationsSince: async () => ['- 2026-09-24 主人最近在赶发版'],
      milestonesSince: async () => [],
      messagesSince: async () => ['主人:周五前我得给 X 回话'],
      projectMemory: () => '',
    },
    cheapEval: () => async (p: string) => { calls.push(p); return reply },
    ownerRecentlyActive: async () => false,
    now: () => now,
    newId: () => `id${String(n++).padStart(2, '0')}`,
    log: () => {},
    ...over,
  }
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'nightly-'))
  root = join(stateDir, 'memory', OWNER)
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'profile.md'), '主人叫大人,做 wechat-cc\n')
  calls = []
  now = Date.parse('2026-09-25T04:05:00Z')
  reply = JSON.stringify({ add: [{ section: '承诺', text: '周五前给 X 回话(期限 2026-09-26)' }, { section: '关于你', text: '做 wechat-cc' }], update: [], confirm: [], remove: [] })
})

describe('runMemoryNightly', () => {
  it('first run: writes memory.md, logs ops, sets the first-run notice, records state', async () => {
    const r = await runMemoryNightly(deps(), { force: false })
    expect(r.status).toBe('written')
    const doc = parseMemoryDoc(readFileSync(join(root, 'memory.md'), 'utf8'))
    expect(doc.sections['承诺'][0]).toMatchObject({ text: '周五前给 X 回话(期限 2026-09-26)', seen: '2026-09-25' })
    expect(calls[0]).toContain('主人叫大人')
    expect(calls[0]).toContain('周五前我得给 X 回话')
    const log = readFileSync(join(root, 'memory-log.jsonl'), 'utf8').trim().split('\n')
    expect(JSON.parse(log[0]!).ops).toHaveLength(2)
    const st = readNightlyState(stateDir)
    expect(st).toMatchObject({ lastRunDay: '2026-09-25', failures: 0, firstRunDone: true })
    expect(st.pendingNotice?.text).toContain('整理成了一份记忆')
  })
  it('does not run before the configured time or twice a day, and skips when the owner is mid-conversation', async () => {
    now = Date.parse('2026-09-25T03:59:00Z')
    expect(await runMemoryNightly(deps(), { force: false })).toEqual({ status: 'skipped', reason: 'not_due' })
    now = Date.parse('2026-09-25T04:05:00Z')
    expect(await runMemoryNightly(deps({ ownerRecentlyActive: async () => true }), { force: false })).toEqual({ status: 'skipped', reason: 'owner_busy' })
    await runMemoryNightly(deps(), { force: false })
    expect(await runMemoryNightly(deps(), { force: false })).toEqual({ status: 'skipped', reason: 'not_due' })
    expect(calls).toHaveLength(1)
  })
  it('skips the model when nothing new came in since last night', async () => {
    await runMemoryNightly(deps(), { force: true })
    expect(await runMemoryNightly(deps(), { force: true })).toEqual({ status: 'skipped', reason: 'no_new_material' })
    expect(calls).toHaveLength(1)
  })
  it('a rejected batch leaves the file untouched, counts a failure and stops for today', async () => {
    await runMemoryNightly(deps(), { force: true })
    const before = readFileSync(join(root, 'memory.md'), 'utf8')
    writeFileSync(join(root, 'profile.md'), '新的一天有新草稿\n')
    reply = JSON.stringify({ add: [], update: [], confirm: ['nope'], remove: [] })
    now = Date.parse('2026-09-26T04:05:00Z')
    expect(await runMemoryNightly(deps(), { force: false })).toEqual({ status: 'failed', reason: 'unknown_id:nope' })
    expect(readFileSync(join(root, 'memory.md'), 'utf8')).toBe(before)
    expect(readNightlyState(stateDir)).toMatchObject({ failures: 1, lastFailDay: '2026-09-26' })
    now = Date.parse('2026-09-26T04:20:00Z')
    expect(await runMemoryNightly(deps(), { force: false })).toEqual({ status: 'skipped', reason: 'failed_today' })
  })
  it('owner edit during the model call wins — result dropped, not counted as a failure', async () => {
    await runMemoryNightly(deps(), { force: true })
    writeFileSync(join(root, 'profile.md'), '又一份草稿\n')
    const edited = readFileSync(join(root, 'memory.md'), 'utf8') + '\n## 随手记\n主人自己写的\n'
    const d = deps({ cheapEval: () => async () => { writeFileSync(join(root, 'memory.md'), edited); return JSON.stringify({ add: [], update: [], confirm: [], remove: [] }) } })
    expect(await runMemoryNightly(d, { force: true })).toEqual({ status: 'skipped', reason: 'owner_edited' })
    expect(readFileSync(join(root, 'memory.md'), 'utf8')).toBe(edited)
    expect(readNightlyState(stateDir).failures).toBe(0)
  })
  it('keeps the owner hand-written entry (assigning it an id) and archives the previous version', async () => {
    await runMemoryNightly(deps(), { force: true })
    writeFileSync(join(root, 'memory.md'), readFileSync(join(root, 'memory.md'), 'utf8').replace('## 偏好\n', '## 偏好\n- 主人手写:别用表情\n'))
    writeFileSync(join(root, 'profile.md'), '第二天草稿\n')
    reply = JSON.stringify({ add: [], update: [], confirm: [], remove: [] })
    now = Date.parse('2026-09-26T04:05:00Z')
    expect((await runMemoryNightly(deps(), { force: false })).status).toBe('written')
    const doc = parseMemoryDoc(readFileSync(join(root, 'memory.md'), 'utf8'))
    expect(doc.sections['偏好'][0]).toMatchObject({ text: '主人手写:别用表情', seen: '2026-09-26' })
    expect(doc.sections['偏好'][0]!.id).toMatch(/^id\d\d$/)
    expect(existsSync(join(stateDir, 'memory-archive', OWNER, 'memory.md.2026-09-26.md'))).toBe(true)
  })
  it('forced runs return the notice instead of queueing it', async () => {
    const r = await runMemoryNightly(deps(), { force: true })
    expect(r.status === 'written' && r.notice).toContain('整理成了一份记忆')
    expect(readNightlyState(stateDir).pendingNotice).toBeNull()
  })
  it('refuses owner ids that would escape the memory dir', async () => {
    expect(await runMemoryNightly(deps({ ownerChatId: () => '../x' }), { force: true })).toEqual({ status: 'skipped', reason: 'no_owner' })
  })
  it('state round-trips and defaults when missing', () => {
    expect(readNightlyState(stateDir)).toEqual({ lastRunDay: null, lastRunIso: null, fingerprint: null, failures: 0, lastFailDay: null, firstRunDone: false, pendingNotice: null })
    writeNightlyState(stateDir, { ...readNightlyState(stateDir), failures: 2 })
    expect(readNightlyState(stateDir).failures).toBe(2)
  })
})

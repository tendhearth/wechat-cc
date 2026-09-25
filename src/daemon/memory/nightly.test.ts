import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runMemoryNightly, readNightlyState, writeNightlyState, gatherMaterial, MATERIAL_BUDGET, MEMORY_LOG_FILE, type NightlyRunDeps } from './nightly'
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
    newId: () => (0xa000 + n++).toString(16),
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
    expect(doc.sections['偏好'][0]!.id).toMatch(/^[0-9a-f]{4,}$/)
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
  it('same-day backup keeps the pre-tidy content from the first write of the day — a later same-day run does not overwrite it', async () => {
    const seed = '## 关于你\n- 种子条目 <!-- m:aaaa · 2026-09-24 -->\n'
    writeFileSync(join(root, 'memory.md'), seed)
    await runMemoryNightly(deps(), { force: true })
    const archivePath = join(stateDir, 'memory-archive', OWNER, 'memory.md.2026-09-25.md')
    expect(readFileSync(archivePath, 'utf8')).toBe(seed)
    writeFileSync(join(root, 'profile.md'), '同一天第二次触发\n')
    await runMemoryNightly(deps(), { force: true })
    expect(readFileSync(archivePath, 'utf8')).toBe(seed)
  })
  it('a write-phase fs error fails cleanly (no state corruption, no retry storm) and does not double-log', async () => {
    await runMemoryNightly(deps(), { force: true })
    writeFileSync(join(root, 'profile.md'), '新草稿触发第二次整理\n')
    // Sabotage: put a FILE where memory-archive/<owner> needs to be a directory,
    // so mkdirSync(archiveDir, { recursive: true }) throws inside the write phase.
    mkdirSync(join(stateDir, 'memory-archive'), { recursive: true })
    writeFileSync(join(stateDir, 'memory-archive', OWNER), 'not a directory')
    const before = readFileSync(join(root, 'memory.md'), 'utf8')
    const logBefore = readFileSync(join(root, MEMORY_LOG_FILE), 'utf8')
    const r = await runMemoryNightly(deps(), { force: true })
    expect(r.status).toBe('failed')
    expect(r.status === 'failed' && r.reason.startsWith('write_error:')).toBe(true)
    expect(readFileSync(join(root, 'memory.md'), 'utf8')).toBe(before)
    expect(readNightlyState(stateDir)).toMatchObject({ failures: 1, lastFailDay: '2026-09-25' })
    expect(readFileSync(join(root, MEMORY_LOG_FILE), 'utf8')).toBe(logBefore)
  })
  it('keeps the newest chat messages, not the oldest, when the chat block exceeds the cap', async () => {
    const lines = Array.from({ length: 100 }, () => 'a'.repeat(100))
    lines[99] = `${'b'.repeat(90)}UNIQUE_TAIL_MARKER`
    const d = deps({
      sources: {
        observationsSince: async () => [],
        milestonesSince: async () => [],
        messagesSince: async () => lines,
        projectMemory: () => '',
      },
    })
    const r = await runMemoryNightly(d, { force: true })
    expect(r.status).toBe('written')
    expect(calls[0]).toContain('UNIQUE_TAIL_MARKER')
  })
  it('a failing run does not clobber state written by a run that succeeded during its model call', async () => {
    const d = deps({
      cheapEval: () => async () => {
        writeNightlyState(stateDir, { ...readNightlyState(stateDir), lastRunDay: '2026-09-25', lastRunIso: '2026-09-25T04:06:00.000Z', fingerprint: 'newer', firstRunDone: true })
        throw new Error('boom')
      },
    })
    const r = await runMemoryNightly(d, { force: true })
    expect(r.status).toBe('failed')
    expect(readNightlyState(stateDir)).toMatchObject({ lastRunDay: '2026-09-25', lastRunIso: '2026-09-25T04:06:00.000Z', fingerprint: 'newer', firstRunDone: true, failures: 1, lastFailDay: '2026-09-25' })
  })
  it('caps the whole material at one total budget, filling profile first and the newest notes before older ones', async () => {
    const notes = join(root, 'notes')
    mkdirSync(notes, { recursive: true })
    const base = Date.parse('2026-09-01T00:00:00Z') / 1000
    for (let i = 0; i < 20; i++) {
      const name = `n${String(i).padStart(2, '0')}.md`
      const p = join(notes, name)
      writeFileSync(p, `NOTE_${i}_MARKER\n` + 'x'.repeat(6000))
      // name order is the reverse of age: n00 is the newest, n19 the oldest
      utimesSync(p, base + (20 - i) * 3600, base + (20 - i) * 3600)
    }
    const { text, truncated } = await gatherMaterial(root, deps().sources, null, false)
    expect(truncated).toBe(true)
    expect(text.length).toBeLessThanOrEqual(MATERIAL_BUDGET + 20 * 40)
    expect(text).toContain('主人叫大人')
    expect(text).toContain('NOTE_0_MARKER')
    expect(text).not.toContain('NOTE_19_MARKER')
  })
})

import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runMemoryNightly, readNightlyState, writeNightlyState, gatherMaterial, buildNightlyPrompt, MATERIAL_BUDGET, MEMORY_LOG_FILE, type NightlyRunDeps } from './nightly'
import { parseMemoryDoc } from './curated-doc'
import { NetworkUnprotectedError } from '../../lib/network-gate'

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
  it('守护 v2: the eval needs a protected provider and the network is unprotected → skipped, WITHOUT marking failed_today; runs once safe', async () => {
    let safe = false
    const d = deps({ cheapEval: () => async (p: string) => {
      if (!safe) throw new NetworkUnprotectedError({ safe: false, source: 'bx', detail: 'bx 未保护' }, 'Claude')
      calls.push(p); return reply
    } })
    expect(await runMemoryNightly(d, { force: false })).toEqual({ status: 'skipped', reason: 'network_unprotected' })
    expect(await runMemoryNightly(d, { force: true })).toEqual({ status: 'skipped', reason: 'network_unprotected' })
    expect(calls).toHaveLength(0)
    expect(readNightlyState(stateDir)).toMatchObject({ failures: 0, lastFailDay: null })
    safe = true
    expect((await runMemoryNightly(d, { force: false })).status).toBe('written')
  })
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
  it('connection failure: retries the same day at most 3 times, an hour apart, then gives up for the day', async () => {
    let down = true
    const d = deps({ cheapEval: () => async (p: string) => {
      calls.push(p)
      if (down) throw new Error('Unable to connect. Is the computer able to access the url?')
      return reply
    } })
    const at = (t: string) => { now = Date.parse(t) }
    at('2026-09-25T04:05:00Z')
    expect(await runMemoryNightly(d, { force: false })).toEqual({ status: 'skipped', reason: 'retry_later' })
    expect(readNightlyState(stateDir)).toMatchObject({ failures: 0, lastFailDay: null })
    at('2026-09-25T04:20:00Z')
    expect(await runMemoryNightly(d, { force: false })).toEqual({ status: 'skipped', reason: 'retry_later' })
    expect(calls).toHaveLength(1)
    at('2026-09-25T05:05:00Z'); await runMemoryNightly(d, { force: false })
    at('2026-09-25T06:05:00Z'); await runMemoryNightly(d, { force: false })
    at('2026-09-25T07:05:00Z')
    expect((await runMemoryNightly(d, { force: false })).status).toBe('failed')
    expect(calls).toHaveLength(4)
    expect(readNightlyState(stateDir)).toMatchObject({ failures: 1, lastFailDay: '2026-09-25' })
    // 第二天重新给 3 次机会;连上了就照常写,推迟记录清掉
    at('2026-09-26T04:05:00Z'); down = false
    expect((await runMemoryNightly(d, { force: false })).status).toBe('written')
    expect(readNightlyState(stateDir)).toMatchObject({ failures: 0, netRetry: null })
  })
  it('a non-network eval error still fails for the day right away', async () => {
    const d = deps({ cheapEval: () => async () => { throw new Error('invalid model selection') } })
    expect(await runMemoryNightly(d, { force: false })).toEqual({ status: 'failed', reason: 'eval_error:invalid model selection' })
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
    expect(readNightlyState(stateDir)).toEqual({ lastRunDay: null, lastRunIso: null, fingerprint: null, failures: 0, lastFailDay: null, firstRunDone: false, netRetry: null, pendingNotice: null })
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

describe('today-draft (同日失忆, 2026-10-01)', () => {
  const draftPath = () => join(root, 'today-draft.md')
  it('feeds the draft to the model as its own block and clears it after a successful write', async () => {
    writeFileSync(draftPath(), '- 下周三去上海出差\n')
    const r = await runMemoryNightly(deps(), { force: true })
    expect(r.status).toBe('written')
    expect(calls[0]).toContain('今天的草稿')
    expect(calls[0]).toContain('下周三去上海出差')
    expect(existsSync(draftPath())).toBe(false)
  })
  it('keeps lines that arrived while the model was thinking', async () => {
    writeFileSync(draftPath(), '- 早上说的\n')
    const d = deps({ cheapEval: () => async (p: string) => { calls.push(p); writeFileSync(draftPath(), '- 早上说的\n- 整理途中新记的\n'); return reply } })
    expect((await runMemoryNightly(d, { force: true })).status).toBe('written')
    expect(readFileSync(draftPath(), 'utf8')).toBe('- 整理途中新记的\n')
  })
  it('a failed run leaves the draft in place for tomorrow', async () => {
    writeFileSync(draftPath(), '- 早上说的\n')
    reply = 'not json'
    expect((await runMemoryNightly(deps(), { force: true })).status).toBe('failed')
    expect(readFileSync(draftPath(), 'utf8')).toBe('- 早上说的\n')
  })
  it('the draft does not count toward the fingerprint (its lines are already in profile.md), so clearing it never forces an extra model call', async () => {
    writeFileSync(draftPath(), '- 早上说的\n')
    await runMemoryNightly(deps(), { force: true })
    expect(await runMemoryNightly(deps(), { force: true })).toEqual({ status: 'skipped', reason: 'no_new_material' })
    expect(calls).toHaveLength(1)
  })
  it('a no-new-material skip still clears a draft that was already covered', async () => {
    await runMemoryNightly(deps(), { force: true })
    writeFileSync(draftPath(), '- 早上说的\n')
    expect(await runMemoryNightly(deps(), { force: true })).toEqual({ status: 'skipped', reason: 'no_new_material' })
    expect(existsSync(draftPath())).toBe(false)
  })
})

describe('buildNightlyPrompt granularity rules', () => {
  it('asks for one fact per entry, commitments in 承诺, and splitting via update + add', () => {
    const p = buildNightlyPrompt({ today: '2026-09-26', current: '', material: '' })
    expect(p).toContain('- 每条只写一件事:一个人一条,一个偏好一条。')
    expect(p).toContain('- 欠别人的、别人欠主人的、约好的事放进「承诺」,有日期就在正文写「(期限 YYYY-MM-DD)」。')
    expect(p).toContain('- 当前记忆里一条写了好几件事时,把它拆开:用 update 把原条目改成其中一件(reversal=false),其余用 add。')
  })
})

// 记忆带出处 + 过期改写(对标 Claude / ChatGPT Dreaming,2026-10-20)
describe('记忆带出处', () => {
  const sourced = [
    { text: '主人:周五前我得给 X 回话', id: 'm-1', ts: '2026-09-24T10:00:00Z' },
    { text: 'CC:好的,记下了', id: 'm-2', ts: '2026-09-24T10:00:05Z' },
  ]
  it('chat lines get [cN] tokens and a ref table', async () => {
    const r = await gatherMaterial(root, { observationsSince: async () => [], milestonesSince: async () => [], messagesSince: async () => sourced, projectMemory: () => '' }, null, false)
    expect(r.text).toContain('[c1] 主人:周五前我得给 X 回话')
    expect(r.text).toContain('[c2] CC:好的')
    expect(r.refs).toEqual({ c1: { id: 'm-1', ts: '2026-09-24T10:00:00Z', excerpt: '主人:周五前我得给 X 回话' }, c2: { id: 'm-2', ts: '2026-09-24T10:00:05Z', excerpt: 'CC:好的,记下了' } })
  })
  it('plain string lines still work (no token)', async () => {
    const r = await gatherMaterial(root, { observationsSince: async () => [], milestonesSince: async () => [], messagesSince: async () => ['主人:hi'], projectMemory: () => '' }, null, false)
    expect(r.text).toContain('主人:hi')
    expect(r.refs).toEqual({})
  })
  it('the prompt explains the tokens and the past-date rule', () => {
    const p = buildNightlyPrompt({ today: '2026-10-20', current: '', material: '' })
    expect(p).toContain('"src"')
    expect(p).toContain('已经过了')
  })
  it('a run records where each added / updated entry came from; unknown tokens are ignored', async () => {
    reply = JSON.stringify({ add: [{ section: '承诺', text: '周五前给 X 回话(期限 2026-09-26)', src: ['c1', 'c9'] }, { section: '关于你', text: '做 wechat-cc' }], update: [], confirm: [], remove: [] })
    const r = await runMemoryNightly(deps({ sources: { observationsSince: async () => [], milestonesSince: async () => [], messagesSince: async () => sourced, projectMemory: () => '' } }), { force: false })
    expect(r.status).toBe('written')
    const src = JSON.parse(readFileSync(join(root, 'memory-sources.json'), 'utf8')) as Record<string, Array<{ id: string }>>
    const doc = parseMemoryDoc(readFileSync(join(root, 'memory.md'), 'utf8'))
    const promiseId = doc.sections['承诺'][0]!.id!
    expect(src[promiseId]).toEqual([{ id: 'm-1', ts: '2026-09-24T10:00:00Z', excerpt: '主人:周五前我得给 X 回话' }])
    expect(src[doc.sections['关于你'][0]!.id!]).toBeUndefined()
  })
  it('removed entries drop their sources', async () => {
    reply = JSON.stringify({ add: [{ section: '关于你', text: '做 wechat-cc', src: ['c1'] }], update: [], confirm: [], remove: [] })
    await runMemoryNightly(deps({ sources: { observationsSince: async () => [], milestonesSince: async () => [], messagesSince: async () => sourced, projectMemory: () => '' } }), { force: false })
    const id = parseMemoryDoc(readFileSync(join(root, 'memory.md'), 'utf8')).sections['关于你'][0]!.id!
    reply = JSON.stringify({ add: [], update: [], confirm: [], remove: [{ id, reason: '主人说不对' }] })
    now += 86_400_000
    await runMemoryNightly(deps({ sources: { observationsSince: async () => [], milestonesSince: async () => [], messagesSince: async () => [{ text: '主人:新的一句', id: 'm-3', ts: '2026-09-25T09:00:00Z' }], projectMemory: () => '' } }), { force: false })
    const src = JSON.parse(readFileSync(join(root, 'memory-sources.json'), 'utf8')) as Record<string, unknown>
    expect(src[id]).toBeUndefined()
  })
})

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeMemoryNightlyRuntime, deliverPendingNotice, type NoticeDeps } from './nightly-runtime'
import { readNightlyState, writeNightlyState, type NightlyRunDeps } from './nightly'
import { makeSpeechPolicy, type SpeechPolicy } from '../speech/policy'
import type { ProactiveOutbound } from '../companion/proactive-channel'

const OWNER = 'owner@im.wechat'
let stateDir: string, root: string, now: number, sent: string[]
let n = 0

/** 跟生产同一道门(policy.say);微信那头记进 sent。 */
function speechFor(o: { deliverable?: boolean; care?: 'off' | 'low'; quietEnds?: number | null } = {}): SpeechPolicy {
  const outbound: ProactiveOutbound = {
    appDeliverable: () => false, canDeliver: () => o.deliverable ?? true, sendOnce: async () => ({ ok: true }),
    open: () => ({ sendText: async (_c, t) => { sent.push(t); return { msgId: 'm' } }, channel: () => 'wechat', textOnly: () => false, sendAttachment: async () => false, finish: () => {} }),
  }
  return makeSpeechPolicy({ care: () => o.care ?? 'low', quietEndsAt: () => o.quietEnds ?? null, outbound, log: () => {}, now: () => now })
}

function deps(over: Partial<NightlyRunDeps & NoticeDeps> = {}): NightlyRunDeps & NoticeDeps {
  return {
    stateDir,
    ownerChatId: () => OWNER,
    config: () => ({ enabled: true, at: '04:00', timezone: 'UTC' }),
    sources: { observationsSince: async () => [], milestonesSince: async () => [], messagesSince: async () => ['主人:周五前给 X 回话'], projectMemory: () => '' },
    cheapEval: () => async () => JSON.stringify({ add: [{ section: '承诺', text: '周五前给 X 回话(期限 2026-09-26)' }], update: [], confirm: [], remove: [] }),
    ownerRecentlyActive: async () => false,
    now: () => now,
    newId: () => (0xa000 + n++).toString(16),
    log: () => {},
    careGate: () => ({ ok: true }),
    claim: vi.fn(),
    speech: speechFor(),
    ...over,
  }
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'nightly-rt-'))
  root = join(stateDir, 'memory', OWNER)
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'profile.md'), '草稿\n')
  now = Date.parse('2026-09-25T04:05:00Z')
  sent = []
})

describe('memory nightly runtime', () => {
  it('tick at 04:05 writes the memory but holds the notice until 09:00', async () => {
    const rt = makeMemoryNightlyRuntime(deps())
    await rt.tick()
    expect(sent).toEqual([])
    now = Date.parse('2026-09-25T09:01:00Z')
    await rt.tick()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('整理成了一份记忆')
    expect(readNightlyState(stateDir).pendingNotice).toBeNull()
  })
  it('claims before sending, drops on care denial, waits on cooldown or a suspended WeChat link, expires after 24h', async () => {
    const claim = vi.fn()
    writeNightlyState(stateDir, { ...readNightlyState(stateDir), pendingNotice: { text: 'x', createdAtMs: Date.parse('2026-09-25T04:00:00Z') } })
    now = Date.parse('2026-09-25T10:00:00Z')
    expect(await deliverPendingNotice(deps({ speech: speechFor({ deliverable: false }) }))).toBe('waiting')
    // 免打扰(SpeechPolicy,第三批 3a):往后推,通知留着;以前这条只有「09:00 以后」一道下限
    expect(await deliverPendingNotice(deps({ speech: speechFor({ quietEnds: Date.parse('2026-09-25T12:00:00Z') }) }))).toBe('waiting')
    expect(readNightlyState(stateDir).pendingNotice).not.toBeNull()
    // 别烦我:不发、清掉(跟以前 care 闸拒绝时一样)
    const s2 = deps({ speech: speechFor({ care: 'off' }), claim: vi.fn() })
    const keep = readNightlyState(stateDir).pendingNotice
    expect(await deliverPendingNotice(s2)).toBe('dropped')
    expect(s2.claim).not.toHaveBeenCalled()
    writeNightlyState(stateDir, { ...readNightlyState(stateDir), pendingNotice: keep })
    expect(await deliverPendingNotice(deps({ careGate: () => ({ ok: false, reason: 'memory_cooldown' }) }))).toBe('waiting')
    expect(await deliverPendingNotice(deps({ claim }))).toBe('sent')
    expect(claim).toHaveBeenCalledWith(OWNER, '2026-09-25T10:00:00.000Z')
    writeNightlyState(stateDir, { ...readNightlyState(stateDir), pendingNotice: { text: 'y', createdAtMs: Date.parse('2026-09-25T04:00:00Z') } })
    expect(await deliverPendingNotice(deps({ careGate: () => ({ ok: false, reason: 'paused_no_reply' }) }))).toBe('dropped')
    writeNightlyState(stateDir, { ...readNightlyState(stateDir), pendingNotice: { text: 'z', createdAtMs: Date.parse('2026-09-24T04:00:00Z') } })
    expect(await deliverPendingNotice(deps())).toBe('expired')
    expect(sent).toEqual(['x'])
  })
  it('readCurated shows the rendered memory with a header; curatedView marks last night changes and dues', async () => {
    const rt = makeMemoryNightlyRuntime(deps())
    expect(rt.readCurated()).toBeNull()
    await rt.runNow()
    const text = rt.readCurated()!
    expect(text.split('\n').slice(0, 2)).toEqual(['这是我眼中的你。', '今天凌晨 4 点整理的,改了 1 处。'])
    expect(text).toContain('【承诺】\n· 周五前给 X 回话(明天)')
    const v = rt.curatedView()!
    expect(v.updated_at).toBe('2026-09-25T04:05:00.000Z')
    expect(v.sections.find(s => s.name === '承诺')!.items[0]).toMatchObject({ text: '周五前给 X 回话(期限 2026-09-26)', due: '2026-09-26', changed: true })
  })
  it('warns in the header after three failed nights', async () => {
    const rt = makeMemoryNightlyRuntime(deps())
    await rt.runNow()
    writeNightlyState(stateDir, { ...readNightlyState(stateDir), failures: 3 })
    expect(rt.readCurated()!.split('\n')[0]).toBe('最近 3 次整理都没成功,下面可能是旧的。')
  })
  it('serializes concurrent runNow calls — the model is never called by two runs at once', async () => {
    let active = 0, maxActive = 0, calls = 0, msg = 0
    const rt = makeMemoryNightlyRuntime(deps({
      sources: { observationsSince: async () => [], milestonesSince: async () => [], messagesSince: async () => [`主人:第 ${msg++} 句`], projectMemory: () => '' },
      cheapEval: () => async () => {
        active++; calls++; maxActive = Math.max(maxActive, active)
        await new Promise(r => setTimeout(r, 20))
        active--
        return JSON.stringify({ add: [{ section: '近况', text: `第 ${calls} 次` }], update: [], confirm: [], remove: [] })
      },
    }))
    const [a, b] = await Promise.all([rt.runNow(), rt.runNow()])
    expect(a.status).toBe('written')
    expect(b.status).toBe('written')
    expect(calls).toBe(2)
    expect(maxActive).toBe(1)
  })
  it('a notice cleared by a delivery while a run is in flight is not resurrected', async () => {
    writeNightlyState(stateDir, { ...readNightlyState(stateDir), pendingNotice: { text: '旧通知', createdAtMs: Date.parse('2026-09-25T04:00:00Z') } })
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    let entered!: () => void
    const inEval = new Promise<void>(r => { entered = r })
    const rt = makeMemoryNightlyRuntime(deps({
      cheapEval: () => async () => {
        entered()
        await gate
        return JSON.stringify({ add: [{ section: '近况', text: '在赶发版' }], update: [], confirm: [], remove: [] })
      },
    }))
    const run = rt.runNow()
    await inEval
    // a delivery sent the old notice and cleared it while the model was thinking
    writeNightlyState(stateDir, { ...readNightlyState(stateDir), pendingNotice: null })
    release()
    expect((await run).status).toBe('written')
    expect(readNightlyState(stateDir).pendingNotice).toBeNull()
  })
  it('logs a repeated skip reason once, not every tick', async () => {
    const log = vi.fn()
    const rt = makeMemoryNightlyRuntime(deps({ log, config: () => ({ enabled: false, at: '04:00', timezone: 'UTC' }) }))
    await rt.tick()
    await rt.tick()
    await rt.tick()
    expect(log).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith('MEMORY_NIGHTLY', 'tick: skipped (disabled)')
  })
  it('logs the same skip reason again after a non-skipped result in between', async () => {
    const log = vi.fn()
    let enabled = false
    const rt = makeMemoryNightlyRuntime(deps({ log, config: () => ({ enabled, at: '04:00', timezone: 'UTC' }) }))
    await rt.tick()
    enabled = true
    await rt.tick()   // written
    enabled = false
    await rt.tick()
    const tickLines = log.mock.calls.filter(c => String(c[1]).startsWith('tick:')).map(c => c[1])
    expect(tickLines).toEqual(['tick: skipped (disabled)', 'tick: written', 'tick: skipped (disabled)'])
  })
})

describe('rich view + WeChat letter', () => {
  it('first: no memory.md yet', () => {
    const v = makeMemoryNightlyRuntime(deps()).curatedView()!
    expect(v).toMatchObject({ mood: 'first', updated_at: null, when_label: null, changes: [], sections: [] })
  })
  it('changed: derived display fields, order, labels', async () => {
    const rt = makeMemoryNightlyRuntime(deps({
      cheapEval: () => async () => JSON.stringify({ add: [
        { section: '承诺', text: '周五回话(期限 2026-09-26)' },
        { section: '身边的人', text: '猪大哥 —— 女友,最亲' },
      ], update: [], confirm: [], remove: [] }),
    }))
    await rt.runNow()
    const v = rt.curatedView()!
    expect(v.mood).toBe('changed')
    expect(v.when_label).toBe('今天凌晨 4 点')
    expect(v.sections.map(s => s.name)).toEqual(['承诺', '身边的人'])
    expect(v.sections[0]!.items[0]).toMatchObject({ display: '周五回话', due: '2026-09-26', due_label: '明天', person: null, changed: true })
    expect(v.sections[1]!.items[0]).toMatchObject({ person: { name: '猪大哥', rel: '女友,最亲' } })
    expect(v.changes.map(c => c.label)).toEqual(['新记下', '记下'])
  })
  it('steady after the changed window; WeChat letter uses the new format', async () => {
    const rt = makeMemoryNightlyRuntime(deps())
    await rt.runNow()
    now = Date.parse('2026-09-27T20:00:00Z')   // > 36h later
    expect(rt.curatedView()!.mood).toBe('steady')
    const text = rt.readCurated()!
    expect(text.split('\n')[0]).toBe('这是我眼中的你。')
    expect(text).toContain('最近没有新变化。')
    expect(text).toContain('【承诺】')
  })
})

describe('owner corrections, step A (2026-10-06)', () => {
  it('removes the entry now, records it in corrections.md so the nightly tidy does not write it back, archives "outdated"', async () => {
    const rt = makeMemoryNightlyRuntime(deps())
    await rt.runNow()
    const id = rt.curatedView().sections.flatMap(s => s.items)[0]!.id!
    expect(id).toMatch(/^[a-f0-9]+$/)
    await rt.correct(id, 'outdated')
    expect(rt.curatedView().sections.flatMap(s => s.items).map(i => i.id)).not.toContain(id)
    const { readFileSync } = await import('node:fs')
    expect(readFileSync(join(root, 'corrections.md'), 'utf8')).toContain('主人说这条已经过时,整理时不要再写回:[承诺] 周五前给 X 回话')
    expect(readFileSync(join(root, 'profile.md'), 'utf8')).not.toContain('不要再写回')
    expect(readFileSync(join(stateDir, 'memory-archive', OWNER, 'memory-expired.md'), 'utf8')).toContain('(owner_outdated)')
    await expect(rt.correct(id, 'wrong')).rejects.toThrow('memory_entry_not_found')
  })
  it('a correction survives a large profile.md and a model that writes the entry back word for word (2026-10-10)', async () => {
    const prompts: string[] = []
    const reAdd = async (p: string) => { prompts.push(p); return JSON.stringify({ add: [{ section: '承诺', text: '周五前给 X 回话(期限 2026-09-26)' }], update: [], confirm: [], remove: [] }) }
    const rt = makeMemoryNightlyRuntime(deps({ cheapEval: () => reAdd }))
    await rt.runNow()
    const id = rt.curatedView().sections.flatMap(s => s.items)[0]!.id!
    await rt.correct(id, 'wrong')
    // CC 白天把 profile.md 整个重写、而且很长:纠正不能靠它
    writeFileSync(join(root, 'profile.md'), '长'.repeat(9000))
    now += 86_400_000
    await rt.runNow()
    expect(rt.curatedView().sections.flatMap(s => s.items).map(i => i.text)).not.toContain('周五前给 X 回话(期限 2026-09-26)')
    expect(prompts.at(-1)).toContain('主人纠正过')
    expect(prompts.at(-1)).toContain('周五前给 X 回话')
  })
  it('no memory yet ⇒ memory_not_found; corrections run on the same queue as the nightly run', async () => {
    const rt = makeMemoryNightlyRuntime(deps())
    await expect(rt.correct('abcd', 'delete')).rejects.toThrow('memory_not_found')
    const run = rt.runNow()
    const corr = run.then(() => rt.curatedView().sections.flatMap(s => s.items)[0]!.id!).then(id => rt.correct(id, 'delete'))
    await Promise.all([run, corr])
    expect(rt.curatedView().sections.flatMap(s => s.items)).toEqual([])
  })
})

describe('出处 × 手机视图与纠错(10-20)', () => {
  it('curatedView carries each entry’s sources; correcting an entry drops them', async () => {
    const rt = makeMemoryNightlyRuntime(deps())
    await rt.runNow()
    const id = rt.curatedView().sections.flatMap(s => s.items)[0]!.id!
    const { writeFileSync: w, readFileSync: r } = await import('node:fs')
    w(join(root, 'memory-sources.json'), JSON.stringify({ [id]: [{ id: 'm-1', ts: '2026-09-24T10:00:00Z', excerpt: '主人:周五前给 X 回话' }] }))
    const item = rt.curatedView().sections.flatMap(s => s.items).find(i => i.id === id)!
    expect(item.sources).toEqual([{ ts: '2026-09-24T10:00:00Z', excerpt: '主人:周五前给 X 回话' }])
    await rt.correct(id, 'wrong')
    expect(JSON.parse(r(join(root, 'memory-sources.json'), 'utf8'))[id]).toBeUndefined()
  })
  it('no sources file ⇒ items have an empty list', async () => {
    const rt = makeMemoryNightlyRuntime(deps())
    await rt.runNow()
    expect(rt.curatedView().sections.flatMap(s => s.items)[0]!.sources).toEqual([])
  })
})

describe('导入记忆(第二轮对标 #7)', () => {
  it('adds confirmed facts under the right sections with an import source; skips dupes and facts the owner rejected', async () => {
    writeFileSync(join(root, 'memory.md'), '## 关于你\n- 你住在上海 <!-- m:aaaa · 2026-09-20 -->\n')
    writeFileSync(join(root, 'corrections.md'), '- 2026-09-21 主人说这条记错了,整理时不要再写回:[偏好] 你喜欢香菜\n')
    const rt = makeMemoryNightlyRuntime(deps())
    const r = await rt.importEntries([
      { section: '关于你', text: '你住在上海' },
      { section: '偏好', text: '你喜欢香菜' },
      { section: '偏好', text: '你喜欢喝美式' },
      { section: '身边的人', text: '你的女儿叫小满' },
    ], 'ChatGPT')
    expect(r).toEqual({ added: 2, skipped: { duplicate: 1, corrected: 1, invalid: 0, cap: 0 } })
    const md = (await import('node:fs')).readFileSync(join(root, 'memory.md'), 'utf8')
    expect(md).toContain('你喜欢喝美式')
    expect(md).toContain('你的女儿叫小满')
    expect(md).not.toContain('香菜')
    const v = rt.curatedView()
    const item = v.sections.flatMap(s => s.items).find(i => i.text === '你喜欢喝美式')!
    expect(item.sources?.[0]).toMatchObject({ kind: 'import', excerpt: '从 ChatGPT 导入' })
  })
  it('works with no memory.md yet (creates it); stops at the size cap', async () => {
    const rt = makeMemoryNightlyRuntime(deps())
    const big = Array.from({ length: 30 }, (_, i) => ({ section: '关于你' as const, text: `事实 ${i} ${'字'.repeat(150)}` }))
    const r = await rt.importEntries(big, 'Gemini')
    expect(r.added).toBeGreaterThan(0)
    expect(r.skipped.cap).toBeGreaterThan(0)
    expect(r.added + r.skipped.cap).toBe(30)
  })
})

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
    open: () => ({ sendText: async (_c, t) => { sent.push(t); return { msgId: 'm' } }, channel: () => 'wechat', textOnly: () => false, sendAttachment: async () => false, sendSticker: async () => false, finish: () => {} }),
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
  // 3e 记忆第 2 步(整合者定):每晚整理只是多了 / 整理了东西 ⇒ 总览 added(贴标签照常用);主人纠正 ⇒ retracted(藏,不带去串门)。
  // 3b (a) 清源头:更正一条,CC 笔记里含那句的行也删掉;删了什么记在 corrections.md 那一条底下;原文件快照能找回。
  it('a correction also purges the same sentence from profile.md, notes it under the correction, and archives the original', async () => {
    const { readFileSync, readdirSync } = await import('node:fs')
    const rt = makeMemoryNightlyRuntime(deps())
    await rt.runNow()
    const item = rt.curatedView().sections.flatMap(s => s.items)[0]!
    writeFileSync(join(root, 'profile.md'), `- ${item.text}\n- 喜欢爬山\n`)
    await rt.correct(item.id!, 'wrong')
    expect(readFileSync(join(root, 'profile.md'), 'utf8')).toBe('- 喜欢爬山\n')
    const corr = readFileSync(join(root, 'corrections.md'), 'utf8')
    expect(corr).toContain('随之从 profile.md 删了 1 行')
    const archived = readdirSync(join(stateDir, 'memory-archive', OWNER, 'corrections'))
    expect(archived.some(f => f.startsWith('profile.md.'))).toBe(true)
  })
  it('the nightly tidy marks derived memory "added"; an owner correction marks it "retracted"', async () => {
    const { derivedMemoryStatus } = await import('../../lib/memory-derived-state')
    const rt = makeMemoryNightlyRuntime(deps())
    await rt.runNow()
    expect(derivedMemoryStatus(root, 'overview')).toBe('added')
    const id = rt.curatedView().sections.flatMap(s => s.items)[0]!.id!
    await rt.correct(id, 'wrong')
    expect(derivedMemoryStatus(root, 'overview')).toBe('retracted')
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

// 整合者记的欠账:CC 自己换了说法的待办(「问问杭州之行」对「下周去杭州出差」)逐字接不住 —— 更正后在后台问一次便宜模型。
describe('correction → agenda drop by cheap model', () => {
  const NIGHTLY_ANSWER = JSON.stringify({ add: [{ section: '承诺', text: '下周去杭州出差谈合同' }], update: [], confirm: [], remove: [] })
  const agenda = '- [ ] due:2026-10-30 问问杭州之行顺不顺利\n- [ ] due:2026-11-02 提醒周报\n'
  async function setup(agendaAnswer: (p: string) => Promise<string>) {
    const { readFileSync } = await import('node:fs')
    const asked: string[] = []
    const rt = makeMemoryNightlyRuntime(deps({ cheapEval: () => async (p: string) => {
      if (p.includes('跟进计划')) { asked.push(p); return agendaAnswer(p) }
      return NIGHTLY_ANSWER
    } }))
    await rt.runNow()
    writeFileSync(join(root, 'agenda.md'), agenda)
    const id = rt.curatedView().sections.flatMap(s => s.items)[0]!.id!
    const read = (f: string) => readFileSync(join(root, f), 'utf8')
    return { rt, id, asked, read }
  }
  it('the model picks a reworded follow-up; it is dropped, the correction record says CC judged it, and the other item stays', async () => {
    const { rt, id, asked, read } = await setup(async () => '1')
    await rt.correct(id, 'wrong')
    await vi.waitFor(() => expect(read('agenda.md')).toContain('- [x] dropped:'))
    expect(read('agenda.md')).toContain('问问杭州之行顺不顺利')
    expect(read('agenda.md')).toContain('- [ ] due:2026-11-02 提醒周报')
    expect(asked[0]).toContain('「下周去杭州出差谈合同」')
    await vi.waitFor(() => expect(read('corrections.md')).toContain('CC 又判断 agenda.md 里 1 条待办在跟进这件事'))
  })
  it('the owner\'s correction returns before the model answers', async () => {
    let answer!: (s: string) => void
    const { rt, id, asked, read } = await setup(() => new Promise<string>(r => { answer = r }))
    const t = await Promise.race([rt.correct(id, 'wrong').then(() => 'returned'), new Promise(r => setTimeout(() => r('blocked'), 500))])
    expect(t).toBe('returned')
    await vi.waitFor(() => expect(asked).toHaveLength(1))
    expect(read('agenda.md')).toBe(agenda)
    answer('1')
    await vi.waitFor(() => expect(read('agenda.md')).toContain('- [x] dropped:'))
  })
  it('the note line never reads as another correction, even when the to-do text has "] " in it', async () => {
    const { correctedTexts } = await import('../../lib/memory-corrections')
    const { rt, id, read } = await setup(async () => '1')
    writeFileSync(join(root, 'agenda.md'), '- [ ] due:2026-10-30 [杭州] 问问出差顺不顺利\n')
    const before = correctedTexts(root).size
    await rt.correct(id, 'wrong')
    await vi.waitFor(() => expect(read('corrections.md')).toContain('CC 又判断'))
    expect(correctedTexts(root).size).toBe(before + 1)   // 只多了主人那一条
  })
  it.each([
    ['model error', async () => { throw new Error('boom') }],
    ['a chatty answer', async () => '我觉得第 1 条有关'],
  ])('%s ⇒ nothing extra dropped, no throw', async (_name, ans) => {
    const { rt, id, asked, read } = await setup(ans)
    await rt.correct(id, 'wrong')
    await vi.waitFor(() => expect(asked).toHaveLength(1))
    await rt.runNow()   // 同一条串行链:它跑完,后台那一步一定落定了
    expect(read('agenda.md')).toBe(agenda)
  })
})

describe('记忆编辑 view / edit(设计稿 2026-10-23 记忆改了就算数 §3 §4)', () => {
  const memoryMd = [
    '<!-- wechat-cc 记忆 · 2026-10-22T00:00:00Z -->', '## 关于你', '- 住杭州 <!-- m:aa01 · 2026-10-22 -->', '## 偏好', '- 喜欢美式 <!-- m:aa02 · 2026-10-22 -->',
  ].join('\n') + '\n'
  const overview = '<!-- 由 wechat-cc 从本机 Claude 记忆整理生成 · 2026-10-23T01:00:00.000Z -->\n\n主人在做 wechat-cc。\n- 喜欢美式咖啡\n'
  const read = (f: string) => { try { return readFileSync(join(root, f), 'utf8') } catch { return '' } }
  const lines = (v: { lines: Array<{ text: string; lineKey?: string; assertionId?: string }> }) => v.lines.map(l => ({ text: l.text, ...(l.lineKey ? { lineKey: l.lineKey } : {}), ...(l.assertionId ? { assertionId: l.assertionId } : {}) }))
  beforeEach(() => {
    writeFileSync(join(root, 'memory.md'), memoryMd)
    writeFileSync(join(root, '_overview.md'), overview)
    writeFileSync(join(root, 'profile.md'), '主人喜欢美式咖啡,常去楼下那家\n别的笔记\n')
  })

  it('view:生成的行带键、没有尾注;总览带生成时间', () => {
    const rt = makeMemoryNightlyRuntime(deps())
    const m = rt.view('memory.md')
    expect(m.chatId).toBe(OWNER)
    expect(m.lines.map(l => [l.text, l.lineKey])).toEqual([['住杭州', 'm:aa01'], ['喜欢美式', 'm:aa02']])
    const o = rt.view('_overview.md')
    expect(o.lines.map(l => l.text)).toEqual(['主人在做 wechat-cc。', '喜欢美式咖啡'])
    expect(o.generatedAt).toBe('2026-10-23T01:00:00.000Z')
    expect(o.lines.every(l => l.origin === 'generated')).toBe(true)
  })

  it('总览上改一行 ⇒ 更正(段名 [总览 · c:<id>],清源头)+ 主人原话(带 replaces);view 里它是 owner 行', async () => {
    const rt = makeMemoryNightlyRuntime(deps())
    const v = rt.view('_overview.md')
    const r = await rt.edit({ path: '_overview.md', baseHash: v.baseHash, lines: lines(v).map(l => l.text === '喜欢美式咖啡' ? { ...l, text: '只喝茶' } : l) })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.corrections).toHaveLength(1)
    const cid = r.corrections[0]!.id
    expect(r.assertions).toEqual([{ id: expect.any(String), text: '只喝茶', replaces: { correctionId: cid, text: '喜欢美式咖啡' } }])
    expect(r.regenerate).toBe('queued')
    expect(read('corrections.md')).toContain(`[总览 · c:${cid}] 喜欢美式咖啡`)
    expect(read('profile.md')).not.toContain('喜欢美式咖啡')        // 清源头
    expect(read('profile.md')).toContain('别的笔记')
    expect(read('owner.md')).toContain('只喝茶')
    expect(read('_overview.md')).toBe(overview)                     // 生成物不手改,等重新生成
    const after = rt.view('_overview.md')
    expect(after.lines[0]).toEqual({ text: '只喝茶', origin: 'owner', assertionId: r.assertions[0]!.id, editedAt: '2026-09-25', replaces: { correctionId: cid, text: '喜欢美式咖啡' } })
    expect(after.stale).toBe(true)
  })

  it('记忆上删一条有编号的 ⇒ 走逐条纠错同一条路:从 memory.md 拿掉、段名用它原来的栏', async () => {
    const rt = makeMemoryNightlyRuntime(deps())
    const v = rt.view('memory.md')
    const r = await rt.edit({ path: 'memory.md', baseHash: v.baseHash, lines: lines(v).filter(l => l.lineKey !== 'm:aa02') })
    expect(r.ok && r.corrections.map(c => c.text)).toEqual(['喜欢美式'])
    expect(read('memory.md')).not.toContain('喜欢美式')
    expect(read('memory.md')).toContain('住杭州')
    expect(read('corrections.md')).toMatch(/\[偏好 · c:[0-9a-f]+\] 喜欢美式/)
  })

  it('baseHash 对不上 ⇒ memory_changed,磁盘一个字节不变;owner.md 变了也算', async () => {
    const rt = makeMemoryNightlyRuntime(deps())
    const v = rt.view('memory.md')
    writeFileSync(join(root, 'owner.md'), '- 别处写的 <!-- o:ff01 · 2026-10-23 · owner -->\n')
    const r = await rt.edit({ path: 'memory.md', baseHash: v.baseHash, lines: [] })
    expect(r).toEqual({ ok: false, code: 'memory_changed' })
    expect(read('memory.md')).toBe(memoryMd)
    expect(read('corrections.md')).toBe('')
  })

  it('大批删除不确认 ⇒ 什么都不写;确认了才落', async () => {
    const many = '## 关于你\n' + Array.from({ length: 6 }, (_, i) => `- 第${i}条事实很长一点 <!-- m:bb0${i} · 2026-10-22 -->`).join('\n') + '\n'
    writeFileSync(join(root, 'memory.md'), many)
    const rt = makeMemoryNightlyRuntime(deps())
    const v = rt.view('memory.md')
    expect(await rt.edit({ path: 'memory.md', baseHash: v.baseHash, lines: [] })).toEqual({ ok: false, code: 'memory_edit_bulk', count: 6, deleted: 6, rewritten: 0 })
    expect(read('memory.md')).toBe(many)
    const r = await rt.edit({ path: 'memory.md', baseHash: v.baseHash, lines: [], confirmBulk: true })
    expect(r.ok && r.corrections).toHaveLength(6)
  })

  it('什么都没改 ⇒ not_needed,不碰任何文件', async () => {
    const rt = makeMemoryNightlyRuntime(deps())
    const v = rt.view('_overview.md')
    expect(await rt.edit({ path: '_overview.md', baseHash: v.baseHash, lines: lines(v) })).toEqual({ ok: true, corrections: [], assertions: [], regenerate: 'not_needed' })
    expect(read('corrections.md')).toBe('')
    expect(read('owner.md')).toBe('')
  })

  it('在 owner.md 上收回自己的话 ⇒ 去掉 + 一条 [你写的] 更正', async () => {
    const rt = makeMemoryNightlyRuntime(deps())
    const v0 = rt.view('owner.md')
    const add = await rt.edit({ path: 'owner.md', baseHash: v0.baseHash, lines: [{ text: '周末不谈工作' }] })
    expect(add.ok && add.assertions.map(a => a.text)).toEqual(['周末不谈工作'])
    const v1 = rt.view('owner.md')
    const r = await rt.edit({ path: 'owner.md', baseHash: v1.baseHash, lines: [] })
    expect(r.ok && r.corrections.map(c => c.text)).toEqual(['周末不谈工作'])
    expect(read('owner.md')).not.toContain('周末不谈工作')
    expect(read('corrections.md')).toMatch(/\[你写的 · c:[0-9a-f]+\] 周末不谈工作/)
  })
})

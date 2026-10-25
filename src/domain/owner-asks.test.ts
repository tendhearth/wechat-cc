import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  EMPTY_ASKS, ASK_MAX_DAYS, ASK_ONLY_IN_BRIEF, ASK_PLACEHOLDER, answerAsk, approvalFor, commitAsked, enqueue, expireStale,
  formatAsks, lookupAsk, parseAskReply, pickForBrief, renderAsksBlock, spliceAsks, type EnqueueInput, type OwnerAsksState,
} from './owner-asks'
import { coerceAsks, makeOwnerAsksStore, OWNER_ASKS_FILE } from '../adapters/store/owner-asks-store'
import { writeFileSync } from 'node:fs'

const T0 = '2026-10-24T00:00:00.000Z'
const day = (n: number) => new Date(Date.parse(T0) + n * 86_400_000).toISOString()
const inp = (key: string, extra: Partial<EnqueueInput> = {}): EnqueueInput => ({ key, question: `问题 ${key}?`, recommend: `推荐 ${key}`, source: 'manual', ...extra })
const add = (s: OwnerAsksState, key: string, hash = 'h-' + key, extra: Partial<EnqueueInput> = {}, at = T0) => enqueue(s, inp(key, extra), { nowIso: at, hash, id: 'id-' + key + '-' + hash })

describe('入队(同一个 key 只排一条)', () => {
  it('adds, keeps the same version, replaces an open one with a new version and drops its old number', () => {
    let s = add(EMPTY_ASKS, 'a').state
    expect(add(s, 'a').result).toBe('same')
    s = commitAsked(s, pickForBrief(s, 0), T0)
    expect(s.batch?.nos['1']).toBe('id-a-h-a')
    const r = add(s, 'a', 'h2')
    expect(r.result).toBe('updated')
    expect(r.state.items).toHaveLength(1)
    expect(r.item).toMatchObject({ id: 'id-a-h-a', hash: 'h2', status: 'queued', asks: [] })
    expect(r.state.batch?.nos['1']).toBeUndefined()
  })
  it('declined / unanswered ⇒ closed for good; approved + new version ⇒ a new record to re-approve', () => {
    let s = add(EMPTY_ASKS, 'a').state
    s = add(s, 'b').state
    s = commitAsked(s, pickForBrief(s, 0), T0)
    s = answerAsk(s, { no: 1, verdict: 'declined', by: 'owner', nowIso: day(0.1) }).state
    s = answerAsk(s, { no: 2, verdict: 'approved', by: 'owner', nowIso: day(0.1) }).state
    expect(add(s, 'a', 'whatever').result).toBe('closed')
    expect(add(s, 'b').result).toBe('same')
    const again = add(s, 'b', 'h-new')
    expect(again.result).toBe('added')
    expect(again.state.items.filter(i => i.key === 'b')).toHaveLength(2)
  })
})

describe('入队 × 历史里已经答过的版本(整合者评审 #659)', () => {
  it('approved@H1 → queued@H2 → H1 again ⇒ same (the approved one), the open H2 is withdrawn, never re-asks H1', () => {
    let s = add(EMPTY_ASKS, 'a', 'H1').state
    s = commitAsked(s, pickForBrief(s, 0), T0)
    s = answerAsk(s, { no: 1, verdict: 'approved', by: 'owner', nowIso: day(0.1) }).state
    s = add(s, 'a', 'H2', {}, day(1)).state
    s = commitAsked(s, pickForBrief(s, 0), day(1))
    expect(s.batch?.nos['1']).toBe('id-a-H2')
    const r = add(s, 'a', 'H1', {}, day(1.1))
    expect(r.result).toBe('same')
    expect(r.item.status).toBe('approved')
    expect(r.state.items.map(i => [i.hash, i.status])).toEqual([['H1', 'approved']])
    expect(r.state.batch?.nos['1']).toBeUndefined()
    expect(pickForBrief(r.state, 0)).toEqual([])
  })
  it('declined anywhere in the history closes the key, whatever version comes next', () => {
    let s = add(EMPTY_ASKS, 'a', 'H1').state
    s = commitAsked(s, pickForBrief(s, 0), T0)
    s = answerAsk(s, { no: 1, verdict: 'declined', by: 'owner', nowIso: day(0.1) }).state
    expect(add(s, 'a', 'H1').result).toBe('closed')
    expect(add(s, 'a', 'H9').result).toBe('closed')
  })
})

describe('早报挑哪几条', () => {
  it('at most 3, numbered after the brief’s own decision items; asked ones first, then priority, then oldest', () => {
    let s = EMPTY_ASKS
    for (const [k, p, at] of [['a', 0, day(0)], ['b', 5, day(0.2)], ['c', 0, day(0.1)], ['d', 0, day(0.3)]] as const) s = add(s, k, undefined, { priority: p }, at).state
    const first = pickForBrief(s, 2)
    expect(first.map(p => [p.no, p.id])).toEqual([[3, 'id-b-h-b'], [4, 'id-a-h-a'], [5, 'id-c-h-c']])
    s = commitAsked(s, first.slice(1, 2), day(1)) // 只有 a 真问到了
    expect(pickForBrief(s, 0).map(p => p.id)).toEqual(['id-a-h-a', 'id-b-h-b', 'id-c-h-c'])
  })
  it('nothing open ⇒ nothing picked (the brief gets no such section)', () => {
    expect(pickForBrief(EMPTY_ASKS, 1)).toEqual([])
    expect(renderAsksBlock([])).toBe('')
  })
  it('a version swapped mid-brief is not marked asked', () => {
    let s = add(EMPTY_ASKS, 'a').state
    const picked = pickForBrief(s, 0)
    s = add(s, 'a', 'h2').state
    s = commitAsked(s, picked, T0)
    expect(s.items[0]).toMatchObject({ status: 'queued', asks: [] })
  })
})

describe('问满三天没回 ⇒ 主人没要(主人 10-24 确认)', () => {
  it('after three briefs it is recorded as unanswered by cc, never asked again, and the key stays closed', () => {
    let s = add(EMPTY_ASKS, 'a').state
    for (let d = 0; d < ASK_MAX_DAYS; d++) {
      s = expireStale(s, day(d))
      const p = pickForBrief(s, 0)
      expect(p).toHaveLength(1)
      s = commitAsked(s, p, day(d))
    }
    s = expireStale(s, day(ASK_MAX_DAYS))
    expect(pickForBrief(s, 0)).toEqual([])
    expect(s.items[0]).toMatchObject({ status: 'unanswered', answer: { verdict: 'unanswered', by: 'cc', via: 'expired', hash: 'h-a' } })
    expect(add(s, 'a').result).toBe('closed')
  })
})

describe('回「2」/「2 不要」', () => {
  it('parses yes / no, ignores anything else', () => {
    expect(parseAskReply('2')).toEqual({ no: 2, verdict: 'approved' })
    expect(parseAskReply(' 3 要 ')).toEqual({ no: 3, verdict: 'approved' })
    expect(parseAskReply('2 不要')).toEqual({ no: 2, verdict: 'declined' })
    expect(parseAskReply('2不要。')).toEqual({ no: 2, verdict: 'declined' })
    expect(parseAskReply('2、算了')).toEqual({ no: 2, verdict: 'declined' })
    expect(parseAskReply('2 个人')).toBeNull()
    expect(parseAskReply('我选 2')).toBeNull()
    expect(parseAskReply('2026')).toBeNull()
  })
  it('records who / when / which version; only within the latest brief’s window; a second answer is not claimed (plain chat again)', () => {
    let s = add(EMPTY_ASKS, 'a').state
    s = commitAsked(s, pickForBrief(s, 1), T0)
    expect(answerAsk(s, { no: 1, verdict: 'approved', by: 'owner', nowIso: day(0.1) }).r.result).toBe('none') // 1 是早报自己的那条
    expect(answerAsk(s, { no: 2, verdict: 'approved', by: 'owner', nowIso: day(0.55) }).r.result).toBe('none') // 过了 12 小时窗口
    const r = answerAsk(s, { no: 2, verdict: 'approved', by: 'owner', nowIso: day(0.1) })
    expect(r.r.result).toBe('recorded')
    s = r.state
    expect(s.items[0]!.answer).toEqual({ verdict: 'approved', by: 'owner', at: day(0.1), hash: 'h-a', via: 'wechat_brief' })
    expect(approvalFor(s, 'a', 'h-a')?.by).toBe('owner')
    expect(approvalFor(s, 'a', 'other')).toBeNull()
    expect(answerAsk(s, { no: 2, verdict: 'declined', by: 'owner', nowIso: day(0.2) }).r.result).toBe('none')
    expect(lookupAsk(s, 2, Date.parse(day(0.2)))).toBeNull()
  })
})

describe('接进早报', () => {
  const block = renderAsksBlock([{ no: 3, id: 'x', hash: 'h', question: '微信里改成先问再做?', recommend: '改。' }])
  it('renders one line of question + one line of recommendation each, and how to answer', () => {
    expect(block.split('\n')).toEqual([
      '要你拍板的(CC 自己找到的):',
      '3. 微信里改成先问再做?',
      '   推荐:改。',
      '回「3」就是要,「3 不要」就是不要;不回就先放着,问满三天不再提。',
    ])
  })
  it('goes where the model put the placeholder; extra placeholders vanish', () => {
    const out = spliceAsks(['1. 终端里有一件等你批', ASK_PLACEHOLDER, '昨天做完 2 件', ASK_PLACEHOLDER, '就这些。'].join('\n'), block)
    expect(out.split('\n')[1]).toBe('要你拍板的(CC 自己找到的):')
    expect(out).not.toContain(ASK_PLACEHOLDER)
    expect(out.trim().endsWith('就这些。')).toBe(true)
  })
  it('no placeholder ⇒ before 「就这些。」; no closing line ⇒ at the end; never adds a blank line', () => {
    const a = spliceAsks('昨天做完 2 件\n就这些。\n', block)
    expect(a.split('\n').at(-1)).toBe('就这些。')
    expect(a.split('\n')[1]).toBe('要你拍板的(CC 自己找到的):')
    expect(spliceAsks('昨天做完 2 件', block).endsWith('问满三天不再提。')).toBe(true)
    expect(a).not.toMatch(/\n\s*\n/)
  })
})

describe('没开早报不单发(默认,待主人点头)', () => {
  it('is one obvious constant', () => { expect(ASK_ONLY_IN_BRIEF).toBe(true) })
})

describe('owner-asks.json 读进来核形状(整合者评审 #659)', () => {
  it('asked with no asks ⇒ repaired to queued (so picking never throws); unrepairable items are dropped; logged once', () => {
    const r = coerceAsks({ items: [
      { id: 'x', key: 'k', question: 'q?', recommend: 'r', hash: 'h', status: 'asked', createdAt: T0 },
      { id: 'y', key: 'k2', question: 'q?', recommend: 'r', hash: 'h', status: 'asked', asks: [T0], createdAt: T0, priority: 0, source: 'manual' },
      { id: 'z', key: 'k3', status: 'queued' },
      { id: 'w', key: 'k4', question: 'q?', recommend: 'r', hash: 'h', status: 'weird', asks: [] },
      null,
    ], batch: { at: 5 } })
    expect(r.state.items.map(i => [i.id, i.status, i.asks.length])).toEqual([['x', 'queued', 0], ['y', 'asked', 1]])
    expect(r.state.batch).toBeNull()
    expect(r.repaired).toBe(4)
    expect(() => pickForBrief(r.state, 0)).not.toThrow()
    const dir = mkdtempSync(join(tmpdir(), 'owner-asks-bad-'))
    const path = join(dir, OWNER_ASKS_FILE)
    writeFileSync(path, JSON.stringify({ items: [{ id: 'x', key: 'k', question: 'q?', recommend: 'r', hash: 'h', status: 'asked', createdAt: T0 }] }))
    const logs: string[] = []
    const st = makeOwnerAsksStore(path, { log: (_t, l) => logs.push(l) })
    expect(st.pickForBrief(0, T0).map(p => p.id)).toEqual(['x'])
    st.read()
    expect(logs).toHaveLength(1)
  })
})

describe('owner-asks.json', () => {
  it('round-trips through the file, expires before picking, and formats a list', () => {
    const dir = mkdtempSync(join(tmpdir(), 'owner-asks-'))
    const path = join(dir, OWNER_ASKS_FILE)
    let n = 0
    const st = makeOwnerAsksStore(path, { newId: () => `id${++n}` })
    expect(st.read()).toEqual(EMPTY_ASKS)
    expect(st.enqueueVisibleCandidate(inp('a', { version: 'v1' })).result).toBe('added')
    expect(st.enqueueVisibleCandidate(inp('a', { version: 'v1' })).result).toBe('same')
    expect(st.enqueueVisibleCandidate(inp('a', { version: 'v2' })).result).toBe('updated')
    expect(existsSync(path)).toBe(true)
    for (let d = 0; d < ASK_MAX_DAYS; d++) st.commitAsked(st.pickForBrief(0, day(d)), day(d))
    expect(st.pickForBrief(0, day(ASK_MAX_DAYS))).toEqual([])
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    expect(raw.items[0].status).toBe('unanswered')
    expect(formatAsks(st.read())).toBe('没有在等主人拍板的候选。')
    expect(formatAsks(st.read(), { all: true })).toContain('主人没要')
  })
  it('answers through the store', () => {
    const dir = mkdtempSync(join(tmpdir(), 'owner-asks-'))
    const st = makeOwnerAsksStore(join(dir, OWNER_ASKS_FILE))
    st.enqueueVisibleCandidate(inp('a'))
    st.commitAsked(st.pickForBrief(0, T0), T0)
    const r = st.answer({ no: 1, verdict: 'declined', by: 'o@im.wechat', nowIso: day(0.1) })
    expect(r.result).toBe('recorded')
    expect(st.read().items[0]!.status).toBe('declined')
  })
})

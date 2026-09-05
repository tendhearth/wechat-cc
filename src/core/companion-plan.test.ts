import { describe, it, expect } from 'vitest'
import {
  computeCandidates, buildPlanPrompt, parsePlan, pickFallback, constrainPlan, shouldReask, formatLocal,
  PLAN_REASK_MS, PLAN_OBSERVATION_CHARS, PLAN_PERSONA_CHARS, PLAN_TITLE_CHARS,
  type PlanContext, type PlanLogEntry,
} from './companion-plan'

const NOW = '2026-05-13T02:00:00.000Z'   // 北京 10:00 周三
const base = { isOwnerChat: true, level: 'low' as const, prefs: {}, socialWired: true, nowIso: NOW, ledger: { noReplyCount: 0 }, lastInboundAtIso: '2026-05-01T00:00:00.000Z' }

const ctx = (over: Partial<PlanContext> = {}): PlanContext => ({
  nowLocal: '2026-05-13 10:00 周三', ownerLastInboundMinutesAgo: 600,
  today: { lastHuntHoursAgo: null, lastVisitHoursAgo: null, lastProactiveHoursAgo: null },
  candidates: [{ action: 'hunt' }, { action: 'visit' }], rejected: [{ action: 'gap', reason: 'gap_inbound_recent' }],
  journal: { unread: 2, latest: [{ kind: 'postcard', title: '我朋友周末常去', ts: NOW }] },
  social: { openWishes: 1, pendingOffers: 0, provenChannels: [{ id: 'pair:abc', label: '第 1 度的朋友' }] },
  observations: [{ tone: 'warm', body: '主人最近在忙搬家' }], personaExcerpt: '话不多,爱观察',
  earlierToday: [{ at: '2026-05-13T00:30:00.000Z', decision: 'none', why: '太早了' }],
  ...over,
})

describe('computeCandidates', () => {
  it('主人会话、无冷却、安静不够久 → hunt 与 visit 是候选,gap 被拒并带 reason', () => {
    const r = computeCandidates({ ...base, lastInboundAtIso: '2026-05-13T01:00:00.000Z' })
    expect(r.candidates.map(c => c.action)).toEqual(['hunt', 'visit'])
    expect(r.rejected).toEqual([{ action: 'gap', reason: 'gap_inbound_recent' }])
  })
  it('打猎冷却中 → hunt 进 rejected(hunt_cooldown),visit 仍是候选', () => {
    const r = computeCandidates({ ...base, ledger: { noReplyCount: 0, lastHuntAtIso: '2026-05-13T00:00:00.000Z' }, lastInboundAtIso: '2026-05-13T01:00:00.000Z' })
    expect(r.candidates.map(c => c.action)).toEqual(['visit'])
    expect(r.rejected.find(x => x.action === 'hunt')?.reason).toBe('hunt_cooldown')
  })
  it('非主人会话只可能有 gap;pref hunt=false / 社交没接线 分别拿掉 hunt / visit', () => {
    expect(computeCandidates({ ...base, isOwnerChat: false }).candidates.map(c => c.action)).toEqual(['gap'])
    expect(computeCandidates({ ...base, prefs: { hunt: false } }).candidates.map(c => c.action)).not.toContain('hunt')
    expect(computeCandidates({ ...base, socialWired: false }).candidates.map(c => c.action)).not.toContain('visit')
  })
  it('care off → 全部被拒 care_off,候选为空', () => {
    const r = computeCandidates({ ...base, level: 'off' })
    expect(r.candidates).toEqual([])
    expect(r.rejected.every(x => x.reason === 'care_off')).toBe(true)
  })
})

describe('buildPlanPrompt', () => {
  it('含候选、被拒理由、今天之前的判断、包袱与社交计数,且要求严格 JSON', () => {
    const p = buildPlanPrompt(ctx())
    for (const s of ['"hunt"', '"visit"', 'gap_inbound_recent', '太早了', '"unread":2', '"openWishes":1', 'pair:abc', '只输出 JSON', '"none"']) expect(p).toContain(s)
  })
  it('observations / persona / 标题按上限截断', () => {
    const obs = 'o'.repeat(500)
    const persona = 'p'.repeat(500)
    const title = 't'.repeat(500)
    const p = buildPlanPrompt(ctx({ observations: [{ tone: null, body: obs }], personaExcerpt: persona, journal: { unread: 1, latest: [{ kind: 'hunt', title, ts: NOW }] } }))
    expect(p).toContain('o'.repeat(PLAN_OBSERVATION_CHARS))
    expect(p.match(/o{81,}/)).toBeNull()
    expect(p).toContain('p'.repeat(PLAN_PERSONA_CHARS))
    expect(p.match(/p{301,}/)).toBeNull()
    expect(p).toContain('t'.repeat(PLAN_TITLE_CHARS))
    expect(p.match(/t{41,}/)).toBeNull()
  })
  it('social / journal 为 null 时写「没接线」,不抛', () => {
    const p = buildPlanPrompt(ctx({ social: null, journal: null }))
    expect(p).toContain('没接线')
  })
})

describe('parsePlan', () => {
  it('接受四个动作、剥 ```json 围栏、保留 target', () => {
    expect(parsePlan('{"action":"visit","why":"上午没人聊","target":"pair:abc"}')).toEqual({ ok: true, plan: { action: 'visit', why: '上午没人聊', target: 'pair:abc' } })
    expect(parsePlan('```json\n{"action":"none","why":"主人在聊"}\n```')).toEqual({ ok: true, plan: { action: 'none', why: '主人在聊' } })
  })
  it('拒:非 JSON / 非对象 / 未知 action / 多余字段 / why 过长 / target 非字符串', () => {
    for (const raw of ['not json', '[]', '{"action":"paint","why":"x"}', '{"action":"hunt","why":"x","extra":1}', `{"action":"hunt","why":"${'x'.repeat(200)}"}`, '{"action":"hunt","why":"x","target":3}']) {
      expect(parsePlan(raw).ok).toBe(false)
    }
  })
})

describe('pickFallback / constrainPlan', () => {
  it('回退顺序 hunt → visit → gap;空候选 → null', () => {
    expect(pickFallback([{ action: 'gap' }, { action: 'visit' }])).toBe('visit')
    expect(pickFallback([{ action: 'gap' }])).toBe('gap')
    expect(pickFallback([])).toBeNull()
  })
  it('候选外的动作降级为 none;target 不在 provenIds 里被删掉', () => {
    expect(constrainPlan({ action: 'gap', why: 'w' }, [{ action: 'hunt' }], [])).toEqual({ plan: { action: 'none', why: 'w' }, downgraded: true })
    expect(constrainPlan({ action: 'visit', why: 'w', target: 'zzz' }, [{ action: 'visit' }], ['pair:abc'])).toEqual({ plan: { action: 'visit', why: 'w' }, downgraded: false })
    expect(constrainPlan({ action: 'visit', why: 'w', target: 'pair:abc' }, [{ action: 'visit' }], ['pair:abc']).plan.target).toBe('pair:abc')
  })
})

describe('shouldReask', () => {
  const at = (msAgo: number) => new Date(Date.parse(NOW) - msAgo).toISOString()
  const e = (over: Partial<PlanLogEntry>): PlanLogEntry => ({ at: at(0), chatId: 'c1', candidates: ['hunt'], decision: 'none', why: 'w', source: 'model', ...over })
  it('上一条 model+none 且不到 90 分钟 → 不再问;超过 → 问', () => {
    expect(shouldReask([e({ at: at(PLAN_REASK_MS - 1) })], 'c1', Date.parse(NOW))).toBe(false)
    expect(shouldReask([e({ at: at(PLAN_REASK_MS + 1) })], 'c1', Date.parse(NOW))).toBe(true)
  })
  it('fallback / downgraded / 别的 chat / 上一条不是 none → 都问', () => {
    expect(shouldReask([e({ source: 'fallback' })], 'c1', Date.parse(NOW))).toBe(true)
    expect(shouldReask([e({ source: 'downgraded' })], 'c1', Date.parse(NOW))).toBe(true)
    expect(shouldReask([e({ chatId: 'c2' })], 'c1', Date.parse(NOW))).toBe(true)
    expect(shouldReask([e({ decision: 'hunt' })], 'c1', Date.parse(NOW))).toBe(true)
    expect(shouldReask([], 'c1', Date.parse(NOW))).toBe(true)
  })
})

describe('formatLocal', () => {
  it('固定时区下输出 YYYY-MM-DD HH:mm 周X', () => {
    expect(formatLocal(NOW, 'Asia/Shanghai')).toBe('2026-05-13 10:00 周三')
  })
})

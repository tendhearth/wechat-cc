import { describe, it, expect } from 'vitest'
import {
  VISIT_MAX_ROUNDS, visitEnvelope, parseVisitPayload, nextRound,
  transcriptFromLetters, buildVisitReplyPrompt, buildVisitNarrationPrompt,
} from './visit'
import { openEnvelope, sealEnvelope } from './envelope'

const H = { id: 'v-1', round: 1, max: 6 }

describe('串门信封', () => {
  it('visitEnvelope ↔ parseVisitPayload 往返(经 seal/open)', () => {
    const p = parseVisitPayload(openEnvelope(sealEnvelope(visitEnvelope(H, '你好呀'))))
    expect(p).toEqual({ ...H, text: '你好呀' })
  })

  it('普通信不是串门(主人写的信绝不能被当成伙伴对话)', () => {
    expect(parseVisitPayload(openEnvelope('你好,我是你的笔友'))).toBeNull()
    expect(parseVisitPayload({ kind: 'gift', payload: { id: 'x', round: 1, max: 6, text: 'x' } })).toBeNull()
  })

  it('坏轮次拒收:round>max、0、缺字段', () => {
    expect(parseVisitPayload({ kind: 'visit', payload: { id: 'a', round: 7, max: 6, text: 'x' } })).toBeNull()
    expect(parseVisitPayload({ kind: 'visit', payload: { id: 'a', round: 0, max: 6, text: 'x' } })).toBeNull()
    expect(parseVisitPayload({ kind: 'visit', payload: { id: 'a', round: 1, max: 6 } })).toBeNull()
  })

  it('nextRound 到 max 停', () => {
    expect(nextRound({ ...H, round: 5 })).toEqual({ ...H, round: 6 })
    expect(nextRound({ ...H, round: 6 })).toBeNull()
  })

  it('默认 6 封 = 两边各 3 句', () => { expect(VISIT_MAX_ROUNDS).toBe(6) })
})

describe('transcriptFromLetters', () => {
  const L = (dir: 'in' | 'out', round: number, text: string, id = 'v-1') =>
    ({ direction: dir, kind: 'visit', payload: JSON.stringify({ id, round, max: 6, text }) })

  it('按轮次排,不按到达顺序 —— 信箱是 at-least-once,顺序不可信', () => {
    const t = transcriptFromLetters([L('in', 2, '嗨'), L('out', 1, '你好'), L('out', 3, '在忙啥')], 'v-1')
    expect(t.map(x => x.round)).toEqual([1, 2, 3])
    expect(t[0]!.who).toBe('me'); expect(t[1]!.who).toBe('peer')
  })

  it('只认自己这次串门的 id;普通信件和别的串门都不混进来', () => {
    const t = transcriptFromLetters([
      L('out', 1, 'a'), L('in', 1, '别的串门', 'v-2'),
      { direction: 'in' as const, kind: 'letter', payload: null },
    ], 'v-1')
    expect(t).toHaveLength(1)
  })

  it('同一轮重复投递只留一份', () => {
    const t = transcriptFromLetters([L('in', 2, '嗨'), L('in', 2, '嗨')], 'v-1')
    expect(t).toHaveLength(1)
  })
})

describe('prompts', () => {
  const persona = { myName: '小满', persona: '好奇,话不多', ownerOverview: '主人在做一个微信 AI 助手', disclosurePolicy: '可以说城市和职业方向;不说住址和收入' }

  it('披露底线原文一定在 prompt 里(这是底线,不是可选项)', () => {
    const p = buildVisitReplyPrompt({ ...persona, transcript: [], round: 1, max: 6, opening: true })
    expect(p).toContain('不说住址和收入')
    expect(p).toContain('底线')
  })

  it('开场 / 中段 / 收尾三种指令不同', () => {
    const base = { ...persona, transcript: [{ who: 'peer' as const, round: 1, text: '嗨' }], max: 6 }
    expect(buildVisitReplyPrompt({ ...base, round: 1, opening: true })).toContain('第一句')
    expect(buildVisitReplyPrompt({ ...base, round: 3, opening: false })).toContain('接着聊')
    expect(buildVisitReplyPrompt({ ...base, round: 6, opening: false })).toContain('最后一句')
  })

  it('明确禁止替主人做决定 —— MoltMatch 那两起事故就是 agent 越了这条', () => {
    const p = buildVisitReplyPrompt({ ...persona, transcript: [], round: 1, max: 6, opening: true })
    expect(p).toContain('不替主人做任何决定')
  })

  it('persona 为空(白纸养成初期)时 prompt 仍成立,不出现空段', () => {
    const p = buildVisitReplyPrompt({ ...persona, persona: null, ownerOverview: null, transcript: [], round: 1, max: 6, opening: true })
    expect(p).not.toContain('【你是什么样的】')
    expect(p).toContain('小满')
  })

  it('叙述 prompt 要求第一人称、讲具体的事、不汇报', () => {
    const p = buildVisitNarrationPrompt({ ...persona, peerLabel: '第 1 度的某人', transcript: [{ who: 'me', round: 1, text: 'a' }] })
    expect(p).toContain('第一人称')
    expect(p).toContain('别汇报')
  })
})

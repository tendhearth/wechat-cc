/**
 * 「陪伴候选」贡献点(A5)的对照:登记表的顺序,以及各候选自己交的档位规则与 core 的 computeCandidates 逐条一致 ——
 * 搬家前引擎调的就是 computeCandidates,两边对不上就是主人每天收到的东西变了。
 */
import { describe, it, expect } from 'vitest'
import { computeCandidates, type CareLevel, type SpeakGate } from '../../domain/companion-plan'
import { companionActions, introspectSteps, type TickDeps } from './tick-bodies'
import type { TickDispatch } from './tick-dispatch'
import type { CompanionTickCtx } from '../companion/contributions'

const fakeDeps = (socialWired: boolean) => ({ boot: socialWired ? { social: { penpal: {} } } : {} }) as unknown as TickDeps
const fakeDispatch = {} as TickDispatch

describe('陪伴候选登记表', () => {
  it('推送候选按打猎 → 串门 → 问候登记;只有串门不靠微信送', () => {
    const actions = companionActions(fakeDeps(true), fakeDispatch)
    expect(actions.map(a => a.id)).toEqual(['hunt', 'visit', 'gap'])
    expect(actions.map(a => a.needsWechat)).toEqual([true, false, true])
  })
  it('自省的几步按贴纸 → 小像 → 记忆园丁 → 画室登记,失败日志的 tag 同搬家前', () => {
    const steps = introspectSteps(fakeDeps(false))
    expect(steps.map(s => s.id)).toEqual(['sticker-artist', 'portrait-artist', 'memory-garden', 'atelier'])
    expect(steps.map(s => `${s.logTag} ${s.failLabel}`)).toEqual(['STICKERS artist step', 'PORTRAIT artist step', 'GARDEN tick', 'ATELIER tick'])
  })
  it('各候选交的档位与 computeCandidates 逐条一致(主人 / 非主人 × care 档 × 打猎 / 串门开关 × 社交接没接)', () => {
    const ledger = { noReplyCount: 0 }
    const nowIso = '2026-10-25T10:00:00.000Z'
    for (const isOwnerChat of [true, false])
      for (const level of ['low', 'high', 'off'] as CareLevel[])
        for (const hunt of [undefined, true, false])
          for (const visit of [undefined, true, false])
            for (const socialWired of [true, false]) {
              const prefs = { hunt, visit }
              const asked: Array<[string, CareLevel]> = []
              const decide: SpeakGate = ({ kind, level: lv }) => { asked.push([kind, lv]); return { ok: true } }
              computeCandidates({ isOwnerChat, level, prefs, socialWired, nowIso, ledger }, decide)
              const ctx: CompanionTickCtx = { chatId: 'c', isOwnerChat, nowIso, level, prefs, ledger }
              const mine = companionActions(fakeDeps(socialWired), fakeDispatch)
                .map(a => [a.id, a.speakLevel(ctx)] as [string, CareLevel | null])
                .filter((x): x is [string, CareLevel] => x[1] !== null)
              expect(mine, JSON.stringify({ isOwnerChat, level, hunt, visit, socialWired })).toEqual(asked)
            }
  })
})

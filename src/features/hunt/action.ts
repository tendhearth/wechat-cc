/**
 * 打猎这个「陪伴候选」(ports/companion-contributions.ts 的 CompanionAction)。从
 * wiring/companion-actions.ts 原样搬来:档位规则、包袱水位、旁听入库、busy token、先登记再出门,逐字一致。登记在
 * daemon/wiring/tick-bodies.ts 的候选表里,顺序就是候选与回退的顺序(打猎 → 串门 → 问候)。
 *
 * 提示文字 `buildHuntText` 在陪伴功能的 tick-texts.ts:它和推送 / 问候 / 定时那几份共用同一套口吻常量和同一组对照测试。
 */
import type { CompanionAction } from '../../ports/companion-contributions'
import { buildHuntText, type TickDeps, type TickDispatch } from '../companion'
import type { PlanContext } from '../../domain/companion-plan'
import { PLAN_JOURNAL_ITEMS } from '../../domain/companion-plan'
import { readJournalSeen } from '../../adapters/store/journal-seen'
function errMsg(err: unknown): string { return err instanceof Error ? err.message : String(err) }

/** 打猎这一拍要的:那一拍的公共依赖里挑出来的几样。 */
export type HuntActionDeps = Pick<TickDeps, 'stateDir' | 'boot' | 'careLedger' | 'outboundTaps' | 'journal' | 'log'>

/** 打猎:只有主人那个聊天会成为候选;默认关,明确开了(hunt:true)才算(主人 10-21 定)。 */
export function huntAction(deps: HuntActionDeps, { dispatchToChat }: Pick<TickDispatch, 'dispatchToChat'>): CompanionAction {
  return {
    id: 'hunt',
    needsWechat: true,
    speakLevel: (c) => !c.isOwnerChat ? null : (c.level === 'off' ? 'off' : (c.prefs.hunt === true ? 'low' : 'off')),
    // 包袱(打猎战利品)里堆了什么:堆着没看就别再往里塞。读不出来 = 没接线,不掀翻判断。
    planInfo: () => {
      let journal: PlanContext['journal'] = null
      try {
        if (deps.journal?.summary && deps.journal.list) {
          const sum = deps.journal.summary(readJournalSeen(deps.stateDir))
          journal = { unread: sum.unread, latest: deps.journal.list(PLAN_JOURNAL_ITEMS).map(x => ({ kind: x.kind, title: x.title, ts: x.ts })) }
        }
      } catch { journal = null }
      return { context: { journal } }
    },
    async run({ chatId, nowIso, prefs }) {
      // 旁听这一拍发出去的东西 —— 打猎的产出此前只存在于微信聊天记录里,
      // 主人想回头找上周那条链接只能翻聊天。记的是**真发出去的文本**,
      // 不是要求模型额外调一个登记工具(漏调一次就少一条,且无人知晓)。
      const tap = deps.outboundTaps?.tap(chatId)
      // busy token(spec 2026-09-03-companion-presence §2.2):调度器持的是
      // companion-push(每拍都有,桌宠推导会忽略);打猎要有自己的名字,
      // 桌宠才知道这一拍是「出门觅食」而不是例行公事。silent-safe:
      // 测试夹具的 boot 没有 holdBusy。
      let releaseHunt: (() => void) | undefined
      try { releaseHunt = (deps.boot as { holdBusy?: (l: string) => () => void }).holdBusy?.('hunt') } catch { releaseHunt = undefined }
      try {
        return await dispatchToChat(chatId, {
          claim: () => { const ticket = deps.careLedger.claimHunt(chatId, nowIso); return () => deps.careLedger.unclaim(chatId, ticket) },
          buildText: (style) => buildHuntText({ nowIso, avoid: prefs.avoid }, style),
        })
      } finally {
        try { releaseHunt?.() } catch { /* release 永不抛 */ }
        const shared = tap?.close() ?? []
        if (shared.length > 0 && deps.journal) {
          // 记录失败绝不能让这一拍看起来失败 —— 消息已经发出去了。
          try {
            const n = deps.journal.recordHunt({ chatId, text: shared.join('\n\n'), nowIso })
            deps.log('HUNT', `chat=${chatId} 入库 ${n} 条`)
          } catch (err) { deps.log('HUNT', `入库失败(消息已发出): ${errMsg(err)}`) }
        }
      }
    },
  }
}

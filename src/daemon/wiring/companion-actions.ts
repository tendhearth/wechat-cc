/**
 * 主动找主人那一拍的三个内置候选(从 tick-push.ts 原样搬出,A5「陪伴候选」贡献点):打猎、串门、问候。
 * 档位规则与 core/companion-plan 的 computeCandidates 逐条一致(companion-actions.test 对照);执行的内容与搬家前逐字一致
 * (旁听入库、busy token、先登记再出门、daysSinceContact 的算法)。登记在 tick-bodies.ts,顺序就是候选与回退的顺序。
 */
import type { CompanionAction } from '../companion/contributions'
import type { PlanContext } from '../../core/companion-plan'
import { PLAN_JOURNAL_ITEMS } from '../../core/companion-plan'
import { readJournalSeen } from '../../core/journal-seen'
import { NETWORK_UNPROTECTED_REASON } from '../../lib/network-gate'
import type { TickDeps } from './tick-deps'
import type { TickDispatch } from './tick-dispatch'
import { buildGapCheckinText, buildHuntText } from './tick-texts'
function errMsg(err: unknown): string { return err instanceof Error ? err.message : String(err) }

/** 打猎:只有主人那个聊天会成为候选;默认关,明确开了(hunt:true)才算(主人 10-21 定)。 */
export function huntAction(deps: TickDeps, { dispatchToChat }: TickDispatch): CompanionAction {
  return {
    id: 'hunt',
    needsWechat: true,
    speakLevel: (c) => !c.isOwnerChat ? null : (c.level === 'off' ? 'off' : (c.prefs.hunt === true ? 'low' : 'off')),
    // 包袱(打猎战利品)里堆了什么:堆着没看就别再往里塞。读不出来 = 没接线,不掀翻判断。
    planInfo: () => {
      let journal: PlanContext['journal'] = null
      try {
        if (deps.huntStore?.summary && deps.huntStore.list) {
          const sum = deps.huntStore.summary(readJournalSeen(deps.stateDir))
          journal = { unread: sum.unread, latest: deps.huntStore.list(PLAN_JOURNAL_ITEMS).map(x => ({ kind: x.kind, title: x.title, ts: x.ts })) }
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
        if (shared.length > 0 && deps.huntStore) {
          // 记录失败绝不能让这一拍看起来失败 —— 消息已经发出去了。
          try {
            const n = deps.huntStore.recordHunt({ chatId, text: shared.join('\n\n'), nowIso })
            deps.log('HUNT', `chat=${chatId} 入库 ${n} 条`)
          } catch (err) { deps.log('HUNT', `入库失败(消息已发出): ${errMsg(err)}`) }
        }
      }
    },
  }
}

/**
 * 串门(2026-09-03,core/visit.ts):伙伴自己的社交,一天一次。只有主人那个聊天、社交接上了才是候选。
 *
 * 不走 dispatchToChat:串门不是一次 agent turn(不带工具、不进会话),它有自己的 eval 链;这里只做登记 + 出门。
 * `target` 是模型从 provenChannels 里挑的信道 id;没挑就还是 startVisit() 自己挑。
 */
export function visitAction(deps: TickDeps): CompanionAction {
  const socialWired = () => !!deps.boot.social?.penpal
  return {
    id: 'visit',
    needsWechat: false,
    speakLevel: (c) => !c.isOwnerChat || !socialWired() ? null : (c.level === 'off' ? 'off' : (c.prefs.visit !== false ? 'low' : 'off')),
    planInfo: () => {
      // `provenChannels?.()` 的可选调用是有用的:老的 penpal 接线和测试夹具
      // 没有这个方法。整段再包一层 try —— 挑串门目标失败绝不能掀翻这一拍。
      let proven: Array<{ id: string; label: string }> = []
      try { proven = socialWired() ? (deps.boot.social!.penpal.provenChannels?.() ?? []) : [] } catch { proven = [] }
      // 一格一个 try:某个子服务抛了,不该把另外两格也抹成「没接线」。
      let social: PlanContext['social'] = null
      const so = deps.boot.social
      if (so) {
        let openWishes = 0
        try { openWishes = so.wish.list().filter(w => w.effective === 'open').length } catch { openWishes = 0 }
        let pendingOffers = 0
        try { pendingOffers = so.intro.offers().length } catch { pendingOffers = 0 }
        social = { openWishes, pendingOffers, provenChannels: proven }
      }
      return { targets: proven, context: { social } }
    },
    async run({ chatId, nowIso }, target) {
      const visit = deps.boot.social?.penpal
      if (!visit) return false
      // 先登记再出门(at-most-once,同打猎):出门一半 daemon 重启,不该
      // 下一拍再出一次门 —— 两趟串门比一趟没出门的观感差得多。
      // 总有地方可去:没有真信道就去邻居家(core/neighbors.ts)。
      const ticket = deps.careLedger.claimVisit(chatId, nowIso)
      const r = target === undefined ? await visit.startVisit() : await visit.startVisit(target)
      // 评审 #193 P2-3:开场那句的模型调用被网络守护拒了 —— 没出门,这趟不算。只撤这一次登记
      // (第二轮 #194):期间主人来信清零、别的登记都留着。
      if (!r.ok && r.reason === NETWORK_UNPROTECTED_REASON) {
        deps.careLedger.unclaim(chatId, ticket)
        return 'refused'
      }
      deps.log('VISIT', r.ok ? `tick: 出门了 visit=${r.id} → ${r.channel}` : `tick: 没出得了门 reason=${r.reason}`)
      return r.ok
    },
  }
}

/** 问候:安静够久了(按 care 档)、没有具体由头的一句。每个 care 开着的对话都可能是候选。 */
export function gapAction(deps: TickDeps, { dispatchToChat }: TickDispatch): CompanionAction {
  return {
    id: 'gap',
    needsWechat: true,
    speakLevel: (c) => c.level,
    async run({ chatId, nowIso, prefs, lastInboundAtIso }) {
      const daysSinceContact = lastInboundAtIso !== undefined
        ? Math.floor((Date.parse(nowIso) - Date.parse(lastInboundAtIso)) / 86_400_000)
        : 0
      return await dispatchToChat(chatId, {
        claim: () => { const ticket = deps.careLedger.claim(chatId, nowIso); return () => deps.careLedger.unclaim(chatId, ticket) },
        buildText: (style) => buildGapCheckinText({ nowIso, chatId, daysSinceContact, avoid: prefs.avoid }, style),
      })
    },
  }
}

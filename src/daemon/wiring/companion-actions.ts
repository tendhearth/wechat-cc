/**
 * 主动找主人那一拍的候选里,还在组装这一层的那一个:串门(从 tick-push.ts 原样搬出,A5「陪伴候选」贡献点)。
 * 打猎在 src/features/hunt,问候跟着陪伴引擎进了 src/features/companion(gap-action.ts)。串门读的是 bootstrap 里的社交
 * (`boot.social.penpal`),等社交把它交成自己的候选再挪过去。
 * 档位规则与 domain/companion-plan 的 computeCandidates 逐条一致(companion-actions.test 对照);执行的内容与搬家前逐字一致
 * (先登记再出门、网络守护拒了只撤这一次登记)。登记在 tick-bodies.ts,顺序就是候选与回退的顺序。
 */
import type { CompanionAction, TickDeps } from '../../features/companion'
import type { PlanContext } from '../../domain/companion-plan'
import { NETWORK_UNPROTECTED_REASON } from '../../lib/network-gate'

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

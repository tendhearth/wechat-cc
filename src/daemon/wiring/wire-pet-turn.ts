/**
 * 桌宠的「在做什么」(重构第二批步 6c,从 pipeline-deps.ts 搬出来)。推导本身是 core/pet-turn.ts 的纯函数;
 * 这里只把 daemon 里已经存在的信号收齐。
 */
import { derivePetTurn } from '../../core/pet-turn'
import type { PetTurnDep } from '../internal-api/types'
import type { IlinkAdapter } from '../ilink-glue'
import type { Bootstrap } from '../bootstrap'
import type { PetSignals } from '../pet-signals'
import type { makeMessagesStore } from '../../lib/messages-store'
import { loadCompanionConfig } from '../companion/config'
import { resolveOwnerSessionKey } from './owner-session-key'

export interface WirePetTurnDeps {
  stateDir: string
  ilink: Pick<IlinkAdapter, 'listPendingPermissions'>
  petSignals?: PetSignals
  boot: Pick<Bootstrap, 'resolve' | 'coordinator' | 'sessionManager' | 'defaultProviderId'>
  messagesStore: Pick<ReturnType<typeof makeMessagesStore>, 'latestInboundTs'>
}

export function wirePetTurn(d: WirePetTurnDeps): PetTurnDep {
  const { stateDir, boot, messagesStore } = d
  // 桌宠的「在做什么」(spec 2026-09-05-cc-desktop-pet §5.1)。推导本身是
  // core/pet-turn.ts 的纯函数;这里只负责把 daemon 里**已经存在**的信号收齐:
  // 主人是谁(companion 配置,与 converse 同源)、他的会话在不在飞
  // (sessionManager.isInFlight,与 converse 的前置守卫同一个判断)、
  // pet-signals 的三个内存时间戳、待决权限(与微信「y/n」同一份清单)。
  const petTurn: PetTurnDep = async () => {
    const nowMs = Date.now()
    let ownerChatId: string | null = null
    try { ownerChatId = loadCompanionConfig(stateDir).default_chat_id ?? null } catch { ownerChatId = null }
    if (!ownerChatId) {
      // 还没配主人:没有会话可看,也没有「谁能拍板」可言 —— 待决权限一律不外
      // 泄(见下面的过滤)。但「主人联系过我」这一笔是全局的(converse / 权限
      // 拍板都会写),照样如实报出去。
      return derivePetTurn({
        nowMs, inFlight: false, inFlightSinceMs: null, lastToolCallAtMs: null, lastResultAtMs: null,
        ownerLastContactAtMs: d.petSignals?.snapshot('').lastContactMs ?? null,
        pending: [],
      })
    }
    // 只报**主人自己那些**待决权限。这张表是全 daemon 共享的:任何一个陌生人
    // 的会话触发的权限询问也在里面,而 hash 一旦露出去就等于一张批准券
    // (微信侧那条「y <hash>」)。桌宠是主人的面,只该看见主人自己的队列。
    const pending = d.ilink.listPendingPermissions().filter(p => p.chatId === ownerChatId)
    const key = resolveOwnerSessionKey(ownerChatId, {
      resolveProject: boot.resolve,
      getMode: (cid) => boot.coordinator.getMode(cid),
      defaultProviderId: boot.defaultProviderId,
    })
    const sessionInFlight = !!key && boot.sessionManager.isInFlight({ alias: key.alias, providerId: key.providerId, chatId: ownerChatId })
    const sig = d.petSignals?.snapshot(ownerChatId) ?? { inFlightSinceMs: null, lastToolCallAtMs: null, lastResultAtMs: null, lastContactMs: null }
    // 两个条件都要:会话在飞(独立事实源)**且**这一趟是从入站/converse 进来的。
    // 关心推送、打猎、提醒这些**自己发起**的 tick 轮次也会把 isInFlight 抬起来,
    // 但它们不是「主人问了、我在想」—— 那属于「处境」(presence 那条线),不属于
    // 桌宠的 turn 相位。没有起飞标记就没有 since 可报,硬报也只能报个 null。
    const inFlight = sessionInFlight && sig.inFlightSinceMs !== null
    // 「主人上次联系我」取两边的**较晚者**:消息库只记微信入站,pet-signals 只记
    // app converse / 权限拍板。任何一边单独看都会把另一边的活动说成「没来过」。
    const inboundIso = await messagesStore.latestInboundTs(ownerChatId).catch(() => null)
    const inboundMs = inboundIso ? Date.parse(inboundIso) : NaN
    const contact = Math.max(Number.isFinite(inboundMs) ? inboundMs : -1, sig.lastContactMs ?? -1)
    return derivePetTurn({
      nowMs,
      inFlight,
      inFlightSinceMs: sig.inFlightSinceMs,
      lastToolCallAtMs: sig.lastToolCallAtMs,
      lastResultAtMs: sig.lastResultAtMs,
      ownerLastContactAtMs: contact >= 0 ? contact : null,
      pending,
    })
  }
  return petTurn
}

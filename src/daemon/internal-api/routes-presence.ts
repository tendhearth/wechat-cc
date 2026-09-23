/**
 * routes-presence.ts — 桌宠状态(spec 2026-09-03-companion-presence §2.4)。
 *
 * 一个 GET 把三轴一起吐出来:在不在 / 在干什么 / 带了什么回来。推导在
 * core/companion-presence.ts(纯函数),这里只负责从 deps 收集输入。
 * 微信侧以后主人问「你在干嘛」也走同一个函数 —— 两个界面一个事实。
 *
 * 分级 trusted:桌面拿的是 FILE token(= trusted)。admin 会让桌面 403 ——
 * 觅食台 2026-07-22 就是这么静默坏了一个月。
 */
import { derivePresence } from '../../core/companion-presence'
import type { Presence } from '../../core/companion-presence'
import { readJournalSeen } from '../../core/journal-seen'
import { loadCompanionConfig } from '../companion/config'
import type { InternalApiDeps, RouteTable } from './types'

/**
 * 三轴的唯一组装点。路由和随身 CC 手机页(经 lifecycle.getPresence)都调它
 * —— 两个界面一个事实(spec 2026-09-06-mobile-home-feed §5.2)。
 * 返回 null = journal 没接(路由据此 503,手机页据此显示「不知道」)。
 */
export async function computePresence(deps: InternalApiDeps): Promise<Presence | null> {
  if (!deps.hunt) return null
  let ownerChatId: string | null = null
  try { ownerChatId = loadCompanionConfig(deps.stateDir).default_chat_id } catch { ownerChatId = null }
  // 「在聊」看的是**入站**时间,不是会话的 lastUsedAt —— 打猎 / 关心推送 /
  // 提醒这些伙伴自己的外发也会 bump lastUsedAt,拿它当证据熊就会在主人
  // 一言未发时说「在跟你聊」(spec 2026-09-03 §2.1)。没接 latestInboundTs
  // 就一律当 null:没有入站证据,就不算在聊。
  const sessions = await Promise.all((deps.listSessions?.() ?? []).map(async s => {
    let iso: string | null = null
    try { iso = (await deps.latestInboundTs?.(s.chatId)) ?? null } catch { iso = null }
    const ms = iso ? Date.parse(iso) : NaN
    return { chatId: s.chatId, lastInboundAt: Number.isFinite(ms) ? ms : null }
  }))
  return derivePresence({
    nowMs: Date.now(),
    ownerChatId,
    sessions,
    busyLabels: deps.busyLabels?.() ?? [],
    visit: deps.social?.penpal?.activeVisit?.() ?? null,
    outbound: deps.outbound?.().state ?? null,
    subsystemsDegraded: (deps.subsystems?.() ?? []).filter(s => s.state === 'degraded').length,
    journal: deps.hunt.summary(readJournalSeen(deps.stateDir)),
  })
}

export function presenceRoutes(deps: InternalApiDeps): RouteTable {
  return {
    'GET /v1/companion/presence': async () => {
      const body = await computePresence(deps)
      if (!body) return { status: 503, body: { error: 'journal_not_wired' } }
      return { status: 200, body }
    },
  }
}

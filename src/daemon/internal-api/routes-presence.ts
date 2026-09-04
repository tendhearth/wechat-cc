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
import { readJournalSeen } from '../../core/journal-seen'
import { loadCompanionConfig } from '../companion/config'
import type { InternalApiDeps, RouteTable } from './types'

export function presenceRoutes(deps: InternalApiDeps): RouteTable {
  return {
    'GET /v1/companion/presence': async () => {
      if (!deps.hunt) return { status: 503, body: { error: 'journal_not_wired' } }
      let ownerChatId: string | null = null
      try { ownerChatId = loadCompanionConfig(deps.stateDir).default_chat_id } catch { ownerChatId = null }
      const body = derivePresence({
        nowMs: Date.now(),
        ownerChatId,
        sessions: (deps.listSessions?.() ?? []).map(s => ({ chatId: s.chatId, lastUsedAt: s.lastUsedAt })),
        busyLabels: deps.busyLabels?.() ?? [],
        visit: deps.social?.penpal?.activeVisit?.() ?? null,
        outbound: deps.outbound?.().state ?? null,
        subsystemsDegraded: (deps.subsystems?.() ?? []).filter(s => s.state === 'degraded').length,
        journal: deps.hunt.summary(readJournalSeen(deps.stateDir)),
      })
      return { status: 200, body }
    },
  }
}

/**
 * internal-api social routes —— 社交关着也要能用的那几条:关系视图、社交总开关、入站开关。
 * 串门 / 心愿 / 介绍 / 笔友信箱(路由表标了 `module: 'social'`)归社交模块自己挂(src/features/social/routes.ts,
 * 架构终态 A5);这里不再碰社交的接线,关系视图只经 `socialView` 那个窄口读信道。
 */
import { loadAgentConfig, saveAgentConfig } from '../../lib/agent-config'
import type { InternalApiDeps, RouteTable } from './types'
import { applySocialSwitch } from '../../cli/social-enable'
import { buildRelationships, type RelationshipInputs } from '../../core/relationships'
import { NEIGHBORS } from '../../domain/neighbors'
import { readNeighborMemory } from '../companion/neighbor-memory'
import { makeMessagesStore } from '../../lib/messages-store'
import { makeConversationStore } from '../../adapters/store/conversation-store'
import { loadAccess } from '../../lib/access'
import { loadCompanionConfig } from '../../lib/companion-config'
import { resolveEffectiveTier } from '../../domain/user-tier'
import { readJsonFile } from '../../lib/read-json-file'
import { join } from 'node:path'

export function socialRoutes(deps: InternalApiDeps): RouteTable {
  return {
    // 关系视图(架构重构 §2.2):四种对方,一张表。派生,不落表。
    // trusted:桌面端的凭证是 FILE token(=trusted)。
    'GET /v1/social/relationships': async () => {
      const penpal = deps.socialView
      const channels = penpal ? penpal.channelStore.list() : []
      const visitsByChannel: Record<string, { ids: number; lastAt: string | null; peerReplied: boolean }> = {}
      if (penpal) {
        for (const ch of channels) {
          const rows = penpal.letterStore.listForChannel(ch.id).filter(l => l.kind === 'visit')
          const ids = new Set<string>()
          let lastAt: string | null = null
          for (const r of rows) {
            try { ids.add(String((JSON.parse(r.payload ?? '{}') as { id?: string }).id ?? '')) } catch { /* 坏 payload 不计 */ }
            if (!lastAt || r.created_at > lastAt) lastAt = r.created_at
          }
          ids.delete('')
          visitsByChannel[ch.id] = { ids: ids.size, lastAt, peerReplied: rows.some(r => r.direction === 'in') }
        }
      }
      const peers = (deps.a2a?.registry.list() ?? [])
        .filter(a => !(a.capabilities ?? []).includes('exec'))   // 手是设备,不是关系
        .map(a => ({ id: a.id, name: a.name, transport: a.transport ?? 'push', paused: a.paused === true }))
      const humans: Array<RelationshipInputs['humans'][number]> = []
      if (deps.db) {
        const ms = makeMessagesStore(deps.db)
        const conv = makeConversationStore(deps.db)
        const access = loadAccess()
        const owner = loadCompanionConfig(deps.stateDir).default_chat_id
        let guestState: { visits?: Record<string, number> } = {}
        try { guestState = readJsonFile(join(deps.stateDir, 'companion', 'guest-visits.json')) } catch { /* 还没人来过 */ }
        for (const chatId of await ms.listChatIds()) {
          if (chatId === owner) continue
          // permissionMode 挂在 prefix deps 上(它是唯一带这个字段的地方);没接时按 strict。
          if (resolveEffectiveTier(chatId, access, deps.prefix?.permissionMode ?? 'strict') === 'admin') continue
          const lastAt = await ms.latestInboundTs(chatId)
          if (!lastAt) continue
          humans.push({ chatId, name: conv.getIdentity(chatId)?.last_user_name ?? null, visits: guestState.visits?.[chatId] ?? 0, lastAt })
        }
      }
      const relationships = buildRelationships({
        peers, channels, visitsByChannel,
        neighbors: NEIGHBORS.map(n => ({ id: n.id, name: n.name })),
        neighborMemory: readNeighborMemory(deps.stateDir),
        humans,
      })
      return { status: 200, body: { relationships } }
    },

    // 觅食台 P2 Task 3 — inbound on/off toggle over a2a_listen, replacing the
    // "hand-edit agent-config.json" instruction. restart_required: true
    // because the A2A server binds a2a_listen at boot (bootstrap/index.ts);
    // live rebind is out of scope for this pass.
    'GET /v1/social/inbound': async () => {
      const l = loadAgentConfig(deps.stateDir).a2a_listen
      return { status: 200, body: l ? { enabled: true, host: l.host, port: l.port } : { enabled: false } }
    },
    // 社交总开关。**刻意不依赖社交模块** —— 社交没开时模块根本没起,
    // 而"没开"恰恰是唯一需要这条路由的时候。它只读写 agent-config.json,与
    // `wechat-cc social enable` 共用 applySocialSwitch 那一份逻辑。
    //
    // 为什么需要它:此前桌面端三处入口(配对面板、笔友信箱、寄信)在社交未
    // 启用时只会说「先在命令行运行 wechat-cc social enable」—— 一个桌面产品
    // 把人踢回终端。被朋友拉来试用的人基本必然卡死在这一步。
    'POST /v1/social/enable': async (_q, body) => {
      const enabled = !!((body ?? {}) as { enabled?: unknown }).enabled
      const r = applySocialSwitch(deps.stateDir, enabled)
      // 配对引擎/社交接线都在 boot 时完成,所以两个方向都要重启才生效。
      return { status: 200, body: { ...r, restart_required: true } }
    },
    'POST /v1/social/inbound': async (_q, body) => {
      // `body` is null on an empty/`null` request body (readJsonBody) — guard
      // it (as the sibling inline-validated POST routes do) so a missing body
      // reads as `enabled:false` instead of throwing a 500.
      const enabled = !!((body ?? {}) as { enabled?: unknown }).enabled
      const cfg = loadAgentConfig(deps.stateDir)
      const updated = enabled
        ? { ...cfg, a2a_listen: { host: '127.0.0.1', port: 8717 } }
        : (() => { const { a2a_listen, ...rest } = cfg; return rest })()
      saveAgentConfig(deps.stateDir, updated)
      return { status: 200, body: { enabled, restart_required: true } }
    },
  }
}

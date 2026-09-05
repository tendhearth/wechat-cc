/**
 * internal-api social routes — 笔友信道 / 关系 / 心愿. Mirrors routes-a2a.ts's
 * `/v1/a2a/send` shape: 503 when social wiring is absent (social_enabled +
 * social_disclosure_policy not both configured), else delegate straight to it.
 * Split into its own file (rather than appended to routes-a2a.ts) since the
 * social surface is a distinct capability/trust surface from the bare a2a
 * exec/notify/pair routes.
 *
 * 心愿 (spec 2026-09-04-wish-postcard §4) replaced the P4 propose→confirm/
 * cancel seek/seeks/echoes/pledges/*reveal routes with four wish routes:
 * propose gates + stashes a draft WITHOUT sending; send broadcasts the
 * stored redacted wording verbatim to every open channel; cancel voids a
 * draft/open row; the GET list gives the redacted text + effective status
 * (never the raw text or a stale `open` past expiry).
 */
import { loadAgentConfig, saveAgentConfig } from '../../lib/agent-config'
import type { InternalApiDeps, RouteTable } from './types'
import type { PostcardRef } from '../../core/wish'
import { applySocialSwitch } from '../../cli/social-enable'
import { buildRelationships, type RelationshipInputs } from '../../core/relationships'
import { NEIGHBORS } from '../../core/neighbors'
import { readNeighborMemory } from '../companion/neighbor-memory'
import { makeMessagesStore } from '../../lib/messages-store'
import { makeConversationStore } from '../../core/conversation-store'
import { loadAccess } from '../../lib/access'
import { loadCompanionConfig } from '../companion/config'
import { resolveEffectiveTier } from '../../core/user-tier'
import { isIntroClaimLive } from '../../core/intro'
import { readJsonFile } from '../../lib/read-json-file'
import { join } from 'node:path'

export function socialRoutes(deps: InternalApiDeps): RouteTable {
  return {
    // 串门(桌面「认识的人」里的按钮)。整趟要跑两三分钟(6-7 次模型调用),
    // 不等 —— 起跑就回,结果经微信 + 日志(journal)到主人手里。
    'POST /v1/social/visit': async (_q, body) => {
      const penpal = deps.social?.penpal
      if (!penpal?.startVisit) return { status: 503, body: { error: 'social_not_wired' } }
      const target = ((body ?? {}) as { target?: unknown }).target
      if (target !== undefined && (typeof target !== 'string' || target === '')) return { status: 400, body: { error: 'bad_target' } }
      void penpal.startVisit!(target as string | undefined).catch(() => { /* 失败已在 wire-visit 记日志 */ })
      return { status: 200, body: { ok: true, started: true } }
    },

    // 关系视图(架构重构 §2.2):四种对方,一张表。派生,不落表。
    // trusted:桌面端的凭证是 FILE token(=trusted)。
    'GET /v1/social/relationships': async () => {
      const penpal = deps.social?.penpal
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

    // 心愿(spec 2026-09-04-wish-postcard §4)。propose 只存草稿 —— 发出必须是主人的动作。
    'POST /v1/social/wish': async (_q, body) => {
      if (!deps.social?.wish) return { status: 503, body: { error: 'social_not_wired' } }
      const text = ((body ?? {}) as { text?: unknown }).text
      if (typeof text !== 'string' || text.trim() === '') return { status: 400, body: { error: 'missing_text' } }
      return { status: 200, body: await deps.social.wish.propose(text.trim()) }
    },
    'POST /v1/social/wish/send': async (_q, body) => {
      if (!deps.social?.wish) return { status: 503, body: { error: 'social_not_wired' } }
      const id = ((body ?? {}) as { id?: unknown }).id
      if (typeof id !== 'string' || id === '') return { status: 400, body: { error: 'missing_id' } }
      const r = await deps.social.wish.send(id)
      return { status: 200, body: r.ok ? { ok: true, sent_to: r.sentTo } : r }
    },
    'POST /v1/social/wish/cancel': async (_q, body) => {
      if (!deps.social?.wish) return { status: 503, body: { error: 'social_not_wired' } }
      const id = ((body ?? {}) as { id?: unknown }).id
      if (typeof id !== 'string' || id === '') return { status: 400, body: { error: 'missing_id' } }
      return { status: 200, body: deps.social.wish.cancel(id) }
    },
    'GET /v1/social/wishes': async () => {
      if (!deps.social?.wish) return { status: 503, body: { error: 'social_not_wired' } }
      return {
        status: 200,
        body: {
          wishes: deps.social.wish.list().map(w => {
            const base = { id: w.id, text: w.redacted, status: w.effective, created_at: w.createdAt, expires_at: w.expiresAt, sent_to: w.sentTo, replies: w.replies }
            const postcards = w.postcards as Array<PostcardRef & { viaLabel: string }> | undefined
            // `requested` = 「已在问」这四个字要不要顶掉「想认识 TA」按钮。
            // 光看 myIntro 在不在不行:claim 和介绍人那条 pending 同一把 7 天
            // 尺子(isIntroClaimLive),过了就该重新露出按钮,不然一封丢掉的
            // card 会把这张明信片永远钉死在「已在问」上。
            return postcards
              ? { ...base, postcards: postcards.map(p => ({ reply_id: p.replyId, via_label: p.viaLabel, preview: p.preview, at: p.at, requested: isIntroClaimLive(p.myIntro, Date.now()) })) }
              : base
          }),
        },
      }
    },
    // 介绍(spec 2026-09-04-introduction)。handler 形状照上面的 wish/* 三兄弟:
    // 缺线 → 503;body 里的 reply_id 非空字符串校验 → 400;service 已经把结果
    // 归一成 {ok:true, replyId} | {ok:false, reason},这里只是转成 snake_case。
    'POST /v1/social/intro/request': async (_q, body) => {
      if (!deps.social?.intro) return { status: 503, body: { error: 'social_not_wired' } }
      const replyId = ((body ?? {}) as { reply_id?: unknown }).reply_id
      if (typeof replyId !== 'string' || replyId === '') return { status: 400, body: { error: 'missing_reply_id' } }
      const r = await deps.social.intro.request(replyId)
      return { status: 200, body: r.ok ? { ok: true, reply_id: r.replyId } : r }
    },
    'POST /v1/social/intro/accept': async (_q, body) => {
      if (!deps.social?.intro) return { status: 503, body: { error: 'social_not_wired' } }
      const replyId = ((body ?? {}) as { reply_id?: unknown }).reply_id
      if (typeof replyId !== 'string' || replyId === '') return { status: 400, body: { error: 'missing_reply_id' } }
      const r = await deps.social.intro.accept(replyId)
      return { status: 200, body: r.ok ? { ok: true, reply_id: r.replyId } : r }
    },
    'POST /v1/social/intro/decline': async (_q, body) => {
      if (!deps.social?.intro) return { status: 503, body: { error: 'social_not_wired' } }
      const replyId = ((body ?? {}) as { reply_id?: unknown }).reply_id
      if (typeof replyId !== 'string' || replyId === '') return { status: 400, body: { error: 'missing_reply_id' } }
      const r = await deps.social.intro.decline(replyId)
      return { status: 200, body: r.ok ? { ok: true, reply_id: r.replyId } : r }
    },
    'GET /v1/social/intro/offers': async () => {
      if (!deps.social?.intro) return { status: 503, body: { error: 'social_not_wired' } }
      return { status: 200, body: { offers: deps.social.intro.offers().map(o => ({ reply_id: o.replyId, hint: o.hint, via_label: o.viaLabel, at: o.at })) } }
    },
    // 觅食台 P2 Task 3 — inbound on/off toggle over a2a_listen, replacing the
    // "hand-edit agent-config.json" instruction. restart_required: true
    // because the A2A server binds a2a_listen at boot (bootstrap/index.ts);
    // live rebind is out of scope for this pass.
    'GET /v1/social/inbound': async () => {
      const l = loadAgentConfig(deps.stateDir).a2a_listen
      return { status: 200, body: l ? { enabled: true, host: l.host, port: l.port } : { enabled: false } }
    },
    // 社交总开关。**刻意不依赖 deps.social** —— 社交没开时那个字段根本不存在,
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

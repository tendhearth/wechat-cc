/**
 * wire-instructions.ts — 每个会话系统提示的唯一、provider 无关的组装点
 * (buildInstructions)。从 bootstrap/index.ts 逐字搬出(2026-09-27 bootstrap 拆分,
 * spec 2026-09-27-bootstrap-split-design);块内逻辑与注释不变,只参数化:
 * wire-plugins 的 delegateStdioByProvider / knowledgePluginNames、defaultProviderId、
 * knowledge 走 parts.*;原来的 `let socialToolsWired` 改成 index 持有的 Ref<boolean>
 * (spec §3 规矩 1),social 接线完成后 index set;没 set 就调用是编程错误,直接抛。
 */
import type { ProviderId } from '../../core/conversation'
import type { TierProfile } from '../../core/user-tier'
import { buildSystemPrompt } from '../../core/prompt-builder'
import { capabilitiesFor, replyDeliveryFor, replyTextStrategyFor } from '../../core/capability-matrix'
import type { Ref } from '../../lib/lifecycle'
import type { Bootstrap, BootstrapDeps } from './types'
import type { PluginsSlice } from './wire-plugins'

export function wireInstructions(
  deps: Pick<BootstrapDeps, 'ilink' | 'personaFor' | 'stickerTagsFor' | 'careLevelFor' | 'newRelationshipFor' | 'companionOfferFor' | 'coreMemoryFor' | 'curatedMemoryFor' | 'todayDraftFor' | 'knowledgeMemoryFor' | 'bubbleRepliesFor'>,
  parts: {
    plugins: Pick<PluginsSlice, 'delegateStdioByProvider' | 'knowledgePluginNames'>
    defaultProviderId: ProviderId
    knowledge: Bootstrap['knowledge']
    /** social 接线完成后 index 置位;每次 build 都 deref —— 没 set 就调用是编程错误,直接抛。 */
    socialWired: Ref<boolean>
  },
): Bootstrap['buildInstructions'] {
  // The single, provider-agnostic source of every session's system prompt.
  // SessionManager calls this once per spawn (like mcpEnv) and forwards the
  // result via SpawnContext; each provider injects it through its own
  // transport. peerProviderId + delegateAvailable derive from the provider's
  // ProviderCapabilities.defaultPeer + whether its delegate spec was actually
  // wired (no per-provider ternary — adding a provider needs no edit here).
  // daemonOpsAvailable mirrors the admin predicate the wechat MCP server gates
  // its daemon-control tools on, so the self-heal section appears iff those
  // tools are actually registered for this spawn. careEnabled mirrors
  // `deps.careLevelFor` the same way — absent thunk ⇒ 'off' ⇒ section never
  // included (proactive-care design §7). It also requires memory_write:
  // guests can't author agenda.md entries or call set_chat_pref (both
  // memory_write), so showing the care section would just burn turns on
  // denied tool calls — gap check-ins (guest-allowed `reply`) work fine
  // without it. stickerTags mirrors `deps.stickerTagsFor` the same way for
  // the ABSENT-thunk case (⇒ `null` ⇒ neither sticker section included);
  // its EMPTY-library variant is additionally memory_write-gated (see the
  // `stickerTags` local computed in `buildInstructions` below) since it
  // nudges `save_sticker`, a memory_write-gated write — non-empty behavior
  // is unaffected. persona /
  // personaCultivate mirror `deps.personaFor` the same way — absent thunk
  // ⇒ both persona sections never included (persona design §2).
  // newRelationship mirrors `deps.newRelationshipFor` the same way — absent
  // thunk ⇒ section never included (onboarding-curiosity design §2). Like
  // careEnabled it's also memory_write-gated: the section nudges the agent
  // to jot notes/observations into memory, so a guest-tier owner chat must
  // not get that instruction either. personaEmpty is passed through
  // unconditionally — buildSystemPrompt only surfaces it nested inside the
  // (already tier-gated) persona-cultivation section, so no extra gating
  // is needed here. coreMemory mirrors `deps.coreMemoryFor` the same way —
  // absent thunk ⇒ section never included (core-memory-injection design
  // §2). Unlike personaFor (owner chat via default_chat_id), coreMemoryFor
  // is called with THIS chat's own chatId, so each chat gets its own
  // profile.md excerpt.
  // social-tools (2026-09-05): flipped to true right after `socialWiring`
  // below resolves. A `let` read lazily by buildInstructions — NOT a direct
  // reference to `socialWiring` from inside the closure, which is declared
  // later with `const` and would be a TDZ hazard if any session's prompt
  // were built before social wiring completes.
  return (providerId: ProviderId, tierProfile: TierProfile, chatId: string, model?: string): string => {
    const p = deps.personaFor?.(chatId)
    // owner-onboarding design §C2, fix round 2: the empty-library variant
    // nudges `save_sticker` — a memory_write-gated write, same posture as
    // careEnabled/personaCultivate/newRelationship above (see their
    // comments below) — so it must be suppressed for non-memory_write
    // tiers too. NON-empty sticker behavior is deliberately unchanged
    // (pre-existing, no tier gate there); this only downgrades an EMPTY
    // array to `null` (pref-off shape) when the tier can't call
    // save_sticker anyway.
    const rawStickerTags = deps.stickerTagsFor?.(chatId) ?? null
    const stickerTags = rawStickerTags !== null && rawStickerTags.length === 0 && !tierProfile.allow.has('memory_write')
      ? null
      : rawStickerTags
    // 回复交付(spec 2026-10-03 §4.11):走 daemon 交付的 provider 拿 final_text 版提示(不教 reply 族工具,
    // 教附件 + admin 的 message);legacy / shadow 照旧。message 只在 MCP 真的注册了它时才提(admin + 每会话
    // tier 的 provider —— agy 那种钉死 trusted 的拿不到)。
    const finalText = replyDeliveryFor(providerId) === 'daemon'
    return buildSystemPrompt({
      providerId,
      ...(finalText ? { replyDelivery: 'final_text' as const, replyText: replyTextStrategyFor(providerId), messageToolAvailable: tierProfile.allow.has('message_other') && capabilitiesFor(providerId).adminMcpTools } : {}),
      // 让 bot 知道自己此刻跑的是哪个模型(session-manager 按 spawn 解析后
      // 传进来;claude 的解析见下面 currentModelFor 的 claude 分支)。
      model,
      // Unused when delegateAvailable is false; fall back to the daemon default.
      peerProviderId: capabilitiesFor(providerId).defaultPeer ?? parts.defaultProviderId,
      companionEnabled: deps.ilink.companion.status().enabled,
      delegateAvailable: !!parts.plugins.delegateStdioByProvider[providerId],
      daemonOpsAvailable: tierProfile.allow.has('daemon_introspect'),
      fileLocateAvailable: tierProfile.allow.has('file_locate'),
      // Tracks tool registration exactly, same posture as fileLocateAvailable:
      // `social_act` is ADMIN_ONLY (user-tier.ts), matching wechat-mcp/main.ts's
      // SESSION_IS_ADMIN gate on registerSocialTools; `socialToolsWired` says
      // the daemon's social layer actually came up (otherwise every tool 503s).
      // `adminMcpTools` (ProviderCapabilities) additionally gates out agy: its
      // MCP child's WECHAT_SESSION_TIER is pinned to 'trusted' in a static
      // config (agy-mcp-config.ts), so SESSION_IS_ADMIN is never true there and
      // registerSocialTools never runs — advertising the section anyway would
      // send the model to call tools that don't exist. cursor is per-session now
      // (acp-cursor-chat.ts threads WECHAT_SESSION_TIER through session/new
      // each call), so its adminMcpTools tracks the real tier like claude/codex.
      socialAvailable: parts.socialWired.deref('buildInstructions') && tierProfile.allow.has('social_act') && capabilitiesFor(providerId).adminMcpTools,
      careEnabled: (deps.careLevelFor?.(chatId) ?? 'off') !== 'off' && tierProfile.allow.has('memory_write'),
      // Tri-state (owner-onboarding design §C2) — absent thunk defaults to
      // `null` (pref-off shape), NOT `[]`, so an unwired bootstrap stays
      // byte-identical to before this feature existed (the old `[]` default
      // would now incorrectly render the cold-start unlock variant).
      // memory_write-tier-downgrade computed above (`stickerTags` local).
      stickerTags,
      persona: p?.content,
      // Like careEnabled: cultivation guidance tells the agent to WRITE
      // persona.md via memory_write, so it must also be tier-gated — a
      // guest-tier owner chat would otherwise be prompted to make writes
      // its tier profile denies (burned turns on denied tool calls, and a
      // standing invitation to probe the memory surface).
      personaCultivate: p?.cultivate === true && tierProfile.allow.has('memory_write'),
      newRelationship: (deps.newRelationshipFor?.(chatId) ?? false) && tierProfile.allow.has('memory_write'),
      // companion-offer mirrors `deps.companionOfferFor` the same way —
      // absent thunk ⇒ section never included (owner-onboarding design §C1).
      // Deliberately NO tier gate here (unlike careEnabled/newRelationship,
      // which nudge memory_write-gated writes): `companion_enable` is
      // registered for every session regardless of tier (see
      // wechat/main.ts's registerCompanionTools call — not behind the
      // SESSION_IS_ADMIN block), so there's no denied-tool-call risk. The
      // real thunk (main.ts) delegates to `companionOfferEligible`, which
      // resolves "owner" via `resolveAdminChatId` — admins-membership-based
      // — so a guest chat can NEVER match (even a guest that set
      // `companion.default_chat_id` to itself via the ungated
      // `companion_enable` tool and later disabled it: that stale value is
      // only trusted when it's also in `access.admins` — see
      // companion/resolve-admin.ts). That's what makes skipping a tier gate
      // here structurally safe, not just true "in practice".
      companionOffer: deps.companionOfferFor?.(chatId) ?? false,
      personaEmpty: !(p?.content && p.content.trim().length > 0),
      // core-memory-injection design §2 — this chat's OWN profile.md
      // excerpt (not the owner's). No tier gate: it's a read-only context
      // block, unlike personaCultivate/newRelationship which nudge writes.
      coreMemory: deps.coreMemoryFor?.(chatId),
      // nightly memory tidy design, Task 8 — when present, prompt-builder
      // injects this INSTEAD of coreMemory's profile excerpt.
      curatedMemory: deps.curatedMemoryFor?.(chatId),
      // 同日失忆修复(2026-10-01):今天的草稿,prompt-builder 只在有 curatedMemory 时渲染它。
      todayDraft: deps.todayDraftFor?.(chatId),
      knowledgeMemory: deps.knowledgeMemoryFor?.(chatId),
      // bubbleReplies mirrors `deps.bubbleRepliesFor` the same way — absent
      // thunk ⇒ section never included. Deliberately NO tier gate here
      // (unlike careEnabled/newRelationship/personaCultivate): `reply` is
      // guest-allowed, not memory_write-gated, so there's no denied-tool-call
      // risk in giving a guest chat the same bubbling guidance.
      bubbleReplies: deps.bubbleRepliesFor?.(chatId) ?? false,
      // knowledge-orchestration design Task 2 — daemon-global (loaded once at
      // boot, not per-chat), so this is the captured const, not a `*For`
      // thunk. buildSystemPrompt only surfaces the section when at least one
      // name is a KNOWN_KNOWLEDGE_PLUGINS entry, so this is inert when no
      // knowledge plugin is loaded/enabled.
      knowledgePlugins: parts.plugins.knowledgePluginNames,
      // Agent-facing Search (Task 5) — advertise `knowledge_search` in the
      // prompt ONLY when it will actually work for THIS session:
      //   - `knowledge?.embedQuery` is present iff `knowledge_enabled` AND
      //     an embed script resolved (see the `embedder` construction
      //     above + internal-api/types.ts's doc comment: "`knowledge_enabled`
      //     alone doesn't guarantee an embed script resolved"). Without a
      //     resolved embedder the /v1/knowledge/search route 400s on every
      //     call from the tool (it never receives a pre-embedded
      //     queryVector), so gating on `knowledge_enabled` alone would tell
      //     the agent about a tool that's registered but non-functional.
      //   - `tierProfile.allow.has('knowledge_search')` mirrors
      //     daemonOpsAvailable/fileLocateAvailable above: true only for
      //     admin (user-tier.ts's ADMIN_ONLY), matching exactly the
      //     predicate wechat-mcp/main.ts gates `registerKnowledgeSearchTool`
      //     on (SESSION_IS_ADMIN) — so this flag tracks tool registration
      //     precisely, non-admin/knowledge-off sessions unaffected (both
      //     default away from true).
      knowledgeSearchAvailable: !!parts.knowledge?.embedQuery && tierProfile.allow.has('knowledge_search'),
      // Knowledge Graph inproc (Task 5) — same shape as knowledgeSearchAvailable
      // above, but keyed on `knowledge?.graph` (unconditional whenever
      // knowledge_enabled is on, no embed script required) and the
      // `graph_query` tier kind, which exactly matches the SESSION_IS_ADMIN
      // gate wechat-mcp/main.ts registers `registerGraphTools` under.
      graphAvailable: !!parts.knowledge?.graph && tierProfile.allow.has('graph_query'),
      // Knowledge Facts/Person inproc (Task 5) — same shape as
      // graphAvailable above, keyed on `knowledge?.facts`/`.person`
      // (unconditional whenever knowledge_enabled is on, no embed script
      // required) and the `facts_query`/`person_query` tier kinds, which
      // exactly match the SESSION_IS_ADMIN gate wechat-mcp/main.ts registers
      // `registerFactsTools`/`registerPersonTools` under.
      factsAvailable: !!parts.knowledge?.facts && tierProfile.allow.has('facts_query'),
      personAvailable: !!parts.knowledge?.person && tierProfile.allow.has('person_query'),
    })
  }
}

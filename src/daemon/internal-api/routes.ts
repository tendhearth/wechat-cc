/**
 * Route table for internal-api. Returns the full Record<"METHOD /path", handler>
 * given a deps closure + a `getDelegate` accessor (for late-binding via
 * setDelegate) + a `maybePrefix` helper (kept in index.ts because it
 * captures the same deps closure that auth/dispatch do).
 *
 * Adding a new endpoint = add a row in the appropriate section. The
 * sections are kept in stable order to match the original file's layout
 * so blame survives the split.
 */
import { basename } from 'node:path'
import { errMsg, type InternalApiDeps, type InternalApiDelegateDep, type RouteTable } from './types'
import { splitReply, paceMs } from '../reply-split'
import { lookup } from '../../core/capability-matrix'
import type { Mode } from '../../core/conversation'
import type { UserTier } from '../../core/user-tier'
import { makeEventsStore } from '../events/store'
import { a2aRoutes } from './routes-a2a'
import { socialRoutes } from './routes-social'
import { pairRoutes } from './routes-pair'
import { penpalRoutes } from './routes-penpal'
import { pluginRoutes } from './routes-plugins'
import { licenseRoutes } from './routes-license'
import { daemonControlRoutes } from './routes-daemon-control'
import { fileRoutes } from './routes-files'
import type {
  MemoryReadRequestT, MemoryWriteRequestT, MemoryDeleteRequestT,
  ProjectsSwitchRequestT, ProjectsAddRequestT, ProjectsRemoveRequestT,
  UserSetNameRequestT,
  SharePageRequestT, ShareResurfaceRequestT,
  VoiceSaveConfigRequestT,
  CompanionSnoozeRequestT,
  CompanionImportLocalRequestT,
  WechatReplyRequestT, WechatReplyVoiceRequestT, WechatSendFileRequestT,
  WechatEditMessageRequestT, WechatBroadcastRequestT,
  DelegateRequestT,
  ConversationSetModeRequestT,
} from './schema'

export interface MakeRoutesContext {
  deps: InternalApiDeps
  getDelegate: () => InternalApiDelegateDep | null
  maybePrefix: (chatId: string, text: string, tag: string | undefined) => string
}

const defaultSleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

/**
 * Non-admin SESSION callers may only touch their own chat's memory subtree
 * (`<chatId>/...`) — closes the cross-chat write path that let any trusted
 * chat inject into another chat's persona.md (which broadcasts into every
 * chat's system prompt — persona design §2). File-origin tokens (the
 * operator CLI, which reads the daemon-wide token file) and admin sessions
 * are unrestricted — same trust posture as before this hardening.
 *
 * This is an AUTHORIZATION layer on top of, not instead of, MemoryFS's own
 * resolveSafe traversal guard (fs-api.ts) — that guard stops path escapes
 * off the memory root; this stops in-bounds cross-chat access.
 */
function memoryScopeDenied(path: string, caller?: { tier: UserTier; origin: string; chatId?: string }): boolean {
  if (!caller || caller.origin !== 'session' || caller.tier === 'admin') return false
  if (!caller.chatId) return true                      // session with unknown chat ⇒ deny (fail closed)
  const norm = path.replace(/\\/g, '/')
  if (norm.split('/').some(seg => seg === '..')) return true
  return !(norm === caller.chatId || norm.startsWith(`${caller.chatId}/`))
}

export function makeRoutes({ deps, getDelegate, maybePrefix }: MakeRoutesContext): RouteTable {
  return {
    'GET /v1/health': () => ({
      status: 200,
      body: {
        ok: true,
        daemon_pid: deps.daemonPid,
        // Ops fields for the admin self-diagnosis tool: is the turn store
        // wired, how many sessions are live, is the poll-cycle heartbeat
        // fresh (false ⇒ the daemon may be wedged / not serving).
        turns_store_wired: !!deps.turns,
        sessions_live: deps.listSessions?.()?.length ?? 0,
        heartbeat_fresh: deps.heartbeatFresh?.() ?? null,
      },
    }),

    // ── memory (RFC 03 P1.B B2) ─────────────────────────────────────────
    'POST /v1/memory/read': (_q, body, caller) => {
      if (!deps.memory) return { status: 503, body: { error: 'memory_fs_not_wired' } }
      // Body is pre-validated by index.ts via MemoryReadRequest schema.
      const { path } = body as MemoryReadRequestT
      if (memoryScopeDenied(path, caller)) return { status: 403, body: { error: 'memory_scope_denied' } }
      try {
        const content = deps.memory.read(path)
        return { status: 200, body: content === null ? { exists: false } : { exists: true, content } }
      } catch (err) {
        return { status: 200, body: { error: errMsg(err) } }
      }
    },
    'POST /v1/memory/write': (_q, body, caller) => {
      if (!deps.memory) return { status: 503, body: { error: 'memory_fs_not_wired' } }
      // Body is pre-validated by index.ts via MemoryWriteRequest schema.
      const { path, content } = body as MemoryWriteRequestT
      if (memoryScopeDenied(path, caller)) return { status: 403, body: { error: 'memory_scope_denied' } }
      try {
        deps.memory.write(path, content)
        return { status: 200, body: { ok: true } }
      } catch (err) {
        return { status: 200, body: { ok: false, error: errMsg(err) } }
      }
    },
    'GET /v1/memory/list': (q, _body, caller) => {
      if (!deps.memory) return { status: 503, body: { error: 'memory_fs_not_wired' } }
      let dir = q.get('dir')
      // The system prompt's default recall flow ("回复前: memory_list + 读相关
      // .md") calls this with no `dir` at all. For a scoped (non-admin
      // session) caller that used to fail scope-denial on the root — every
      // trusted/guest chat's default recall silently 403'd. The correct
      // meaning of "list my memory" for a scoped caller IS its own subtree,
      // so default to that instead of evaluating the root. Explicit `dir`
      // still goes through the normal scope check below (own subtree ok,
      // others 403); unscoped callers (file token / admin) are unaffected.
      if (dir === null && caller?.origin === 'session' && caller.tier !== 'admin' && caller.chatId) {
        dir = caller.chatId
      }
      if (memoryScopeDenied(dir ?? '', caller)) return { status: 403, body: { error: 'memory_scope_denied' } }
      try {
        return { status: 200, body: { files: deps.memory.list(dir ?? undefined) } }
      } catch (err) {
        return { status: 200, body: { error: errMsg(err) } }
      }
    },
    'POST /v1/memory/delete': async (_q, body, caller) => {
      if (!deps.memory) return { status: 503, body: { error: 'memory_fs_not_wired' } }
      if (!deps.db) return { status: 503, body: { error: 'db_not_wired' } }
      // Body is pre-validated by index.ts via MemoryDeleteRequest schema.
      const { chat_id, path, reason } = body as MemoryDeleteRequestT
      if (memoryScopeDenied(path, caller)) return { status: 403, body: { error: 'memory_scope_denied' } }
      try {
        const tombstone = deps.memory.softDelete(path)
        if (tombstone === null) {
          return { status: 200, body: { ok: true, existed: false } }
        }
        // Per-chat audit log. Constructed per-call — prepared-statement
        // cache lives on db, not store, so this is cheap.
        await makeEventsStore(deps.db, chat_id).append({
          kind: 'memory_deleted',
          trigger: 'mcp_tool_call',
          reasoning: reason,
          memory_path: tombstone,
        })
        return { status: 200, body: { ok: true, existed: true, tombstone } }
      } catch (err) {
        return { status: 200, body: { ok: false, error: errMsg(err) } }
      }
    },

    // ── projects (RFC 03 P1.B B3) ───────────────────────────────────────
    'GET /v1/projects/list': () => {
      if (!deps.projects) return { status: 503, body: { error: 'projects_not_wired' } }
      // Legacy wire shape returned the array directly (not wrapped). Preserve.
      return { status: 200, body: deps.projects.list() }
    },
    'POST /v1/projects/switch': async (_q, body) => {
      if (!deps.projects) return { status: 503, body: { error: 'projects_not_wired' } }
      // Body is pre-validated by index.ts via ProjectsSwitchRequest schema.
      const { alias } = body as ProjectsSwitchRequestT
      const r = await deps.projects.switchTo(alias)
      return { status: 200, body: r }
    },
    'POST /v1/projects/add': async (_q, body) => {
      if (!deps.projects) return { status: 503, body: { error: 'projects_not_wired' } }
      // Body is pre-validated by index.ts via ProjectsAddRequest schema.
      const { alias, path } = body as ProjectsAddRequestT
      try {
        await deps.projects.add(alias, path)
        return { status: 200, body: { ok: true } }
      } catch (err) {
        // Match legacy behaviour: in-process tool handler did not catch
        // here; the SDK surfaced the error. Mirror that by returning 200
        // with {ok:false,error} so the agent sees a structured result
        // rather than a transport exception. Stricter callers can read
        // the body and decide.
        return { status: 200, body: { ok: false, error: errMsg(err) } }
      }
    },
    'POST /v1/projects/remove': async (_q, body) => {
      if (!deps.projects) return { status: 503, body: { error: 'projects_not_wired' } }
      // Body is pre-validated by index.ts via ProjectsRemoveRequest schema.
      const { alias } = body as ProjectsRemoveRequestT
      try {
        await deps.projects.remove(alias)
        return { status: 200, body: { ok: true } }
      } catch (err) {
        return { status: 200, body: { ok: false, error: errMsg(err) } }
      }
    },

    // ── user name (RFC 03 P1.B B3) ──────────────────────────────────────
    'POST /v1/user/set_name': async (_q, body) => {
      if (!deps.setUserName) return { status: 503, body: { error: 'set_user_name_not_wired' } }
      // Body is pre-validated by index.ts via UserSetNameRequest schema.
      const { chat_id, name } = body as UserSetNameRequestT
      try {
        await deps.setUserName(chat_id, name)
        return { status: 200, body: { ok: true } }
      } catch (err) {
        return { status: 200, body: { ok: false, error: errMsg(err) } }
      }
    },

    // ── share_page / resurface_page (RFC 03 P1.B B5) ────────────────────
    'POST /v1/share/page': async (_q, body) => {
      if (!deps.sharePage) return { status: 503, body: { error: 'share_page_not_wired' } }
      // Body is pre-validated by index.ts via SharePageRequest schema.
      const { title, content, needs_approval, chat_id, account_id } = body as SharePageRequestT
      // Mirror legacy behaviour: only forward opts the agent supplied;
      // omit the entire arg if all opts are absent (deps.sharePage relies
      // on `undefined` to mean "use defaults" — passing {} would override).
      const opts: { needs_approval?: boolean; chat_id?: string; account_id?: string } = {}
      if (needs_approval === true) opts.needs_approval = true
      if (chat_id !== undefined) opts.chat_id = chat_id
      if (account_id !== undefined) opts.account_id = account_id
      try {
        const r = await deps.sharePage(title, content, Object.keys(opts).length ? opts : undefined)
        return { status: 200, body: r }
      } catch (err) {
        return { status: 200, body: { ok: false, error: errMsg(err) } }
      }
    },
    'POST /v1/share/resurface': async (_q, body) => {
      if (!deps.resurfacePage) return { status: 503, body: { error: 'resurface_page_not_wired' } }
      // Body is pre-validated by index.ts via ShareResurfaceRequest schema.
      const { slug, title_fragment } = body as ShareResurfaceRequestT
      try {
        const r = await deps.resurfacePage({
          ...(slug !== undefined ? { slug } : {}),
          ...(title_fragment !== undefined ? { title_fragment } : {}),
        })
        // Legacy wire shape: returns the page record OR `{ok:false, reason:'not found'}`.
        return { status: 200, body: r ?? { ok: false, reason: 'not found' } }
      } catch (err) {
        return { status: 200, body: { ok: false, error: errMsg(err) } }
      }
    },

    // ── voice config (RFC 03 P1.B B4) ───────────────────────────────────
    'GET /v1/voice/status': () => {
      if (!deps.voice) return { status: 503, body: { error: 'voice_not_wired' } }
      // configStatus is sync, never throws — direct return.
      return { status: 200, body: deps.voice.configStatus() }
    },
    // ── companion proactive tick (RFC 03 P1.B B6) ───────────────────────
    'GET /v1/companion/status': () => {
      if (!deps.companion) return { status: 503, body: { error: 'companion_not_wired' } }
      return { status: 200, body: deps.companion.status() }
    },
    'POST /v1/companion/enable': async () => {
      if (!deps.companion) return { status: 503, body: { error: 'companion_not_wired' } }
      try {
        const r = await deps.companion.enable()
        return { status: 200, body: r }
      } catch (err) {
        return { status: 200, body: { ok: false, error: errMsg(err) } }
      }
    },
    'POST /v1/companion/disable': async () => {
      if (!deps.companion) return { status: 503, body: { error: 'companion_not_wired' } }
      try {
        const r = await deps.companion.disable()
        return { status: 200, body: r }
      } catch (err) {
        return { status: 200, body: { ok: false, error: errMsg(err) } }
      }
    },
    'POST /v1/companion/snooze': async (_q, body) => {
      if (!deps.companion) return { status: 503, body: { error: 'companion_not_wired' } }
      // Body is pre-validated by index.ts via CompanionSnoozeRequest schema.
      const { minutes } = body as CompanionSnoozeRequestT
      try {
        const r = await deps.companion.snooze(minutes)
        return { status: 200, body: r }
      } catch (err) {
        return { status: 200, body: { ok: false, error: errMsg(err) } }
      }
    },
    'POST /v1/companion/import-local': async (_q, body) => {
      if (!deps.companion) return { status: 503, body: { error: 'companion_not_wired' } }
      // Body is pre-validated by index.ts via CompanionImportLocalRequest schema.
      const { enabled } = body as CompanionImportLocalRequestT
      try {
        const r = await deps.companion.setImportLocal(enabled)
        return { status: 200, body: r }
      } catch (err) {
        return { status: 200, body: { ok: false, error: errMsg(err) } }
      }
    },

    // ── ilink-bound message family (RFC 03 P1.B B1) ─────────────────────
    // The reply / reply_voice / send_file / edit_message / broadcast tools
    // detected by both providers' replyToolCalled flag. After B1 these are
    // exposed by the stdio `wechat` server (renamed from `wechat_ipc`),
    // which is what claude-agent-provider's REPLY_TOOL_NAMES set and
    // codex-agent-provider's WECHAT_MCP_SERVER='wechat' check match against.
    'POST /v1/wechat/reply': async (_q, body) => {
      if (!deps.ilink) return { status: 503, body: { error: 'ilink_not_wired' } }
      // Body is pre-validated by index.ts via WechatReplyRequest schema.
      const { chat_id, text, participant_tag } = body as WechatReplyRequestT
      // App-conversation-channel, Stage 0: when a reply sink is open for
      // this chat, capture the RAW text (whole, pre-split, pre-prefix — the
      // app shows the whole reply) instead of ilink-sending it.
      if (deps.replySinks?.capture(chat_id, text)) {
        return { status: 200, body: { ok: true, captured: true } }
      }
      // RFC 03 P3 — mode-aware prefixing. Only applies when the chat is
      // in a multi-participant mode AND the caller supplied its tag.
      // Solo mode (and absent prefix deps) → text passes through unchanged.
      const prefixed = maybePrefix(chat_id, text, participant_tag)
      // Reply splitting (活人感, spec 2026-07-09): only un-prefixed replies —
      // chunks 2+ of a prefixed send would lose their [Display] attribution.
      // Absent getChatPrefs dep ⇒ disabled (tests/embedded unchanged);
      // wired ⇒ default ON unless this chat set split:false.
      const prefs = prefixed === text ? deps.getChatPrefs?.(chat_id) : undefined
      const chunks = prefs !== undefined && prefs.split !== false ? splitReply(text) : [prefixed]
      const sleep = deps.sleepMs ?? defaultSleep
      let sentCount = 0
      try {
        let lastMsgId = ''
        for (let i = 0; i < chunks.length; i++) {
          const r = await deps.ilink.sendReply(chat_id, chunks[i]!)
          // Legacy in-process wrapper reshaped {msgId,error?} → {ok,msg_id} or
          // {ok:false,error}. Preserve verbatim so the agent's mental model
          // doesn't shift across this migration.
          if (r.error) {
            if (sentCount > 0) deps.log?.('WECHAT_REPLY', `split partial failure chat=${chat_id} sent=${sentCount}/${chunks.length} err=${r.error}`)
            return { status: 200, body: { ok: false, error: r.error, ...(sentCount > 0 ? { sent: sentCount } : {}) } }
          }
          sentCount++
          lastMsgId = r.msgId
          if (i < chunks.length - 1) await sleep(paceMs(chunks[i]!))
        }
        return { status: 200, body: { ok: true, msg_id: lastMsgId } }
      } catch (err) {
        if (sentCount > 0) deps.log?.('WECHAT_REPLY', `split partial failure chat=${chat_id} sent=${sentCount}/${chunks.length} err=${errMsg(err)}`)
        return { status: 200, body: { ok: false, error: errMsg(err), ...(sentCount > 0 ? { sent: sentCount } : {}) } }
      }
    },
    'POST /v1/wechat/reply_voice': async (_q, body) => {
      if (!deps.voice) return { status: 503, body: { error: 'voice_not_wired' } }
      // Body is pre-validated by index.ts via WechatReplyVoiceRequest schema.
      const { chat_id, text } = body as WechatReplyVoiceRequestT
      // Business rule: enforce 500-char cap with structured reason, not schema validation.
      // Schema is structural (shape), not business (value range).
      if (text.length > 500) {
        return { status: 200, body: { ok: false, reason: 'too_long', limit: 500 } }
      }
      try {
        const r = await deps.voice.replyVoice(chat_id, text)
        return { status: 200, body: r }
      } catch (err) {
        return { status: 200, body: { ok: false, reason: 'unexpected_error', detail: errMsg(err) } }
      }
    },
    'POST /v1/wechat/send_file': async (_q, body) => {
      if (!deps.ilink) return { status: 503, body: { error: 'ilink_not_wired' } }
      // Body is pre-validated by index.ts via WechatSendFileRequest schema.
      const { chat_id, path } = body as WechatSendFileRequestT
      try {
        await deps.ilink.sendFile(chat_id, path)
        return { status: 200, body: { ok: true } }
      } catch (err) {
        return { status: 200, body: { ok: false, error: errMsg(err) } }
      }
    },
    'POST /v1/wechat/edit_message': async (_q, body) => {
      if (!deps.ilink) return { status: 503, body: { error: 'ilink_not_wired' } }
      // Body is pre-validated by index.ts via WechatEditMessageRequest schema.
      const { chat_id, msg_id, text } = body as WechatEditMessageRequestT
      try {
        await deps.ilink.editMessage(chat_id, msg_id, text)
        return { status: 200, body: { ok: true } }
      } catch (err) {
        return { status: 200, body: { ok: false, error: errMsg(err) } }
      }
    },
    // ── delegate consultation (RFC 03 P4) ───────────────────────────────
    'POST /v1/delegate': async (_q, body) => {
      const d = getDelegate()
      if (!d) return { status: 503, body: { error: 'delegate_not_wired' } }
      // Body is pre-validated by index.ts via DelegateRequest schema.
      // Schema enforces: peer (string), prompt (string), optional cwd (absolute path),
      // optional context_summary (string), optional depth (number).
      const { peer, prompt, context_summary, cwd, depth: depthVal } = body as DelegateRequestT
      const known = d.knownPeers()
      if (!known.includes(peer)) {
        return { status: 400, body: { error: 'unknown_peer', allowed: known } }
      }
      // RFC 03 P5 review #7 — defense in depth against recursion. The
      // bare delegate provider has no delegate-mcp loaded, so the peer
      // CAN'T call this route through normal paths — recursion is
      // structurally prevented. But a curious peer that read the token
      // file + posted directly could still attempt nesting; reject any
      // depth > 0 server-side as a backstop. (delegate-mcp client always
      // sends depth=0 from a regular session env; peers don't have the
      // env so they'd have to fabricate.)
      const depth = depthVal ?? 0
      if (depth > 0) {
        deps.log?.('DELEGATE', `nested-call rejected: peer=${peer} depth=${depth}`, {
          event: 'delegate_nested_rejected',
          peer,
          depth,
        })
        return { status: 403, body: { ok: false, reason: 'nested_delegate_rejected', depth } }
      }
      // Compose the actual prompt that the peer sees. The peer is
      // bare-bones (no conversation history, no wechat tools), so the
      // prompt is self-contained.
      const fullPrompt = context_summary && context_summary.length > 0
        ? `${prompt}\n\nContext from the calling agent:\n${context_summary}`
        : prompt
      const started = Date.now()
      try {
        const r = await d.dispatchOneShot(peer, fullPrompt, cwd)
        const elapsed = Date.now() - started
        if (r.ok) {
          deps.log?.('DELEGATE', `peer=${peer} ok response_chars=${r.response.length} ms=${elapsed}`, {
            event: 'delegate_ok',
            peer,
            response_chars: r.response.length,
            duration_ms: elapsed,
          })
        } else {
          deps.log?.('DELEGATE', `peer=${peer} fail reason=${r.reason}`, {
            event: 'delegate_fail',
            peer,
            reason: r.reason,
            duration_ms: elapsed,
          })
        }
        return { status: 200, body: r }
      } catch (err) {
        deps.log?.('DELEGATE', `peer=${peer} threw: ${errMsg(err)}`, {
          event: 'delegate_threw',
          peer,
          error: errMsg(err),
          duration_ms: Date.now() - started,
        })
        return { status: 200, body: { ok: false, reason: errMsg(err) } }
      }
    },

    'POST /v1/wechat/broadcast': async (_q, body) => {
      if (!deps.ilink) return { status: 503, body: { error: 'ilink_not_wired' } }
      // Body is pre-validated by index.ts via WechatBroadcastRequest schema.
      const { text, account_id } = body as WechatBroadcastRequestT
      try {
        const r = await deps.ilink.broadcast(text, account_id)
        return { status: 200, body: r }
      } catch (err) {
        return { status: 200, body: { ok: false, error: errMsg(err) } }
      }
    },

    // ── conversation mode switch (console-triggered) ─────────────────────
    'POST /v1/conversation/set-mode': async (_q, body) => {
      if (!deps.conversation) return { status: 503, body: { error: 'conversation_not_wired' } }
      // Body is pre-validated by index.ts via ConversationSetModeRequest schema.
      // Schema enforces chatId (string) and mode (discriminated union of known kinds).
      const { chatId, mode } = body as ConversationSetModeRequestT
      try {
        deps.conversation.setMode(chatId, mode as unknown as Mode)
      } catch (err) {
        return { status: 400, body: { error: errMsg(err) } }
      }
      // Human-readable name for the confirmation message.
      const kindNames: Record<string, string> = {
        solo: `solo · ${'provider' in mode ? mode.provider : '?'}`,
        parallel: 'parallel',
        primary_tool: `primary_tool · ${'primary' in mode ? mode.primary : '?'}`,
        chatroom: 'chatroom',
      }
      const humanName = kindNames[mode.kind] ?? String(mode.kind)
      // Best-effort wechat reply — never fail the route if send fails.
      if (deps.ilink) {
        deps.ilink.sendReply(chatId, `🎛 已切换到 ${humanName}（来自控制台）`).catch(err => {
          deps.log?.('SET_MODE', `wechat reply failed: ${errMsg(err)}`)
        })
      }
      deps.log?.('SET_MODE', `chat=${chatId} mode=${JSON.stringify(mode)}`, {
        event: 'set_mode_ok',
        chatId,
        mode,
      })
      return { status: 200, body: { ok: true } }
    },

    // ── companion converse (app-conversation-channel, voice arc Stage 0) ──
    // Drives one real turn on the owner's own session and hands the reply
    // back to the caller synchronously — the app channel's core primitive.
    'POST /v1/companion/converse': async (_q, body) => {
      if (!deps.companionConverse) return { status: 503, body: { error: 'companion_converse_not_wired' } }
      const { text } = body as { text?: unknown }
      if (typeof text !== 'string' || text.trim().length === 0) {
        return { status: 400, body: { error: 'text required' } }
      }
      try {
        const r = await deps.companionConverse(text)
        return { status: 200, body: { ok: true, reply: r.reply } }
      } catch (err) {
        const msg = errMsg(err)
        if (msg === 'reply_sink_busy') return { status: 409, body: { ok: false, error: 'session_busy' } }
        if (msg === 'companion_owner_chat_not_configured') {
          return { status: 503, body: { ok: false, error: msg } }
        }
        return { status: 500, body: { ok: false, error: msg } }
      }
    },

    // ── companion speak (app-conversation-channel, voice arc Stage 1) ──
    // Synthesizes reply audio for arbitrary text via the daemon's voice
    // config and hands the bytes back to the caller (base64) instead of
    // ilink-sending — reuses deps.voice.synthesizeSpeech, which mirrors
    // replyVoice's synth step exactly, minus the wechat upload/send.
    'POST /v1/companion/speak': async (_q, body) => {
      if (!deps.voice) return { status: 503, body: { error: 'voice_not_wired' } }
      const { text } = body as { text?: unknown }
      if (typeof text !== 'string' || text.trim().length === 0) {
        return { status: 400, body: { error: 'text required' } }
      }
      if (text.length > 5000) {
        return { status: 400, body: { error: 'text too long' } }
      }
      try {
        const { audio, mime } = await deps.voice.synthesizeSpeech(text)
        return { status: 200, body: { ok: true, audio_b64: audio.toString('base64'), mime } }
      } catch (err) {
        const m = errMsg(err)
        if (/no.?voice.?config|not configured/i.test(m)) {
          return { status: 422, body: { ok: false, error: 'no_voice_config' } }
        }
        return { status: 500, body: { ok: false, error: m } }
      }
    },

    // ── companion transcribe (app-conversation-channel, voice arc Stage 2) ──
    // Inbound audio (base64) → gateway STT → text. Mirror of /speak.
    'POST /v1/companion/transcribe': async (_q, body) => {
      if (!deps.voice?.transcribe) return { status: 503, body: { error: 'voice_not_wired' } }
      const { audio_b64, mime } = (body ?? {}) as { audio_b64?: unknown; mime?: unknown }
      if (typeof audio_b64 !== 'string' || audio_b64.length === 0) {
        return { status: 400, body: { error: 'audio_b64 required' } }
      }
      let audio: Buffer
      try {
        audio = Buffer.from(audio_b64, 'base64')
      } catch {
        return { status: 400, body: { error: 'audio_b64 must be valid base64' } }
      }
      if (audio.length === 0) return { status: 400, body: { error: 'audio_b64 decoded to empty' } }
      if (audio.length > 25 * 1024 * 1024) return { status: 413, body: { error: 'audio too large (max 25MB)' } }
      try {
        const { text } = await deps.voice.transcribe(audio, typeof mime === 'string' && mime ? mime : 'audio/wav')
        return { status: 200, body: { ok: true, text } }
      } catch (err) {
        const m = errMsg(err)
        if (/no.?stt.?config/i.test(m)) return { status: 422, body: { ok: false, error: 'no_stt_config' } }
        return { status: 500, body: { ok: false, error: m } }
      }
    },

    'POST /v1/stt/save_config': async (_q, body) => {
      if (!deps.voice?.saveSTTConfig) return { status: 503, body: { error: 'voice_not_wired' } }
      const { base_url, model, api_key } = (body ?? {}) as { base_url?: unknown; model?: unknown; api_key?: unknown }
      try {
        const r = await deps.voice.saveSTTConfig({
          ...(typeof base_url === 'string' ? { base_url } : {}),
          ...(typeof model === 'string' ? { model } : {}),
          ...(typeof api_key === 'string' ? { api_key } : {}),
        })
        return { status: 200, body: r }
      } catch (err) {
        return { status: 200, body: { ok: false, reason: 'unexpected_error', detail: errMsg(err) } }
      }
    },

    'GET /v1/stt/status': () => {
      if (!deps.voice?.sttStatus) return { status: 503, body: { error: 'voice_not_wired' } }
      return { status: 200, body: deps.voice.sttStatus() }
    },

    'POST /v1/voice/save_config': async (_q, body) => {
      if (!deps.voice) return { status: 503, body: { error: 'voice_not_wired' } }
      // Body is pre-validated by index.ts via VoiceSaveConfigRequest schema.
      const { provider, base_url, model, api_key, default_voice } = body as VoiceSaveConfigRequestT
      // saveConfig handles its own validation + test-synth; surface its
      // ok-true / ok-false-reason verbatim. Catch transport-level
      // unexpected errors and shape them into the same {ok:false,reason}
      // contract so the agent sees a structured failure.
      try {
        const r = await deps.voice.saveConfig({
          provider,
          ...(base_url !== undefined ? { base_url } : {}),
          ...(model !== undefined ? { model } : {}),
          ...(api_key !== undefined ? { api_key } : {}),
          ...(default_voice !== undefined ? { default_voice } : {}),
        })
        return { status: 200, body: r }
      } catch (err) {
        return { status: 200, body: { ok: false, reason: 'unexpected_error', detail: errMsg(err) } }
      }
    },

    // ── chat prefs (主动关心档位 / 拆分偏好) ───────────────────────────────
    // INLINE-validated deliberately (no REQUEST_SCHEMAS entry) — keeps the
    // schema-table route count untouched. Backs the set_chat_pref MCP tool:
    // the wechat-mcp child calls this when the user states a preference
    // ("别烦我" / "多关心我" / "别拆分") mid-conversation.
    'POST /v1/chat-prefs': (_q, body) => {
      if (!deps.setChatPref) return { status: 503, body: { error: 'chat_prefs_not_wired' } }
      const b = (body ?? {}) as { chat_id?: unknown; care?: unknown; split?: unknown }
      if (typeof b.chat_id !== 'string' || b.chat_id.trim() === '') {
        return { status: 400, body: { error: 'chat_id required (non-empty string)' } }
      }
      if (b.care !== undefined && b.care !== 'off' && b.care !== 'low' && b.care !== 'high') {
        return { status: 400, body: { error: "care must be one of 'off' | 'low' | 'high'" } }
      }
      if (b.split !== undefined && typeof b.split !== 'boolean') {
        return { status: 400, body: { error: 'split must be a boolean' } }
      }
      if (b.care === undefined && b.split === undefined) {
        return { status: 400, body: { error: 'at least one of care or split is required' } }
      }
      const patch: { care?: 'off' | 'low' | 'high'; split?: boolean } = {}
      if (b.care !== undefined) patch.care = b.care
      if (b.split !== undefined) patch.split = b.split
      const prefs = deps.setChatPref(b.chat_id, patch)
      return { status: 200, body: { ok: true, prefs } }
    },

    // ── stickers (image-stickers plan) ─────────────────────────────────
    // INLINE-validated deliberately (no REQUEST_SCHEMAS entry) — mirrors
    // the /v1/chat-prefs pattern above. Backs the send_sticker MCP tool
    // plus the curated-lib save/list surface used to seed it.
    'POST /v1/wechat/send_sticker': async (_q, body) => {
      if (!deps.stickers) return { status: 503, body: { error: 'stickers_not_wired' } }
      const b = (body ?? {}) as { chat_id?: unknown; tag?: unknown }
      if (typeof b.chat_id !== 'string' || b.chat_id.trim() === '') {
        return { status: 400, body: { error: 'chat_id required (non-empty string)' } }
      }
      if (typeof b.tag !== 'string' || b.tag.trim() === '') {
        return { status: 400, body: { error: 'tag required (non-empty string)' } }
      }
      const path = deps.stickers.resolve(b.tag)
      if (path === null) {
        return { status: 200, body: { ok: false, reason: 'no_sticker_for_tag', tags: deps.stickers.allTags() } }
      }
      if (!deps.ilink) return { status: 503, body: { error: 'ilink_not_wired' } }
      try {
        await deps.ilink.sendFile(b.chat_id, path)
        return { status: 200, body: { ok: true, file: basename(path) } }
      } catch (err) {
        return { status: 200, body: { ok: false, error: errMsg(err) } }
      }
    },
    'POST /v1/stickers': (_q, body) => {
      if (!deps.stickers) return { status: 503, body: { error: 'stickers_not_wired' } }
      const b = (body ?? {}) as { path?: unknown; tags?: unknown; desc?: unknown }
      if (typeof b.path !== 'string' || b.path.trim() === '') {
        return { status: 400, body: { error: 'path required (non-empty string)' } }
      }
      if (
        !Array.isArray(b.tags) ||
        b.tags.length === 0 ||
        !b.tags.every((t) => typeof t === 'string' && t.trim() !== '')
      ) {
        return { status: 400, body: { error: 'tags required (non-empty array of non-empty strings)' } }
      }
      if (b.desc !== undefined && typeof b.desc !== 'string') {
        return { status: 400, body: { error: 'desc must be a string' } }
      }
      try {
        const saved = deps.stickers.save(b.path, b.tags as string[], b.desc as string | undefined)
        return { status: 200, body: { ok: true, file: saved.file, tags: saved.tags } }
      } catch (err) {
        return { status: 400, body: { error: errMsg(err) } }
      }
    },
    'GET /v1/stickers': () => {
      if (!deps.stickers) return { status: 503, body: { error: 'stickers_not_wired' } }
      return { status: 200, body: { ok: true, stickers: deps.stickers.list(), tags: deps.stickers.allTags() } }
    },

    // ── a2a (send / test / dashboard CRUD) + daemon-control (sessions / model
    //    / restart / turns) live in sibling files — spread in here. ──────────
    ...a2aRoutes(deps),
    ...socialRoutes(deps),
    ...pairRoutes(deps),
    ...penpalRoutes(deps),
    ...pluginRoutes(deps),
    ...licenseRoutes(deps),
    ...daemonControlRoutes(deps),
    ...fileRoutes(),
  }
}

/**
 * RFC 03 review #5 fix: defers the "should this reply be prefixed?"
 * decision to the capability matrix via `lookup().replyPrefix` so
 * internal-api stops switching on mode.kind directly. The matrix is now
 * the single source of truth — adding a new mode or permissionMode
 * requires only a new matrix row, not a code change here.
 *
 * replyPrefix semantics:
 *   'always'           — prefix [DisplayName] (parallel / chatroom)
 *   'never'            — no prefix (solo)
 *   'on-fallback-only' — no prefix at this call site (primary_tool; the
 *                        fallback path in coordinator.ts handles its own label)
 *
 * Unknown provider fallback: if the participant_tag references a provider
 * not yet in the capability matrix (e.g. a future 'gemini' provider before
 * a matrix row is added), the lookup throws. In that case we fall back to
 * the mode's structural semantics: parallel and chatroom always prefix,
 * other modes never do. This preserves correctness while allowing future
 * providers to work before their matrix rows are defined.
 */
export function makeMaybePrefix(deps: InternalApiDeps): (chatId: string, text: string, tag: string | undefined) => string {
  return function maybePrefix(chatId, text, tag) {
    if (!tag || !deps.prefix) return text
    const mode = deps.prefix.conversationStore.get(chatId)?.mode
    if (!mode) return text
    const permissionMode = deps.prefix.permissionMode
    // Look up the capability row for this (mode × provider-tag × permissionMode).
    let replyPrefix: 'always' | 'never' | 'on-fallback-only'
    try {
      replyPrefix = lookup(mode.kind, tag, permissionMode).replyPrefix
    } catch {
      // Unknown provider-tag (not yet in the matrix) — fall back to structural
      // mode semantics: multi-participant modes prefix, single-voice modes don't.
      replyPrefix = (mode.kind === 'parallel' || mode.kind === 'chatroom') ? 'always' : 'never'
    }
    if (replyPrefix !== 'always') return text
    const dn = deps.prefix.providerDisplayName(tag)
    return `[${dn}] ${text}`
  }
}

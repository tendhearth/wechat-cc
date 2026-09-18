/**
 * internal-api daemon-control routes — the admin self-diagnosis / remediation
 * surface: live sessions, force-release, model get/set, restart, turn feed.
 * Split out of routes.ts; makeRoutes spreads this in. Handlers close over
 * `deps` only. Behavior verbatim from the original table. All admin-tier per
 * route-tiers.ts.
 */
import { type InternalApiDeps, type RouteTable } from './types'
import { loadAgentConfig, saveAgentConfig, activeModel, withActiveModel, modelForProvider, withModelForProvider } from '../../lib/agent-config'
import { PROVIDER_IDS } from '../../lib/provider-ids'

/** provider ids /v1/model accepts in its optional `provider` field. Mirrors
 *  the switch inside modelForProvider/withModelForProvider — anything else
 *  would silently land in `model` (claude/codex's shared field) with a
 *  confirming read-back, which is exactly the lie this guard exists to stop. */
const KNOWN_PROVIDERS: ReadonlySet<string> = new Set(PROVIDER_IDS)

/** POST /v1/selftest/converse's providerId — deliberately looser than
 *  KNOWN_PROVIDERS above (that list is /v1/model's closed provider-ids
 *  vocabulary; selftest just needs a syntactically sane registry key so a
 *  future provider doesn't need this file touched). */
const SELFTEST_PROVIDER_ID_RE = /^[a-z][a-z0-9._-]{0,63}$/

export function daemonControlRoutes(deps: InternalApiDeps): RouteTable {
  return {
    // Live sessions for diagnosis — which (alias, provider, chat) sessions are
    // cached and when each was last used (idle/wedged inference). 503 until
    // bootstrap wires the lister.
    'GET /v1/sessions': () => {
      const sessions = deps.listSessions?.()
      if (sessions == null) return { status: 503, body: { error: 'sessions_not_wired' } }
      return { status: 200, body: { sessions } }
    },

    // Admin remediation — force-release a (possibly wedged) session so the
    // next message in that chat spawns a fresh subprocess. Returns the live
    // session list AFTER the release as a built-in verification read-back.
    'POST /v1/sessions/release': async (_q, body) => {
      if (!deps.releaseSession) return { status: 503, body: { error: 'release_not_wired' } }
      const b = (body ?? {}) as { alias?: unknown; providerId?: unknown; chatId?: unknown }
      if (typeof b.alias !== 'string' || typeof b.providerId !== 'string' || typeof b.chatId !== 'string') {
        return { status: 400, body: { error: 'alias, providerId, chatId required (strings)' } }
      }
      // Was there actually a live session to release? Compute it from the
      // session list so the read-back is honest — a no-op release (already
      // gone / wrong key / pre-bootstrap) reports `released:false` instead of
      // a misleading `ok:true`, so the agent's self-heal verification is real.
      const before = deps.listSessions?.() ?? []
      const released = before.some(s => s.alias === b.alias && s.providerId === b.providerId && s.chatId === b.chatId)
      await deps.releaseSession({ alias: b.alias, providerId: b.providerId, chatId: b.chatId })
      return { status: 200, body: { ok: true, released, sessions: deps.listSessions?.() ?? null } }
    },

    // Current pinned agent model (read-back companion to POST /v1/model).
    // `?provider=<id>` asks for THAT provider's model — the caller's own
    // (wechat-mcp model_get passes WECHAT_PARTICIPANT_TAG), so an /api or
    // /agy chat gets its own answer instead of the global default's.
    'GET /v1/model': (q) => {
      const cfg = loadAgentConfig(deps.stateDir)
      const provider = q.get('provider')
      if (provider) {
        if (!KNOWN_PROVIDERS.has(provider)) return { status: 400, body: { error: `unknown provider '${provider}'` } }
        return { status: 200, body: { provider, model: modelForProvider(cfg, provider) ?? null } }
      }
      // Report the field the configured provider actually uses (activeModel
      // owns the cursor-vs-claude/codex rule).
      return { status: 200, body: { provider: cfg.provider, model: activeModel(cfg) ?? null } }
    },

    // Admin remediation — switch the pinned model. Takes effect on the next
    // session spawn per chat: the live sessions of that provider are released
    // AND their resume rows dropped, so the next spawn is a cold start that
    // pins the new model (codex still applies its own model at provider
    // construction, so it keeps needing a daemon restart). Returns the
    // persisted model plus `released` / `forgotten` counts as a read-back.
    'POST /v1/model': async (_q, body) => {
      const b = (body ?? {}) as { model?: unknown; provider?: unknown }
      if (typeof b.model !== 'string' || b.model.trim() === '') {
        return { status: 400, body: { error: 'model required (non-empty string)' } }
      }
      const model = b.model.trim()
      // Optional target provider. 主人在 /api 对话里说「换模型」,改的必须是
      // openai 的字段,不是全局默认 provider 的 —— 老行为(无 provider)保留给
      // 桌面/控制台那些本来就是在改全局默认的调用方。
      const provider = typeof b.provider === 'string' && b.provider.trim() !== '' ? b.provider.trim() : undefined
      if (provider !== undefined && !KNOWN_PROVIDERS.has(provider)) {
        return { status: 400, body: { error: `unknown provider '${provider}'` } }
      }
      // Reject obvious bare aliases — a model id with no version digit (e.g.
      // 'opus', 'sonnet') gets mis-resolved by the CLI and 404s EVERY turn (the
      // 2026-05-08 incident this guard exists to prevent). DELIBERATELY
      // permissive on charset: real ids vary wildly across providers and
      // gateways — claude-opus-4-8[1m], anthropic/claude-opus-4, o3,
      // gpt-5.3-codex, us.anthropic.claude-opus-4-8-v1:0 — so the only universal
      // syntactic signal of a real id (vs a bare family alias) is a digit.
      // Whitespace is rejected too. An allowlist would rot as models ship.
      if (/\s/.test(model) || !/[0-9]/.test(model)) {
        return {
          status: 400,
          body: { error: `invalid model id '${model}' — use a full versioned id (e.g. 'claude-opus-4-8'), not a bare alias` },
        }
      }
      const cfg = loadAgentConfig(deps.stateDir)
      // Write the field the target provider reads — writing `model` for a
      // cursor daemon would be a silent no-op with a falsely-confirming read-back.
      const updated = provider !== undefined ? withModelForProvider(cfg, provider, model) : withActiveModel(cfg, model)
      saveAgentConfig(deps.stateDir, updated)
      const effectiveProvider = provider ?? updated.provider
      // 主人说「切到 opus5」,期待的是下一句就在 opus5 上。session 缓存键是
      // (provider, alias, chat),不放掉旧 session 它就一直拿着旧模型 ——
      // 「改了但没生效」比「没改」更糟。把该 provider 的活 session 全释放,
      // 下一条入站重新 spawn(currentModelFor 的 mtime 缓存会读到新值)。
      let released = 0
      if (deps.listSessions && deps.releaseSession) {
        for (const s of deps.listSessions() ?? []) {
          if (s.providerId !== effectiveProvider) continue
          try { await deps.releaseSession({ alias: s.alias, providerId: s.providerId, chatId: s.chatId }); released++ } catch { /* best effort */ }
        }
      }
      // 放掉活 session 还不够:会话存档(sessions 表,7 天)会让下一次 spawn 走 resume,
      // 而 resume 出来的会话沿用它开张时的模型(ACP session/load 不带模型,claude/codex
      // 接的是同一条线)—— 于是"换了模型"在续接的对话上是个空操作。把该 provider 的存档
      // 行删掉,下一次 spawn 冷启动,模型才真的钉得上。代价是那些对话的上下文不再续接。
      let forgotten = 0
      if (deps.forgetProviderSessions) {
        try { forgotten = deps.forgetProviderSessions(effectiveProvider) } catch { /* best effort */ }
      }
      // Read back from the just-persisted value (saveAgentConfig throws on write
      // failure, so reaching here means it landed) — no second disk round-trip.
      return { status: 200, body: { ok: true, provider: effectiveProvider, model: (provider !== undefined ? modelForProvider(updated, provider) : activeModel(updated)) ?? null, released, forgotten } }
    },

    // Admin remediation — graceful daemon restart. The trigger schedules the
    // shutdown+exit AFTER this response flushes; launchd/systemd respawns.
    'POST /v1/daemon/restart': () => {
      if (!deps.requestRestart) return { status: 503, body: { error: 'restart_not_wired' } }
      deps.requestRestart()
      return { status: 200, body: { ok: true, restarting: true } }
    },

    // Self-maintenance (spec 2026-09-18-self-maintenance §1) — spawn ONE
    // test conversation against a registered provider in a scratch
    // project, scoped so its wechat MCP can only ping (never send/broadcast
    // to the owner's real contacts). 503 until bootstrap wires the runner
    // (registry + mintSessionToken/invalidateSession all come from
    // bootstrap). ok:false is a normal 200 — the failure lives in the body
    // so a maintainer/CLI can branch on it without special-casing transport
    // errors vs turn errors.
    'POST /v1/selftest/converse': async (_q, body) => {
      if (!deps.selftestConverse) return { status: 503, body: { error: 'selftest_not_wired' } }
      const b = (body ?? {}) as { providerId?: unknown; text?: unknown; resumeSessionId?: unknown }
      if (typeof b.providerId !== 'string' || !SELFTEST_PROVIDER_ID_RE.test(b.providerId)) {
        return { status: 400, body: { error: 'invalid_request' } }
      }
      if (typeof b.text !== 'string' || b.text.length === 0 || b.text.length > 4000) {
        return { status: 400, body: { error: 'invalid_request' } }
      }
      if (b.resumeSessionId !== undefined && (typeof b.resumeSessionId !== 'string' || b.resumeSessionId.length > 500)) {
        return { status: 400, body: { error: 'invalid_request' } }
      }
      const result = await deps.selftestConverse({
        providerId: b.providerId,
        text: b.text,
        ...(typeof b.resumeSessionId === 'string' ? { resumeSessionId: b.resumeSessionId } : {}),
      })
      return { status: 200, body: result }
    },

    // Per-turn outcome feed for diagnosis. With chatId → that chat's turns
    // newest-first ("why did chat X stop replying"); without → the daemon's
    // recent turns across all chats. limit defaults to 50, clamped to 500.
    'GET /v1/turns': (q) => {
      if (!deps.turns) return { status: 503, body: { error: 'turns_not_wired' } }
      const chatId = q.get('chatId') ?? undefined
      const rawLimit = Number(q.get('limit') ?? '50')
      const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(1, Math.trunc(rawLimit)), 500) : 50
      const turns = chatId
        ? deps.turns.recentForChat(chatId, limit)
        : deps.turns.recent(limit)
      return { status: 200, body: { turns } }
    },
  }
}

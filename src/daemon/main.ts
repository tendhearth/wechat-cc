#!/usr/bin/env bun
if (!process.env.CLAUDE_CODE_ENTRYPOINT) { process.env.CLAUDE_CODE_ENTRYPOINT = 'sdk-ts' }
import { join } from 'node:path'
import { homedir } from 'node:os'
import { acquireInstanceLock, releaseInstanceLock, isHeartbeatFresh, writeHeartbeat, startHeartbeatTicker, HEARTBEAT_FILE, HEARTBEAT_STALE_MS } from './single-instance'
import { openDb } from '../lib/db'
import { LifecycleSet, wireRef } from '../lib/lifecycle'
import { log } from '../lib/log'
import { dedupeAccountsByUserId } from '../lib/dedupe-accounts'
import { loadAccess, AccessConfigCorruptError } from '../lib/access'
import { buildBootstrap, resolveAdminChatId } from './bootstrap'
import { makeMemoryFS } from './memory/fs-api'
import { makeMemoryLlmOps } from './memory-llm-ops'
import { CORE_MEMORY_MAX_CHARS, KNOWLEDGE_MEMORY_MAX_CHARS } from '../core/prompt-builder'
import { makeConversationStore } from '../core/conversation-store'
import { makeTurnRecordStore } from '../core/turn-record-store'
import { providerDisplayName } from './provider-display-names'
import { loadAllAccounts, makeIlinkAdapter } from './ilink-glue'
import { registerInternalApi } from './internal-api/lifecycle'
import { registerCompanionPush, registerCompanionIntrospect, registerIngest } from './companion/lifecycle'
import { registerGuard } from './guard/lifecycle'
import { registerPolling } from './polling-lifecycle'
import { registerSessions } from './sessions-lifecycle'
import { registerIlink } from './ilink-lifecycle'
import { registerMailboxPoller } from './bootstrap/wire-mailbox'
import { registerReminders } from './reminders/sweeper'
import { makeRemindersStore } from './reminders/store'
import { buildInboundPipeline } from './inbound/build'
import { runStartupSweeps } from './startup-sweeps'
import { wireMain } from './wiring'
import type { TickBodies } from './wiring/tick-bodies'
import { makeChatPrefs } from './chat-prefs'
import { makeStickerLib, seedStarterStickers, starterStickersDir } from './stickers'
import { makeReplySinks } from './reply-sinks'
import { makeCareLedger } from './companion/care-ledger'
import { careLevel } from './companion/calibration'
import { loadCompanionConfig } from './companion/config'
import { companionOfferEligible } from './companion/offer-eligibility'
import { countInboundMessagesSync, NEW_RELATIONSHIP_MSG_COUNT } from '../lib/messages-store'
import { startCustomerReviewRuntime } from './customer-review/runtime'
import { SUPERVISED_ENV } from '../core/supervised-env'
import { SubsystemSupervisor } from './subsystems'
import { removeAgyGlobalMcp } from './bootstrap/agy-mcp-config'
import { removeCursorGlobalMcp } from './bootstrap/cursor-mcp-config'

function errorDetails(err: unknown): string {
  if (err instanceof Error) return err.stack || err.message
  try { return JSON.stringify(err) } catch { return String(err) }
}

export interface BootDaemonOpts {
  stateDir: string
  dangerously: boolean
  /**
   * Eval-harness override — when set, both companion schedulers use this
   * interval (ms) instead of the production defaults. Eval harness passes
   * `1_000_000_000` (≈11.5 days; jitter-safe under setTimeout's int32 cap)
   * to suppress auto-fire so the engine drives ticks with fireTick().
   * Production callers (cli `run`, signal handlers) never set this.
   */
  schedulerIntervalMs?: number
}
export interface DaemonHandle {
  shutdown(): Promise<void>
  pollingReconcile?(): Promise<void>
  /**
   * Eval-harness seam — manually fire one tick of the named kind, with the
   * given virtual timestamp baked into the envelope. Bypasses the scheduler
   * gates (shouldRun + jitter). Returns when the tick body completes.
   *
   * Production callers never use this; production uses the periodic scheduler
   * registered via registerCompanionPush / registerCompanionIntrospect.
   */
  fireTick(kind: 'push' | 'introspect', at: Date): Promise<void>
}

export async function bootDaemon(opts: BootDaemonOpts): Promise<DaemonHandle> {
  const { stateDir, dangerously } = opts
  const PID_PATH = join(stateDir, 'server.pid')
  const HEARTBEAT_PATH = join(stateDir, HEARTBEAT_FILE)
  // Health-aware lock: refuse only if the existing holder is alive AND its
  // heartbeat is fresh (it's actually serving). A wedged/half-started daemon
  // — the desktop-launchd "holds the pidfile but never replies" case — lets
  // its heartbeat go stale, so we take the lock over instead of forcing the
  // user to kill it by hand. A holder with no heartbeat file (predates this,
  // or just started) is treated as fresh, so we never steal an unproven lock.
  // The stale window must exceed the longest a HEALTHY daemon can legitimately
  // go between heartbeats. onInbound runs the full agent turn inline in the
  // poll loop, so the worst-case gap is one max-length turn — the per-turn
  // watchdog ends a stalled turn at turnTimeoutMs (default 10min), after which
  // polling + heartbeat resume. If the window were shorter (the old flat 120s),
  // a single long-but-legitimate turn would let a second daemon steal the lock
  // → two daemons polling the same account. Floor at HEARTBEAT_STALE_MS, then
  // ensure it clears turnTimeoutMs + a margin. (Mirrors bootstrap's parse.)
  const turnTimeoutMs = (() => {
    const raw = process.env['WECHAT_TURN_TIMEOUT_MS']
    if (raw == null || raw === '') return 10 * 60_000
    const n = Number(raw)
    return Number.isFinite(n) && n >= 0 ? n : 10 * 60_000
  })()
  const heartbeatStaleMs = Math.max(HEARTBEAT_STALE_MS, turnTimeoutMs + 60_000)
  const lock = acquireInstanceLock(PID_PATH, { isHealthy: () => isHeartbeatFresh(HEARTBEAT_PATH, heartbeatStaleMs) })
  if (!lock.ok) throw new Error(`[wechat-cc] ${lock.reason} (pid=${lock.pid})`)
  // Stamp an initial heartbeat immediately so this just-started daemon reads
  // as healthy before its first poll cycle lands. A dedicated ticker then
  // refreshes it on a fixed cadence, DECOUPLED from poll work — so a long inline
  // turn (or macOS sleep/wake) can't let the heartbeat go stale and invite a
  // second daemon to steal the lock. The poll loop's per-cycle stamp stays as a
  // belt-and-suspenders signal.
  writeHeartbeat(HEARTBEAT_PATH)
  const stopHeartbeat = startHeartbeatTicker(HEARTBEAT_PATH)
  // v0.5.6: collapse duplicate ilink bot bindings to one per wechat userId
  // BEFORE loading accounts. ilink only allows one active bot per user — when
  // the user re-scans, the old bot's session is invalidated server-side. The
  // dedupe archives stale dirs to `<botId>.superseded.<iso>` and loadAllAccounts
  // skips that infix. Idempotent on already-clean state.
  dedupeAccountsByUserId(join(stateDir, 'accounts'), {}, { log: (t, l) => log(t, l) })
  // Validate access.json eagerly. If the file is unparseable we refuse
  // to boot — preserves the prior process.exit(1) behavior from
  // readAccessFile, but now goes through the typed exception so tests
  // can catch it instead of needing process.exit interception.
  try { loadAccess() }
  catch (err) {
    if (err instanceof AccessConfigCorruptError) {
      releaseInstanceLock(PID_PATH)
      process.stderr.write(`wechat channel: FATAL ${err.message}\n`)
      process.exit(1)
    }
    throw err
  }
  const accounts = await loadAllAccounts(stateDir)
  if (accounts.length === 0) { releaseInstanceLock(PID_PATH); throw new Error('[wechat-cc] no accounts bound. Run `wechat-cc setup` first.') }
  const db = openDb({ path: join(stateDir, 'wechat-cc.db') })
  // Per-turn observability store — written by the coordinator's recordTurn
  // (via bootstrap onTurnRecord) and read by internal-api GET /v1/turns.
  // Created here so both the internal-api registration and bootstrap below
  // share the one instance.
  const turnRecordStore = makeTurnRecordStore(db)
  // ConversationStore must be constructed BEFORE the ilink adapter —
  // PR5 Task 21 routes the adapter's setUserName/resolveUserName through
  // it, replacing the deprecated user_names.json store. Both legacy
  // conversations.json and user_names.json are backfilled here on first
  // boot and renamed to *.migrated when done.
  const conversationStore = makeConversationStore(db, {
    migrateFromFile: join(stateDir, 'conversations.json'),
    migrateFromUserNamesFile: join(stateDir, 'user_names.json'),
  })
  const ilink = makeIlinkAdapter({ stateDir, accounts, db, conversationStore })
  const memoryFS = makeMemoryFS({ rootDir: join(stateDir, 'memory') })
  const lc = new LifecycleSet((tag, line) => log(tag, line))
  // Subsystem degraded-boot (spec 2026-08-17) — 只包可选子系统;核心链不经它。
  const sup = new SubsystemSupervisor((t, l) => log(t, l))
  let shuttingDown = false; let didStartup = false
  let pollingLcRef: { reconcile(): Promise<void> } | null = null
  let ticksRef: TickBodies | null = null
  let bootRef: import('./bootstrap').Bootstrap | null = null

  const shutdown = async () => {
    if (shuttingDown) return
    shuttingDown = true; log('DAEMON', 'shutdown initiated')
    stopHeartbeat()
    if (didStartup) { try { await lc.stopAll() } catch { /* logged by lc */ } }
    // Stop A2A server if it was started (a2a_listen was configured).
    try { await bootRef?.a2aServer?.stop() } catch (err) { log('A2A', `server stop error: ${err instanceof Error ? err.message : String(err)}`) }
    // Cancel any in-flight pairing-code poller (spec §7) if boot.pairing was
    // wired (mailbox_relays configured) — mirrors the a2aServer stop above.
    // Undefined/no active code ⇒ a clean no-op (PairingEngine.stop() is
    // itself a no-op when nothing is active).
    try { bootRef?.pairing?.stop() } catch (err) { log('PAIR', `stop error: ${err instanceof Error ? err.message : String(err)}`) }
    // Close the Knowledge Kernel store if boot.knowledge was wired
    // (knowledge_enabled configured) — mirrors the a2aServer/pairing
    // teardown above; a dangling sqlite handle otherwise leaks past shutdown.
    try { bootRef?.knowledge?.store.close() } catch (err) { log('KNOWLEDGE', `store close error: ${err instanceof Error ? err.message : String(err)}`) }
    // Close the shared embedder service (Agent-facing Search Task 2) if one
    // was constructed (knowledge_enabled + a resolvable embed script) — it's
    // long-lived across cycles/queries by design (never closed per-cycle,
    // see bootstrap/index.ts), so shutdown is the only place it tears down
    // its embed subprocess.
    try { await bootRef?.knowledge?.embedder?.close?.() } catch (err) { log('KNOWLEDGE', `embedder close error: ${err instanceof Error ? err.message : String(err)}`) }
    // Clean up the tier-C global MCP entry (spec §3 residual, 2026-08-17
    // follow-up) if agy was ever registered this boot — mirrors the other
    // bootRef?.…-guarded optional teardowns above. Best-effort only: a
    // crash-exit skips this and leaves the dead-token entry on disk, but
    // that's fine — boot rewrites/upserts it fresh next start regardless.
    try { if (bootRef?.registry?.has?.('agy')) removeAgyGlobalMcp({ log }) } catch (err) { log('AGY', `mcp config cleanup error: ${err instanceof Error ? err.message : String(err)}`) }
    try { if (bootRef?.registry?.has?.('cursor')) removeCursorGlobalMcp({ log }) } catch (err) { log('CURSOR', `mcp config cleanup error: ${err instanceof Error ? err.message : String(err)}`) }
    try { db.close() } catch (err) { console.error('db close failed:', err) }
    releaseInstanceLock(PID_PATH)
  }

  // Restart: let the caller flush (HTTP response / a log line), then
  // graceful shutdown + exit so launchd/systemd KeepAlive respawns a fresh
  // daemon (ThrottleInterval caps the respawn rate). exit(0) is fine —
  // KeepAlive respawns regardless. ONE closure, TWO triggers: the operator
  // POST /v1/daemon/restart route (below) and, when wired, the self-restart
  // idle-tick check (spec 2026-08-03-daemon-self-restart-on-stale-code) —
  // both need the exact same graceful-shutdown path, so both get the same
  // closure rather than two restart mechanisms.
  const requestRestart = (reason: string) => {
    log('DAEMON', `restart requested (${reason}) — shutting down for KeepAlive respawn`)
    setTimeout(() => { void shutdown().finally(() => process.exit(0)) }, 500)
  }

  try {
    // Single shared chat-prefs instance for this daemon — both the reply
    // route (split behavior) and the /set command read/write through it.
    // A second instance would have a stale in-memory cache: the store's
    // write-through only protects its own writes, not cross-instance reads.
    const chatPrefs = makeChatPrefs(stateDir)
    // Single shared sticker-library instance for this daemon (image-stickers
    // plan) — backs the /v1/stickers* routes and the stickerTagsFor thunk
    // below. Mirrors chatPrefs above: a second instance would read a stale
    // in-memory index (write-through only protects its own writes).
    const stickerLib = makeStickerLib(stateDir)
    // 初始表情包 — a fresh install gets the bundled bear pack so CC can send
    // stickers from day one (empty-library-only; owner curation wins forever).
    {
      const packDir = starterStickersDir()
      if (packDir) seedStarterStickers(stickerLib, packDir, (t, l) => log(t, l))
    }
    // Single shared care-ledger instance for this daemon — mirrors chatPrefs
    // above. pushTick claims/reads it; the inbound path resets the no-reply
    // streak on every message. A second instance would have a stale
    // in-memory cache (write-through only protects its own writes).
    const careLedger = makeCareLedger(stateDir)
    // Single shared reply-sink registry (app-conversation-channel, voice arc
    // Stage 0) — the POST /v1/wechat/reply route captures into it when a
    // sink is open (Task 1); the companion-converse closure below (built
    // from wireMain's pipelineDeps) opens/closes it around a real turn
    // (Task 2). Both MUST share this one instance — a second instance would
    // never see the capture (same posture as chatPrefs/careLedger above).
    const replySinks = makeReplySinks()
    // 1. internal-api FIRST — bootstrap needs its baseUrl/token for MCP wiring
    const internalApi = await registerInternalApi({
      stateDir, daemonPid: process.pid, memory: memoryFS, db, projects: ilink.projects,
      getChatPrefs: (c) => chatPrefs.get(c),
      setChatPref: (c, p) => chatPrefs.set(c, p),
      stickers: stickerLib,
      replySinks,
      setUserName: (chatId, name) => ilink.setUserName(chatId, name),
      voice: { replyVoice: (c, t) => ilink.voice.replyVoice(c, t), saveConfig: (i) => ilink.voice.saveConfig(i), configStatus: () => ilink.voice.configStatus(), synthesizeSpeech: (t) => ilink.voice.synthesizeSpeech(t), transcribe: (a, m) => ilink.voice.transcribe!(a, m), saveSTTConfig: (i) => ilink.voice.saveSTTConfig!(i), sttStatus: () => ilink.voice.sttStatus!() },
      sharePage: (t, c, o) => ilink.sharePage(t, c, o), resurfacePage: (q) => ilink.resurfacePage(q),
      companion: { enable: () => ilink.companion.enable(), disable: () => ilink.companion.disable(), status: () => ilink.companion.status(), snooze: (m) => ilink.companion.snooze(m), setImportLocal: (e) => ilink.companion.setImportLocal(e) },
      ilink: { sendReply: (c, t) => ilink.sendMessage(c, t).then(r => r as { msgId: string; error?: string }), sendFile: (c, p) => ilink.sendFile(c, p), editMessage: (c, m, t) => ilink.editMessage(c, m, t), broadcast: (t, a) => ilink.broadcast(t, a) },
      prefix: { conversationStore, providerDisplayName, permissionMode: dangerously ? 'dangerously' as const : 'strict' as const },
      turns: turnRecordStore,
      // Live-session lister + heartbeat probe back the admin self-diagnosis
      // tools (GET /v1/sessions, ops fields in /v1/health). listSessions is a
      // thunk over bootRef because SessionManager is built by bootstrap below
      // (after this registration) — returns null until then, so the route 503s.
      listSessions: () => bootRef?.sessionManager?.list() ?? null,
      heartbeatFresh: () => isHeartbeatFresh(HEARTBEAT_PATH),
      // Subsystem degraded-boot (spec 2026-08-17) — sup 在本调用之前创建,
      // 直接传引用,无需 thunk-over-bootRef 姿势。
      subsystems: () => sup.statuses(),
      outbound: () => ilink.outboundHealth(),
      // Admin remediation hooks (POST /v1/sessions/release, /v1/daemon/restart).
      releaseSession: (k) => bootRef?.sessionManager?.release(k) ?? Promise.resolve(),
      requestRestart: () => requestRestart('internal-api'),
      // self-restart idle signal — thunk over bootRef for the same reason
      // listSessions above is one: internal-api is constructed BEFORE
      // bootstrap builds the activity marker. Until then it's a no-op,
      // which is correct — nothing can self-restart before bootstrap
      // finishes anyway.
      markInboundActivity: () => bootRef?.markInboundActivity?.(),
      // busy-registry hold (spec 2026-08-11 §2, Task 4 step 1 + Task 6) —
      // same thunk-over-bootRef posture as markInboundActivity/listSessions
      // above: internal-api is constructed BEFORE bootstrap builds the
      // busy registry, so calls that land before buildBootstrap resolves
      // get a no-op release (correct — nothing can be "busy" before
      // bootstrap finishes anyway). Backs BOTH the dispatcher's own
      // non-GET request hold (index.ts) and customer-review's task-launch
      // hold (routes-customer-review.ts) — they share this one field.
      holdBusy: (l) => bootRef?.holdBusy?.(l) ?? (() => {}),
      log: (t, l) => log(t, l),
      // LLM memory routes' chat_id default (spec 2026-07-23-daemon-owns-llm-
      // memory-ops): access.json's single admin. Wired eagerly (not late-
      // bound) — it only needs loadAccess + loadCompanionConfig, both
      // available before bootstrap runs. No initiatingChatId (null) since
      // this isn't scoped to any one session — mirrors the CLI's own
      // admin-resolution posture.
      resolveAdminChatId: () => resolveAdminChatId(loadAccess(), loadCompanionConfig(stateDir), null),
    })
    lc.register(internalApi)
    // 2. bootstrap composes provider registry / session manager / coordinator
    const boot = await buildBootstrap({
      stateDir, db, ilink, loadProjects: ilink.loadProjects,
      lastActiveChatId: ilink.lastActiveChatId, log: (t, l, f) => log(t, l, f),
      fallbackProject: () => ({ alias: '_default', path: process.cwd() }),
      dangerouslySkipPermissions: dangerously, conversationStore,
      // Session-serialization design, Task 2 Part B — same shared instance
      // passed to internal-api and wireMain below; makes the coordinator's
      // sendAssistantText fallback sink-aware.
      replySinks,
      onTurnRecord: (r) => turnRecordStore.append(r),
      mintSessionToken: internalApi.mintSessionToken,
      invalidateSession: internalApi.invalidateSession,
      internalApi: { baseUrl: internalApi.baseUrl, tokenFilePath: internalApi.tokenFilePath },
      // Proactive-care design §5/§7 — resolve this chat's effective care
      // level per-spawn (chat-prefs override ∪ default_chat_id fallback).
      // loadCompanionConfig is a cheap file read; acceptable per-spawn cost.
      careLevelFor: (c) => careLevel(c, chatPrefs.get(c), loadCompanionConfig(stateDir).default_chat_id ?? undefined),
      // onboarding-curiosity design §2 — sync because buildInstructions is
      // sync; cheap indexed COUNT per spawn (chat_id, direction indexed).
      newRelationshipFor: (c) => countInboundMessagesSync(db, c) < NEW_RELATIONSHIP_MSG_COUNT,
      // owner-onboarding design §C1 — companion-offer nudge. Delegates to
      // the pure companionOfferEligible predicate (fix round 1: the first
      // version of this thunk compared `c` directly against
      // `companion.default_chat_id`, which is ONLY ever set inside
      // companion_enable — on a fresh install default_chat_id is null, so
      // the offer could never fire until companion had already been
      // enabled once and later disabled. companionOfferEligible resolves
      // the owner chat via resolveAdminChatId (admins-membership-based)
      // instead, which fresh installs already have thanks to Task 3's
      // setup bootstrap, and is guest-safe by construction — see
      // offer-eligibility.ts's docstring). Threshold matches
      // newRelationshipFor's NEW_RELATIONSHIP_MSG_COUNT on the opposite
      // side, so the two prompt sections stay naturally mutually exclusive.
      companionOfferFor: (c) => companionOfferEligible({
        chatId: c,
        access: loadAccess(),
        companion: loadCompanionConfig(stateDir),
        inboundCount: countInboundMessagesSync(db, c),
      }),
      // bubble-replies design (行为流式气泡回复) — same per-chat 拆分 pref
      // that gates route-level mechanical splitting (getChatPrefs above)
      // also gates the bubble-guidance prompt section: `/set split off`
      // silences BOTH, matching the user-facing meaning of 拆分.
      bubbleRepliesFor: (c) => chatPrefs.get(c).split !== false,
      // image-stickers plan §5 / owner-onboarding design §C2 — per-chat
      // opt-out (chatPrefs.stickers === false) hides BOTH sticker sections
      // from that chat's prompt (null). Pref on ⇒ allTags(), which may
      // itself be [] (empty library — renders the cold-start unlock variant)
      // or non-empty (renders the normal tag-listing section). Returning
      // null (not []) for pref-off is the disambiguation this thunk exists
      // for — see prompt-builder.ts's BuildSystemPromptArgs.stickerTags doc.
      stickerTagsFor: (c) => (chatPrefs.get(c).stickers !== false ? stickerLib.allTags() : null),
      // persona design §2 — owner chat's persona.md content, read fresh per
      // spawn (hand-edit shows up with no daemon restart, like careLevelFor).
      // makeMemoryFS's constructor is cheap (existsSync + maybe mkdirSync +
      // one realpathSync) — same per-spawn-construction posture as
      // loadCompanionConfig above. cultivate is true only for the owner's
      // OWN chat, so the persona-cultivation write guidance never appears
      // in chats the owner is delegating/observing from elsewhere.
      personaFor: (c) => {
        const ownerChat = loadCompanionConfig(stateDir).default_chat_id
        if (!ownerChat) return {}
        // ownerChat feeds a filesystem join below, so accept only
        // chatId-shaped values — defense against a corrupted/hand-edited
        // companion config steering the memory root outside memory/.
        if (ownerChat.includes('..') || ownerChat.includes('/') || ownerChat.includes('\\')) return {}
        const fs = makeMemoryFS({ rootDir: join(stateDir, 'memory', ownerChat) })
        return { content: fs.read('persona.md') ?? undefined, cultivate: c === ownerChat }
      },
      // core-memory-injection design §2 — THIS chat's OWN profile.md
      // excerpt, read fresh per spawn (like personaFor above), capped to
      // CORE_MEMORY_MAX_CHARS. Unlike personaFor (owner chat via
      // default_chat_id), every chat reads its own memory/<chatId>/ dir —
      // there is no owner indirection here.
      coreMemoryFor: (c) => {
        const fs = makeMemoryFS({ rootDir: join(stateDir, 'memory', c) })
        const profile = fs.read('profile.md') ?? ''
        return profile.length > CORE_MEMORY_MAX_CHARS ? profile.slice(0, CORE_MEMORY_MAX_CHARS) : profile
      },
      // knowledge-distillation §2 — THIS chat's daemon-distilled knowledge.md
      // (objective plugin facts), read fresh per spawn + capped. Written by the
      // ingest tick for the owner chat; absent for chats without it.
      knowledgeMemoryFor: (c) => {
        const fs = makeMemoryFS({ rootDir: join(stateDir, 'memory', c) })
        const k = fs.read('knowledge.md') ?? ''
        return k.length > KNOWLEDGE_MEMORY_MAX_CHARS ? k.slice(0, KNOWLEDGE_MEMORY_MAX_CHARS) : k
      },
      // self-restart (spec 2026-08-03-daemon-self-restart-on-stale-code) —
      // same closure passed to internal-api's requestRestart above. Wiring
      // it here is what turns the mechanism ON: buildBootstrap reads git
      // HEAD once at boot and adds the idle-tick check ONLY when this is
      // present (see bootstrap/index.ts's self-restart block).
      //
      // Gated on SUPERVISED_ENV (WECHAT_CC_SUPERVISED), which `service
      // install` writes into the launchd plist / systemd unit — i.e.
      // exactly where a supervisor exists to relaunch us. Without it the
      // whole mechanism stays off, because "exit(0) and get restarted"
      // degrades to plain "exit(0)" wherever nothing is watching: a
      // foreground `bun cli.ts run` during debugging, or Windows, whose
      // scheduled task triggers AtLogOn with no restart semantics at all.
      // Since this feature is deliberately silent, that failure would read
      // to the owner as "the bot died again" with nothing in the log to
      // connect it to an update.
      ...(process.env[SUPERVISED_ENV] === '1'
        ? { requestRestart: () => requestRestart('self-restart-stale-code') }
        : {}),
      // Subsystem degraded-boot (spec 2026-08-17) — same supervisor instance
      // that already guards the post-bootstrap subsystems below (customer-
      // review/companion push/introspect/ingest/guard/mailbox-poller) now
      // also guards buildBootstrap's optional wire blocks (knowledge/social/
      // a2a-server/pairing/self-restart).
      supervisor: sup,
    })
    bootRef = boot
    internalApi.setDelegate({ dispatchOneShot: boot.dispatchDelegate, knownPeers: () => boot.registry.list() })
    // Wire conversation dep now that coordinator is available. Routes access
    // deps.conversation at request time, so this late assignment is safe.
    internalApi.setConversation({ setMode: (chatId, mode) => boot.coordinator.setMode(chatId, mode) })
    // Wire A2A deps — registry, client, recordEvent — so POST /v1/a2a/send works.
    // Undefined ⇔ a2a-server subsystem degraded (wireA2aServer threw) — setA2A
    // stays unwired and POST /v1/a2a/send keeps 503ing, same posture as any
    // other never-configured subsystem.
    if (boot.a2aDeps) internalApi.setA2A(boot.a2aDeps)
    // Wire the agent-social M1 broker (T7b-core) — only present when
    // social_enabled + social_disclosure_policy are both configured. So
    // POST /v1/social/seek/{propose,confirm,cancel} work when the feature is on.
    if (boot.social) internalApi.setSocial(boot.social)
    // Wire the Knowledge Kernel store + semanticSearch (Phase 01 T5) — only
    // present when knowledge_enabled is configured. Without this, every
    // /v1/knowledge/* route 503s knowledge_not_wired even though boot
    // already constructed the store (review finding: this call was missing
    // entirely — no setKnowledge existed on internalApi at all).
    if (boot.knowledge) internalApi.setKnowledge(boot.knowledge)
    // Customer Review is optional: a missing/unready wxvault or eval provider
    // leaves the daemon healthy and its owner-only routes return 503.
    const customerReview = await sup.start('customer-review', () => startCustomerReviewRuntime({
      stateDir,
      db,
      registry: boot.registry,
      defaultProviderId: boot.defaultProviderId,
      log: (tag, line) => log(tag, line),
    }))
    if (customerReview) {
      internalApi.setCustomerReview(customerReview.service)
      lc.register(customerReview)
    }
    // Wire the 配对码 engine (spec §7) — only present when mailbox_relays is
    // configured. So POST /v1/pair/start + /v1/pair/accept work when wired.
    if (boot.pairing) internalApi.setPairing(boot.pairing)
    // Wire the daemon-owned LLM memory ops (spec 2026-07-23-daemon-owns-llm-
    // memory-ops, Task 1's makeMemoryLlmOps) now that the coordinator +
    // provider registry are available. So POST /v1/memory/{synthesize,
    // profile/generate} work — this is now the ONLY place LLM memory ops
    // run (never the compiled CLI sidecar).
    internalApi.setMemory(makeMemoryLlmOps({
      stateDir, db, getMode: (c) => boot.coordinator.getMode(c), registry: boot.registry,
    }))
    // Wire the incident store (Task 8) — same live instance `wireHealth`
    // constructed inside buildBootstrap, so GET /v1/health/incidents (the
    // desktop's "last incident" banner + notification) reads what the
    // health runtime actually wrote, not a second stale copy.
    internalApi.setIncidents(boot.health.incidents)
    // LLM 通道体检 (llm-health.ts) — needs the registry, so late-bound like
    // setMemory above. NO boot probe and no timer (owner ruling 2026-08-25):
    // dialing happens ONLY when the user clicks 测试连接 — unprompted
    // automated outbound calls on a flaky network are a risk-control (封号)
    // shape. GET /v1/llm/health without ?fresh=1 never dials.
    {
      const { makeLlmHealth } = await import('./llm-health')
      const { capabilitiesFor } = await import('../core/capability-matrix')
      const llmHealth = makeLlmHealth({
        registry: boot.registry,
        defaultProviderId: boot.defaultProviderId,
        hintFor: (id) => capabilitiesFor(id).authFailHint,
        log,
      })
      internalApi.setLlmHealth(llmHealth, () => boot.registry.list())
    }
    // 3. main-wiring builds all deps for pipeline + lifecycles
    const wired = wireMain({
      stickers: stickerLib,
      requestRestart: (reason) => requestRestart(reason),
      stateDir, db, ilink, accounts, boot, dangerously, chatPrefs, careLedger, replySinks,
      // Task 11 — tick-bodies pass this to resolveTier() when computing
      // the companion's tierProfile. Same singleton import the bootstrap
      // coordinator uses; 5s TTL cache inside `loadAccess` keeps the
      // per-tick lookup cheap.
      loadAccess,
      log: (t, l) => log(t, l),
      schedulerIntervalMs: opts.schedulerIntervalMs,
    })
    // Wire companion-converse dep now that the coordinator (via boot) and
    // the pipeline wiring are available. Routes access deps.companionConverse
    // at request time, so this late assignment is safe (mirrors setConversation).
    internalApi.setCompanionConverse(wired.companionConverse)
    ticksRef = wired.ticks
    internalApi.setSettingsLink(wired.settingsPanelLink)
    const pipeline = buildInboundPipeline(wired.pipelineDeps)
    wireRef(wired.refs.pipeline, pipeline)
    // 4. register lifecycles (LIFO stop = startup order reversed)
    const pushLc = await sup.start('companion.push', () => registerCompanionPush(wired.companionPushDeps))
    if (pushLc) lc.register(pushLc)
    const introspectLc = await sup.start('companion.introspect', () => registerCompanionIntrospect(wired.companionIntrospectDeps))
    if (introspectLc) lc.register(introspectLc)
    const ingestLc = await sup.start('companion.ingest', () => registerIngest(wired.companionIngestDeps))
    if (ingestLc) {
      lc.register(ingestLc)
      wireRef(wired.refs.ingestNudge, ingestLc.nudge)   // inbound path nudges ingestion on fresh activity
    }
    const guardLc = await sup.start('guard', () => registerGuard(wired.guardDeps))
    if (guardLc) { wireRef(wired.refs.guard, guardLc); lc.register(guardLc) }
    lc.register(registerSessions(wired.sessionsDeps))
    lc.register(registerIlink(wired.ilinkDeps))
    const pollingLc = registerPolling({ ...wired.pollingDeps, runPipeline: pipeline })
    wireRef(wired.refs.polling, pollingLc); lc.register(pollingLc); pollingLcRef = pollingLc
    // Content-blind mailbox transport (Task 8) — mounted only when bootstrap
    // produced mailboxPollerDeps (social_enabled + at least one configured
    // mailbox_relays entry + a live onMailboxLetter). Absent ⇒ no poll timer,
    // no relay traffic — same "undefined ⇒ fully inert" posture as every
    // other optional companion/social wiring above.
    const mailboxLc = await sup.start('mailbox-poller',
      () => boot.mailboxPollerDeps ? registerMailboxPoller(boot.mailboxPollerDeps) : undefined)
    if (mailboxLc) lc.register(mailboxLc)
    // Reminder sweeper (spec 2026-08-20-reminders-port) — multi-user
    // precise-time delivery. Optional subsystem: a broken sweeper degrades,
    // never blocks boot. Store is db-backed so pending reminders survive
    // restarts; send goes through the live ilink adapter and checks .error
    // (sendMessage never rejects). No holdBusy needed: the tick INTERVAL is
    // 60s and the sweep BODY itself is sub-second, so a self-restart lands
    // between sweeps almost always. Worst case if a restart (or crash) lands
    // between a successful send and the markSent that follows it: at-least-
    // once delivery — the reminder is re-sent on the next sweep because the
    // row is still 'pending' — not a delay.
    const remindersLc = await sup.start('reminders', () => registerReminders({
      store: makeRemindersStore(db),
      send: async (chatId, text) => {
        const r = await ilink.sendMessage(chatId, text) as { msgId?: string; error?: string }
        return r.error ? { ok: false, error: r.error } : { ok: true }
      },
      log: (t, l) => log(t, l),
    }))
    if (remindersLc) lc.register(remindersLc)
    // 5. one-shot startup sweeps — fire-and-forget
    runStartupSweeps(wired.startupDeps)
    const modeStr = dangerously ? 'mode=dangerouslySkipPermissions=true (no WeChat permission prompts will fire)' : 'mode=strict (Phase 1 permission relay active)'
    log('DAEMON', `started pid=${process.pid} accounts=${accounts.length} ${modeStr}`)
    if (dangerously) log('DAEMON', 'warning: Claude will still confirm destructive ops via natural-language reply, but no permission prompts will appear.')
    // Subsystem degraded-boot (spec 2026-08-17 §3) — 启动完成后的一次性
    // 管理员汇总。只报 degraded(off 是常态,不扰人);发送失败只落日志,
    // 绝不影响启动结果。
    const degradedSubsystems = sup.degraded()
    if (degradedSubsystems.length > 0) {
      log('SUBSYS', `boot completed degraded: ${degradedSubsystems.map(d => `${d.name}(${d.error ?? '?'})`).join(', ')}`)
      const adminChatId = resolveAdminChatId(loadAccess(), loadCompanionConfig(stateDir), null)
      if (adminChatId) {
        const lines = degradedSubsystems.map(d => `- ${d.name}:${d.error ?? 'unknown'}`).join('\n')
        // ilink.sendMessage resolves { error } instead of rejecting (ilink-glue
        // swallows assertChatRoutable etc.), so the failure signal is the
        // resolved error field; keep .catch as belt-and-suspenders only.
        void ilink.sendMessage(adminChatId,
          `⚠️ 本次启动有 ${degradedSubsystems.length} 个子系统未能启动:\n${lines}\n核心收发不受影响;重启守护进程可重试。`,
        ).then(r => {
          if (r.error) log('SUBSYS', `admin degraded summary send failed: ${r.error}`)
        }).catch(err => log('SUBSYS', `admin degraded summary send failed: ${err instanceof Error ? err.message : String(err)}`))
      }
    }
    didStartup = true
  } catch (err) {
    log('DAEMON', `startup failed mid-init: ${err instanceof Error ? err.message : String(err)}`)
    await shutdown(); throw err
  }

  return {
    shutdown,
    pollingReconcile: pollingLcRef ? () => pollingLcRef!.reconcile() : undefined,
    fireTick: async (kind, at) => {
      const nowIso = at.toISOString()
      if (kind === 'push') await ticksRef!.pushTick({ nowIso })
      else await ticksRef!.introspectTick({ nowIso })
    },
  }
}

// CLI entry — sets up signal handlers, calls bootDaemon, waits. Exported so
// cli.ts's `run` command can call it explicitly. Previously cli.ts relied on
// `await import('./src/daemon/main.ts')` triggering a top-level main() via
// side-effect, but that broke the moment we added the e2e bootDaemon export
// and gated the side-effect on `import.meta.main` — when cli.ts imports this
// module, import.meta.main is false (standard ESM semantics), so no daemon
// would start. Compiled `wechat-cc-cli.exe run` would silently no-op.
import { existsSync as fsExistsSync, readFileSync as fsReadFileSync } from 'node:fs'
export async function main() {
  const stateDir = process.env.WECHAT_CC_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'wechat')
  // daemon.env — provider API keys' restart-surviving home (env-file.ts).
  // Loaded BEFORE bootDaemon so provider registration sees the keys; the
  // real environment always wins over the file. Key NAMES only in logs.
  try {
    const envPath = join(stateDir, 'daemon.env')
    if (fsExistsSync(envPath)) {
      const { parseEnvFile } = await import('../lib/env-file')
      const fileEnv = parseEnvFile(fsReadFileSync(envPath, 'utf8'))
      const applied = Object.keys(fileEnv).filter(k => process.env[k] === undefined)
      for (const k of applied) process.env[k] = fileEnv[k]!
      if (applied.length > 0) log('DAEMON', `daemon.env loaded: ${applied.join(', ')}`)
    }
  } catch (err) { log('DAEMON', `daemon.env load failed (continuing): ${err instanceof Error ? err.message : err}`) }
  const dangerously = process.argv.includes('--dangerously')
  let handle: DaemonHandle
  try { handle = await bootDaemon({ stateDir, dangerously }) } catch (err) { console.error('[wechat-cc] fatal:', err); process.exit(1) }
  process.on('beforeExit', (code) => log('DAEMON', `beforeExit code=${code}`))
  process.on('exit', (code) => log('DAEMON', `exit code=${code}`))
  process.on('uncaughtException', (err) => {
    log('DAEMON', `uncaughtException: ${errorDetails(err)}`)
    process.exit(1)
  })
  process.on('unhandledRejection', (reason) => {
    log('DAEMON', `unhandledRejection: ${errorDetails(reason)}`)
    process.exit(1)
  })
  let alreadyShuttingDown = false
  const cliShutdown = async (sig: string) => {
    if (alreadyShuttingDown) { log('DAEMON', `${sig} during shutdown — forcing exit`); process.exit(130) }
    alreadyShuttingDown = true; log('DAEMON', `${sig} received, shutting down`)
    await handle.shutdown(); process.exit(0)
  }
  process.on('SIGINT', () => void cliShutdown('SIGINT'))
  process.on('SIGTERM', () => void cliShutdown('SIGTERM'))
  process.on('SIGUSR1', () => { handle.pollingReconcile?.()?.catch(err => log('RECONCILE', `SIGUSR1 reconcile failed: ${err instanceof Error ? err.message : String(err)}`)) })
  // SIGUSR2 — fire a companion push tick now (instead of waiting for the ~20min
  // scheduler). Sent by `wechat-cc companion push`. See cli/companion-push.ts.
  process.on('SIGUSR2', () => {
    log('SCHED', 'SIGUSR2 — manual push tick requested')
    handle.fireTick('push', new Date()).catch(err => log('SCHED', `SIGUSR2 push tick failed: ${err instanceof Error ? err.message : String(err)}`))
  })
}

// Direct invocation: `bun src/daemon/main.ts` (dev mode). In compiled binaries
// the entry is cli.ts, which imports + calls main() explicitly, so this guard
// only matters for source-mode dev runs.
if (import.meta.main) {
  main().catch((err) => { console.error('[wechat-cc] fatal:', err); process.exit(1) })
}

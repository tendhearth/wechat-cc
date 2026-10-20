#!/usr/bin/env bun
import { makeBriefPrefs, makeBriefTurn } from './scheduled-jobs/brief'
import { parseAgenda, selectDue } from './companion/agenda'
import { localParts } from './memory/nightly-schedule'
import { formatOverseerToday } from '../core/overseer-today'
import { makeJobsStore, summarizeJobs } from '../core/scheduled-jobs-store'
import { registerScheduledJobs } from './scheduled-jobs/runner'
import { makeJobsCommand, chainReplyHandlers } from './scheduled-jobs/command'
import { makeProjectLessonsCommand } from './project-lessons-command'
import { makeProjectLessons } from '../core/workbench/project-lessons'
import { agendaReplyText, appBundleHasCalendarUsage, makeCalendar, makeCalendarCommand } from './calendar/calendar'
import { makeActivityLog } from './activity-log'
import { makeActivityCommand } from './activity/command'
import { listLetters } from './letters/archive'
import { collectActivity } from './cc-activity-source'
import { makeRecapTurn } from './scheduled-jobs/recap'
import { ACTIVITY_WINDOW_MS, buildActivity, type ActivityItem } from '../core/cc-activity'
import { makeFileStateStore as makeCliUpgradeStateStore } from '../core/cli-upgrade/state'
import { MEMORY_LOG_FILE, ownerMemoryRoot } from './memory/nightly'
import { pickJobExecutor } from './wiring/tick-bodies'
import { makeMatterStore } from '../core/matters/store'
if (!process.env.CLAUDE_CODE_ENTRYPOINT) { process.env.CLAUDE_CODE_ENTRYPOINT = 'sdk-ts' }
// 回环守卫(spec 2026-09-09-cli-hook-push §3):daemon 经 SDK 拉起的 claude / codex
// 继承这个环境,主人装的 hooks 在它们身上也会触发;`wechat-cc hook` 看到这个变量
// 就直接退出,不然 daemon 自己的每个回合都会被推回微信。
process.env.WECHAT_CC_DAEMON_CHILD = '1'
import { join } from 'node:path'
import selfPkg from '../../package.json' with { type: 'json' }
import { homedir } from 'node:os'
import { acquireInstanceLock, releaseInstanceLock, isHeartbeatFresh, writeHeartbeat, startHeartbeatTicker, HEARTBEAT_FILE, HEARTBEAT_STALE_MS } from './single-instance'
import { openDb } from '../lib/db'
import { LifecycleSet, Ref, wireRef } from '../lib/lifecycle'
import { log } from '../lib/log'
import { dedupeAccountsByUserId } from '../lib/dedupe-accounts'
import { loadAccess, AccessConfigCorruptError } from '../lib/access'
import { buildBootstrap, resolveAdminChatId } from './bootstrap'
import { makeMemoryFS } from './memory/fs-api'
import { makeMemoryLlmOps } from './memory-llm-ops'
import { CORE_MEMORY_MAX_CHARS, KNOWLEDGE_MEMORY_MAX_CHARS } from '../core/prompt-builder'
import { MEMORY_FILENAME, parseMemoryDoc, renderForPrompt } from './memory/curated-doc'
import { readDraftForPrompt } from './memory/today-draft'
import { makeConversationStore } from '../core/conversation-store'
import { makeTurnRecordStore } from '../core/turn-record-store'
import { providerDisplayName } from './provider-display-names'
import { loadAllAccounts, makeIlinkAdapter } from './ilink-glue'
import { registerInternalApi } from './internal-api/lifecycle'
import { runSelftestConverse } from './selftest'
import { startCliUpgrade } from './cli-upgrade/start'
import type { CliUpgrader } from '../core/cli-upgrade/engine'
import { makeMessagesStore } from '../lib/messages-store'
import { registerCompanionPush, registerCompanionIntrospect, registerIngest } from './companion/lifecycle'
import { registerGuard } from './guard/lifecycle'
import { makeGuardRuntime } from './guard/runtime'
import { registerPolling } from './polling-lifecycle'
import { registerSessions } from './sessions-lifecycle'
import { registerIlink } from './ilink-lifecycle'
import { registerMailboxPoller } from './bootstrap/wire-mailbox'
import { registerMemoryNightly } from './memory/nightly-lifecycle'
import { resolveCheapEval } from './memory-llm-ops'
import { wireLetters } from './bootstrap/wire-letters'
import { resolveClaudeBinary } from './bootstrap/claude-env'
import { registerReminders } from './reminders/sweeper'
import { makeRemindersStore } from './reminders/store'
import { registerReportSweeper } from './reports/sweeper'
import { makeReportOutboxStore } from './reports/outbox'
import { makeWorkbenchStore } from '../core/workbench/store'
import { buildInboundPipeline } from './inbound/build'
import { runStartupSweeps } from './startup-sweeps'
import { consumePreviousRunEvidence, markCleanShutdown, markPlannedRestart } from '../lib/restart-markers'
import { wireMain } from './wiring'
import type { TickBodies } from './wiring/tick-bodies'
import { makeChatPrefs } from './chat-prefs'
import { makeStickerLib, seedStarterStickers, starterStickersDir } from './stickers'
import { makeGiphyRelaySource, makeGiphySource } from './sticker-source'
import { makeStickerFeedback } from './sticker-feedback'
import { makeOutboundTaps } from './outbound-taps'
import { makePetSignals } from './pet-signals'
import { makeJournal } from '../core/journal-store'
import { makeReplySinks } from './reply-sinks'
import { makeReplyDeliveryRuntime } from './reply-delivery'
import { makeCareLedger } from './companion/care-ledger'
import { careLevel } from './companion/calibration'
import { loadCompanionConfig } from './companion/config'
import { makeSelfChangeGlue } from './self-change-glue'
import { makeCliEventHub, makeProjectNamer } from '../core/cli-events'
import { makeCliSessionStore } from '../core/cli-session-store'
import { makeCliPermissionRelay } from '../core/cli-permission-relay'
import { makePermissionGate, terminalAskAsync } from './permission-gate'
import { makePermissionDecisionsStore } from './permission-decisions-store'
import { defaultRunner, makeCliReplyHandler, makeCliReplyCore, makeHandReplyExecutor, readHead } from './cli-reply-handler'
import { withReplyRefs } from '../core/cli-session-digest'
import { makeOverseerTodaySource, TODAY_TERMINAL_LIMIT } from './overseer-today-source'
import { makeTerminalHooksService } from './terminal-hooks'
import { defaultTerminalHooksDeps } from '../cli/terminal-hooks'
import { makeCliPhoneActions } from './cli-phone-actions'
import { findLiveWindow, liveSessionIds, relayToWindow, transcriptStartCwd } from './claude-live-window'
import { makeCliHubAppPush, makeCliPermissionAsk, type AppPushOutlet } from './cli-app-push'
import { scopedSend } from './inbound/reply-scope'
import { makeBrainForwarder } from './cli-brain-forward'
import { makeRemoteReply } from './cli-remote-reply'
import { CliEventRequest, CliPermissionRequest } from './internal-api/schema'
import type { CliEvent } from '../core/cli-events'
import type { CliPermissionRequest as CliPermissionRequestT } from '../core/cli-permission-relay'
import { machineIdleSeconds } from '../lib/machine-idle'
import { notifyDesktop } from '../lib/desktop-notify'
import { hostname as osHostname } from 'node:os'
import { makeAtelierStore } from './atelier-store'
import { companionOfferEligible } from './companion/offer-eligibility'
import { countInboundMessagesSync, NEW_RELATIONSHIP_MSG_COUNT } from '../lib/messages-store'
import { startCustomerReviewRuntime } from './customer-review/runtime'
import { SUPERVISED_ENV } from '../core/supervised-env'
import { SubsystemSupervisor } from './subsystems'
import { removeAgyGlobalMcp } from './bootstrap/agy-mcp-config'
import {makeExecutionClaims} from '../core/workbench/execution-claims'
import {randomUUID as claimUuid, randomBytes} from 'node:crypto'
import { wireWorkbench } from './bootstrap/wire-workbench'
import {wireWorkbenchNotifications} from './bootstrap/wire-workbench-notifications'
import {wireWorkbenchArtifacts} from './bootstrap/wire-workbench-artifacts'
import { SUBSYSTEM_NAMES } from './capabilities'

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
  // 上一个进程是怎么停的(计划内纸条 / 优雅退出纸条 / 最后一跳心跳)——
  // **必须**在写本进程第一跳心跳之前读,否则停机时长就量成了 0。
  // 读完就删,结果交给 notify-startup 决定要不要在微信里说话。
  const previousRun = consumePreviousRunEvidence(stateDir)
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
  // CLI 自动升级引擎:bootstrap 之后才造,回合记录与工作台的报错触发先拿着这个引用。
  const cliUpgradeRef = new Ref<CliUpgrader>('cli-upgrade')
  // ConversationStore must be constructed BEFORE the ilink adapter —
  // PR5 Task 21 routes the adapter's setUserName/resolveUserName through
  // it, replacing the deprecated user_names.json store. Both legacy
  // conversations.json and user_names.json are backfilled here on first
  // boot and renamed to *.migrated when done.
  const conversationStore = makeConversationStore(db, {
    migrateFromFile: join(stateDir, 'conversations.json'),
    migrateFromUserNamesFile: join(stateDir, 'user_names.json'),
  })
  // 网络守护运行时(2026-10-02):闸门要比 ilink / internal-api / bootstrap 都先有 ——
  // 语音、provider registry、SessionManager、协调器、工作台都接它;guard 生命周期在后面才 start。
  const guardRt = makeGuardRuntime({ stateDir, log: (t, l) => log(t, l) })
  const ilink = makeIlinkAdapter({ stateDir, accounts, db, conversationStore, networkGate: guardRt.gate })
  const memoryFS = makeMemoryFS({ rootDir: join(stateDir, 'memory') })
  const lc = new LifecycleSet((tag, line) => log(tag, line))
  // Subsystem degraded-boot (spec 2026-08-17) — 只包可选子系统;核心链不经它。
  const sup = new SubsystemSupervisor((t, l) => log(t, l))
  let shuttingDown = false; let didStartup = false
  let pollingLcRef: { reconcile(): Promise<void> } | null = null
  let ticksRef: TickBodies | null = null
  const BOOT_AT_ISO = new Date().toISOString()
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
    // 给下次开机留一张「这次是计划内的」纸条:daemon 自己要求的重启(空闲加载
    // 新代码、换后端、运维 POST /v1/daemon/restart …)一律不在微信里播报。
    markPlannedRestart(stateDir, reason)
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
    const stickerFeedback = makeStickerFeedback(stateDir)
    const stickerLib = makeStickerLib(stateDir, { feedback: stickerFeedback })
    // Versioned CC pack adds missing stickers; existing collections are preserved.
    {
      const packDir = starterStickersDir()
      if (packDir) seedStarterStickers(stickerLib, packDir, (t, l) => log(t, l))
    }
    const giphyRelay = process.env.WECHAT_CC_GIPHY_RELAY_URL ?? 'https://wechat-cc-giphy-relay.moxiuwen-giphy.workers.dev/search'
    const giphyKey = process.env.WECHAT_CC_GIPHY_KEY
    const stickerSource = giphyKey ? makeGiphySource({ apiKey: giphyKey }) : makeGiphyRelaySource({ endpoint: giphyRelay })
    log('STICKERS', giphyKey ? 'online sticker source: GIPHY (local key)' : `online sticker source: GIPHY relay (${giphyRelay})`)
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
    // 打猎战利品(2026-09-03):旁听而非改道,见 outbound-taps.ts。同样必须是
    // **同一个实例** —— 开 tap 的是打猎那一拍(tick-bodies),往里写的是发送
    // 路径(internal-api reply 路由 / bootstrap 的 fallback);两个实例等于
    // 永远收不到东西,而且不会报任何错。
    const outboundTaps = makeOutboundTaps()
    // 回复交付(spec 2026-10-03-reply-delivery):daemon 负责送达的那一条路。同样必须是**同一个
    // 实例** —— 开轮的是协调器 / 伙伴推送,往里登记附件、旁听 legacy 出口的是 internal-api 与
    // fallback。第 0 步所有 provider 都还是 legacy,它只在 shadow 轮里记账。
    const replyDelivery = makeReplyDeliveryRuntime({
      sendText: (c, t) => ilink.sendMessage(c, t),
      sink: { captureReply: (c, r) => replySinks.captureReply?.(c, r) ?? false },
      isSinkOpen: (c) => replySinks.isOpen?.(c) ?? false,
      observe: (c, t) => outboundTaps.observe(c, t),
      chatPrefs: (c) => chatPrefs.get(c),
      log: (t, l, f) => log(t, l, f),
    })
    // 桌宠信号(spec 2026-09-05-cc-desktop-pet §5.1)。和 replySinks/outboundTaps
    // 同样的理由必须是**同一个实例**:写的三处分别在 bootstrap(tool_call、
    // 回合结束)、pipeline-deps(起飞、app 联系)与下面的权限 resolve;读的
    // 只有 GET /v1/companion/pet。纯内存,重启就忘 —— 描述的本来就只是当下。
    const petSignals = makePetSignals()
    const huntStore = makeJournal(db)
    // 一个消息库实例喂两个 dep(messages / latestInboundTs),下面 registerInternalApi 用。
    const messagesStore = makeMessagesStore(db)
    // 1. internal-api FIRST — bootstrap needs its baseUrl/token for MCP wiring
    const internalApi = await registerInternalApi({
      stateDir, daemonPid: process.pid, memory: memoryFS, db, projects: ilink.projects,
      atelier: makeAtelierStore(stateDir),
      getChatPrefs: (c) => chatPrefs.get(c),
      setChatPref: (c, p) => chatPrefs.set(c, p),
      stickers: stickerLib,
      stickerFeedback,
      stickerSource,
      replySinks,
      outboundTaps,
      replyDelivery,
      hunt: huntStore,
      // 待决权限的桌面面(spec §6)。和微信「y/n <hash>」共用 ilink 里那一份
      // PendingPermissions —— 从哪边拍板都算数,另一边随之失效。拍板本身也是
      // 「主人刚跟我说过话」的证据,所以成功时记一笔 contact。
      permissions: {
        list: () => ilink.listPendingPermissions(),
        resolve: (h, d) => { const ok = ilink.resolvePermission(h, d); if (ok) petSignals.noteContact(); return ok },
      },
      // 自改流水线的三个抓手(spec 2026-09-18-self-change-pipeline §daemon 侧)。
      // 流水线自己是 daemon 外面的一个 CLI 进程:它既没有 ilink 连接,也不知道
      // 主人是谁,所以「报进展 / 问 y-n / 查拍板」都经这三条回来。问出去的卡片
      // 和微信、桌面共用同一份 PendingPermissions —— 主人从哪边拍都算数。
      selfChange: makeSelfChangeGlue({
        ownerChatId: () => loadCompanionConfig(stateDir).default_chat_id ?? null,
        sendMessage: (c, t) => ilink.sendMessage(c, t),
        // 只登记、自己发卡:卡片发不出去时条目要留在登记处,好让主人从桌面
        // 权限卡或 `self change --approve <id>` 拍板(见 self-change-glue 顶注)。
        registerPending: (h, t, meta) => ilink.registerPendingPermission(h, t, meta),
        sweepPending: () => { ilink.sweepPendingPermissions() },
        codeOf: (h) => ilink.pendingPermissionCodeOf(h),
        newHash: () => randomBytes(8).toString('hex'),
        now: () => Date.now(),
        log: (line) => { log('SELF-CHANGE', line) },
      }),
      // chat_history 工具后端(provider-handoff 的逃生口)
      messages: { listRange: (c: string, o: { limit: number; beforeTs?: string }) => messagesStore.listRange(c, o), search: (c: string, q: string, l: number) => messagesStore.search(c, q, l) },
      // 桌宠状态的「主人真在跟我说话吗」证据(spec 2026-09-03 §2.1/§2.2)——
      // 同一个 store 实例,只认入站:伙伴自己的外发(打猎 / 关心推送 / 提醒)
      // 会 bump 会话的 lastUsedAt,但不该让熊说「在跟你聊」。
      latestInboundTs: (c: string) => messagesStore.latestInboundTs(c),
      setUserName: (chatId, name) => ilink.setUserName(chatId, name),
      voice: { replyVoice: (c, t) => ilink.voice.replyVoice(c, t), saveConfig: (i) => ilink.voice.saveConfig(i), configStatus: () => ilink.voice.configStatus(), synthesizeSpeech: (t) => ilink.voice.synthesizeSpeech(t), transcribe: (a, m) => ilink.voice.transcribe!(a, m), saveSTTConfig: (i) => ilink.voice.saveSTTConfig!(i), sttStatus: () => ilink.voice.sttStatus!() },
      sharePage: (t, c, o) => ilink.sharePage(t, c, o), resurfacePage: (q) => ilink.resurfacePage(q),
      companion: { enable: () => ilink.companion.enable(), disable: () => ilink.companion.disable(), status: () => ilink.companion.status(), snooze: (m) => ilink.companion.snooze(m), setImportLocal: (e) => ilink.companion.setImportLocal(e) },
      ilink: { sendReply: (c, t) => ilink.sendMessage(c, t).then(r => r as { msgId: string; error?: string }), sendFile: (c, p) => ilink.sendFile(c, p), noteSentMedia: (c, m) => ilink.noteSentMedia?.(c, m), editMessage: (c, m, t) => ilink.editMessage(c, m, t), broadcast: (t, a) => ilink.broadcast(t, a) },
      prefix: { conversationStore, providerDisplayName, permissionMode: dangerously ? 'dangerously' as const : 'strict' as const },
      turns: turnRecordStore,
      // Live-session lister + heartbeat probe back the admin self-diagnosis
      // tools (GET /v1/sessions, ops fields in /v1/health). listSessions is a
      // thunk over bootRef because SessionManager is built by bootstrap below
      // (after this registration) — returns null until then, so the route 503s.
      listSessions: () => bootRef?.sessionManager?.list() ?? null,
      heartbeatFresh: () => isHeartbeatFresh(HEARTBEAT_PATH),
      // 后台在跑的版本(2026-09-16):桌面更新器换入新 .app 后旧 daemon 不会被杀,
      // app 只有看到这个才知道后台还是旧的。head 是 thunk-over-bootRef(self-restart
      // 在 bootstrap 里才接线)。
      // codeHead 只在「从 git 检出跑」时有值(self-restart 才知道 head);打包产物里
      // 是 null,于是装机用户的健康输出永远认不出跑的是哪个构建 —— 退回编译期钉进去的
      // BUILD_SHA(源码跑时它是 'dev',那种情况下 codeHead 本来就有值)。
      version: () => ({ cli: APP_VERSION, head: bootRef?.codeHead ?? (BUILD_SHA === 'dev' ? null : BUILD_SHA), boot_at: BOOT_AT_ISO }),
      // Subsystem degraded-boot (spec 2026-08-17) — sup 在本调用之前创建,
      // 直接传引用,无需 thunk-over-bootRef 姿势。
      subsystems: () => sup.statuses(),
      // 网络守护此刻的判断(2026-10-02):safe=false ⇒ 所有模型调用暂停。
      guard: () => guardRt.health(),
      // 插件快照(2026-09-30):bootstrap 之前是 null,self deploy 的健康门会等它。
      plugins: () => bootRef?.pluginsHealth ?? null,
      // 开机探测失败、正在退避重探的外部 CLI provider(2026-10-04):bootstrap 之前是空表。
      providerProbes: () => bootRef?.providerProbes?.() ?? [],
      outbound: () => ilink.outboundHealth(),
      // Admin remediation hooks (POST /v1/sessions/release, /v1/daemon/restart).
      releaseSession: (k) => bootRef?.sessionManager?.release(k) ?? Promise.resolve(),
      // 换模型时把该 provider 的会话存档行删掉(同一条 thunk-over-bootRef 姿势):
      // 不删的话下一次 spawn 会 resume 回旧会话,新模型钉不上。
      forgetProviderSessions: (providerId) => bootRef?.sessionStore?.deleteProvider(providerId) ?? 0,
      // Self-maintenance (spec 2026-09-18-self-maintenance §1) — backs
      // POST /v1/selftest/converse. Unlike forgetProviderSessions/
      // listSessions above (which degrade to a harmless no-op/null when
      // bootRef isn't ready yet), a spawn is NOT safe/meaningful before
      // bootstrap builds the provider registry — so this thunk returns
      // `null` in that window instead of calling runSelftestConverse with
      // an empty registry stub, and the route maps `null` to 503
      // selftest_not_wired (same as the field being absent entirely) —
      // see the 未接线 503 contract in the spec and InternalApiDeps's
      // doc comment. Once bootRef exists, mintSessionToken/
      // invalidateSession close over the `internalApi` binding below:
      // those two are this SAME internal-api instance's own methods, not
      // bootstrap's, so there's no ordering problem there — by the time
      // any HTTP request can reach this handler, `internalApi` has long
      // since been assigned.
      selftestConverse: (input) => {
        if (!bootRef) return Promise.resolve(null)
        const registry = bootRef.registry
        return runSelftestConverse(
          {
            registry,
            mintSessionToken: (tier, key, opts) => internalApi.mintSessionToken(tier, key, opts),
            invalidateSession: (key) => internalApi.invalidateSession(key),
            log: (t, l) => log(t, l),
          },
          input,
        )
      },
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
      busyLabels: () => bootRef?.busyLabels?.() ?? [],
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
      stateDir, db, ilink, loadProjects: ilink.loadProjects, networkGate: guardRt.gate,
      lastActiveChatId: ilink.lastActiveChatId, log: (t, l, f) => log(t, l, f),
      fallbackProject: () => ({ alias: '_default', path: process.cwd() }),
      dangerouslySkipPermissions: dangerously, conversationStore,
      // Session-serialization design, Task 2 Part B — same shared instance
      // passed to internal-api and wireMain below; makes the coordinator's
      // sendAssistantText fallback sink-aware.
      replySinks,
      outboundTaps,
      replyDelivery,
      petSignals,
      onTurnRecord: (r) => {
        turnRecordStore.append(r)
        // CLI 自动升级的报错触发(2026-10-04):错误通道像「CLI 太旧」⇒ 排一次版本检查。
        if (r.outcome !== 'completed') cliUpgradeRef.current?.onTurnError(r.provider, r.errorCode, r.error)
      },
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
      // 每晚整理的长期记忆(2026-09-25):有 memory.md 就注入它(去尾注),prompt-builder 据此不再注入 profile.md。
      curatedMemoryFor: (c) => {
        const fs = makeMemoryFS({ rootDir: join(stateDir, 'memory', c) })
        const raw = fs.read(MEMORY_FILENAME)
        return raw ? renderForPrompt(parseMemoryDoc(raw)) : ''
      },
      // 今天的草稿(同日失忆修复,2026-10-01):CC 白天写进 profile.md 的新行,随 memory.md 一起注入。
      todayDraftFor: (c) => { try { return readDraftForPrompt(memoryFS, c) } catch { return '' } },
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
    // 守护 v2:health / 后台任务判断要知道「此刻配置 / 在用的 provider 是哪些、各用什么模型」。
    {
      const { makeMtimeCachedConfigReader } = await import('../lib/agent-config')
      const { providersInUse } = await import('./guard/targets')
      const { providerCallTarget } = await import('../core/provider-registry')
      const readCfg = makeMtimeCachedConfigReader(stateDir)
      // 评审 #193 P1-1:按 provider / 会话自己报的实际目标,不按此刻的配置推。
      guardRt.setProvidersInUse(() => providersInUse(
        (() => { try { return readCfg() } catch { return null } })(),
        boot.registry.list(),
        boot.sessionManager.list().map(s => ({ id: s.providerId, model: s.model ?? null, target: boot.sessionManager.effectiveTarget(s) })),
        (id) => providerCallTarget(boot.registry.get(id)?.provider, id, 'session'),
      ))
    }
    internalApi.setDelegate({ dispatchOneShot: boot.dispatchDelegate, knownPeers: () => boot.registry.list() })
    // Wire conversation dep now that coordinator is available. Routes access
    // deps.conversation at request time, so this late assignment is safe.
    internalApi.setConversation({ setMode: (chatId, mode) => boot.coordinator.setMode(chatId, mode) })
    // Wire A2A deps — registry, client, recordEvent — so POST /v1/a2a/send works.
    // Undefined ⇔ a2a-server subsystem degraded (wireA2aServer threw) — setA2A
    // stays unwired and POST /v1/a2a/send keeps 503ing, same posture as any
    // other never-configured subsystem.
    if (boot.a2aDeps) internalApi.setA2A(boot.a2aDeps)
    // Wire the social surface (笔友信道 + 心愿) — only present when
    // social_enabled + social_disclosure_policy are both configured. So
    // POST /v1/social/wish{,/send,/cancel} work when the feature is on.
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
    let llmHealth: import('./llm-health').LlmHealth | undefined
    {
      const { makeLlmHealth } = await import('./llm-health')
      const { capabilitiesFor } = await import('../core/capability-matrix')
      llmHealth = makeLlmHealth({
        registry: boot.registry,
        defaultProviderId: boot.defaultProviderId,
        hintFor: (id) => capabilitiesFor(id).authFailHint,
        log,
      })
      internalApi.setLlmHealth(llmHealth, () => boot.registry.list(), () => {
        // 自配 base_url:目前只有 openai-compatible 端点可指向国内/本地服务。
        // 网络体检据此探真实端点,而非硬编码的 api.openai.com。
        const eps: Record<string, string> = {}
        const b = boot.agentConfig.openaiBaseUrl
        if (b) eps.openai = b
        return eps
      })
    }
    // 3. main-wiring builds all deps for pipeline + lifecycles
    // 终端 claude / codex 会话的 hook 事件(spec 2026-09-09-cli-hook-push):压一段
    // 再推给主人,同会话再敲一句就撤。发到哪:与权限卡、A2A notify 同一个主人
    // chat;怎么发:boot.sendAssistantText(同一条外发,断线时它自己退避、这里不重试)。
    // 手机 app 推送出口:pipeline-deps(wireMain)里才造,这里先占位、建完再接上(cli-app-push.ts)。
    let cliAppPush: AppPushOutlet | null = null
    const cliEvents = makeCliEventHub({
      send: async (text) => {
        const owner = resolveAdminChatId(loadAccess(), loadCompanionConfig(stateDir), null)
        if (!owner || !boot.sendAssistantText) return 'no_target'
        return await boot.sendAssistantText(owner, text) ? 'sent' : 'rejected'
      },
      // 第二个出口:同一批、同一套在场判断,微信拒了手机照样收到。
      pushApp: makeCliHubAppPush({ push: () => cliAppPush, log: (t, l) => log(t, l) }),
      projectName: makeProjectNamer(() => ilink.projects.list()),
      log: (t, l) => log(t, l),
      // 在场的主信号:这台电脑上次键鼠输入距今多久。人在 ⇒ 系统通知;走了 ⇒ 微信。
      machineIdle: () => machineIdleSeconds(),
      notifyDesktop: (title, body) => notifyDesktop(title, body),
      // 超长的最后一句:全文进 share_page,微信里只放前一段 + 链接。
      sharePage: async (title, markdown) => {
        const owner = resolveAdminChatId(loadAccess(), loadCompanionConfig(stateDir), null)
        const r = await ilink.sharePage(title, markdown, owner ? { chat_id: owner } : undefined)
        return r.url
      },
      localMachine: osHostname(),
      // 终端会话登记处(v76):状态落库,重启后「看 码」「@码」照样认得;GET /v1/cli/sessions、手机都读它。
      store: makeCliSessionStore(db),
    })
    lc.register({ name: 'cli-events', stop: async () => cliEvents.dispose() })
    // 终端会话的权限 → 微信 y/n(同 spec §6.3)。复用 ilink.askUser,所以微信「y 码」、
    // 桌宠权限卡都能拍板 —— 一个权限,几个呈现面。主人在场(3 分钟内敲过字)就不问。
    // 放行规则(spec 2026-10-19-permission-rules-design):终端会话与一起做在问主人之前先问它。
    // 规则文件默认没有 / 关着 ⇒ 每条都是 ask,两处入口照旧。初审走 registry 的 cheapEval(自带网络守护)。
    const permissionDecisions = makePermissionDecisionsStore(db)
    const permissionGate = makePermissionGate({
      stateDir,
      store: permissionDecisions,
      cheapEval: () => boot.registry.getCheapEval(),
      notifyOwner: (text) => {
        const owner = resolveAdminChatId(loadAccess(), loadCompanionConfig(stateDir), null)
        if (owner) void ilink.sendMessage(owner, text)
      },
      log: (t, l) => log(t, l),
    })
    const cliPermissions = makeCliPermissionRelay({
      // 先推手机、再发微信卡;手机够得着 ⇒ 微信卡没送到(errcode=-2)也不作废码,手机照样拍板。
      ask: makeCliPermissionAsk({
        ownerChatId: () => resolveAdminChatId(loadAccess(), loadCompanionConfig(stateDir), null),
        askUser: (c, p, h, ms, o) => ilink.askUser(c, p, h, ms, o),
        registerPending: (h, ms, meta) => ilink.registerPendingPermission(h, ms, meta),
        sweepPending: () => ilink.sweepPendingPermissions(),
        push: () => cliAppPush,
        localMachine: osHostname(),
        log: (t, l) => log(t, l),
      }),
      presence: (s, idle) => cliEvents.presence(s, idle),
      projectName: makeProjectNamer(() => ilink.projects.list()),
      onRelayed: (s) => cliEvents.notePermissionRelay(s),
      onAsked: (req) => cliEvents.permissionAsked(req),
      onSettled: (s, status) => cliEvents.permissionSettled(s, status),
      log: (t, l) => log(t, l),
      localMachine: osHostname(),
      decide: async (req) => (await permissionGate.decide(() => terminalAskAsync(req))).verdict,
    })
    lc.register({ name: 'cli-permissions', stop: async () => cliPermissions.dispose() })
    // 这边 / 那边(§6.5)。手侧:配对时脑留了回叫的 url + key ⇒ 本机终端事件与权限请求
    // 转给脑,由脑决定发不发、发到哪;人就在这只手前的除外(本机桌面说一声)。
    // 脑侧:a2a 服务多三条路 —— 收手的事件 / 权限、把「看 / 说」派给手。
    const a2a = boot.a2aDeps
    const forwarder = a2a ? makeBrainForwarder({
      registry: a2a.registry, client: a2a.client, selfId: boot.selfId,
      notifyDesktop: (t, b) => notifyDesktop(t, b),
      projectName: makeProjectNamer(() => ilink.projects.list()),
      log: (t, l) => log(t, l),
    }) : null
    // 登记处列表 + 等批准那一项在微信里怎么回(中继开的 5 位码与卡片上的两位数码)。微信「终端」、
    // GET /v1/cli/sessions(桌面「此刻」、CC 的只读工具 terminal_sessions)都读这一份。
    let workbenchForToday: import('./overseer-today-source').TodayWorkbench | null = null
    const cliSessionViews = (opts?: { includeEnded?: boolean; limit?: number }) =>
      withReplyRefs(cliEvents.list(opts), (id) => cliPermissions.pendingHash(id), (h) => ilink.pendingPermissionCodeOf(h))
    internalApi.setCliEvents({
      // 转给脑的事件本机登记处也记一笔(observe 只记不推):这台机自己的列表也看得到。
      ingest: (ev) => {
        // 会话又有了动静(Stop / 新 prompt / 结束)⇒ 终端已自己答过,挂着的码作废(评审 10-15 #5)。
        if (ev.kind === 'stop' || ev.kind === 'prompt' || ev.kind === 'session_end') cliPermissions.expireSession(ev.session_id)
        if (!forwarder?.brain()) return cliEvents.ingest(ev)
        cliEvents.observe(ev)
        return forwarder.event(ev)
      },
      list: (opts) => cliSessionViews(opts),
    })
    internalApi.setCliPermissions({
      open: async (req) => {
        if (!forwarder?.brain()) return cliPermissions.open(req)
        const fwd = await forwarder.permissionOpen(req)
        if (!fwd) return cliPermissions.open(req)
        // 只有脑那边真开了码才记 waiting;主人在场(owner_present)就留给终端,不挂「等你批准」(评审 10-15 #1)。
        if (fwd.status === 'pending') cliEvents.permissionAsked(req)
        return fwd
      },
      status: (h) => cliPermissions.status(h),
      wait: (h, ms) => forwarder?.ownsHash(h) ? forwarder.permissionWait(h, ms) : cliPermissions.wait(h, ms),
    })
    const legacyClaims=makeExecutionClaims()
    const executionConflict=(s:import('../core/cli-events').CliSessionInfo)=>workbench?.conflictsExternal(s.cwd,s.source,s.session_id)??false
    const reserveExecution=(s:import('../core/cli-events').CliSessionInfo)=>{
      const release=legacyClaims.acquire({owner:claimUuid(),path:s.cwd,providerId:s.source,nativeId:s.session_id})
      // A legacy runner's early pipe return is not proof that its writer exited.
      return(closed:boolean)=>{if(closed)release()}
    }
    // 开在电脑窗口里的 Claude 会话(2026-10-18):说一句送进那个窗口,不另起 resume 副本;不开着时 resume 在会话起点的文件夹里起。
    // daemon 由 launchd 起,PATH 里没有 ~/.local/bin:发信小进程 / resume 用启动时解析出的 claude(device-e2e 10-20 真机)
    const claudeCli = resolveClaudeBinary()
    const liveWindow = {
      find: (s: import('../core/cli-events').CliSessionInfo) => findLiveWindow(s.session_id),
      relay: (w: import('./claude-live-window').LiveWindow, text: string) => relayToWindow(w, text, { run: defaultRunner, cwd: stateDir, dangerously, ...(claudeCli ? { bin: claudeCli } : {}) }),
    }
    const startCwd = (s: import('../core/cli-events').CliSessionInfo) => s.transcript_path ? transcriptStartCwd(readHead(s.transcript_path, 64 * 1024)) : null
    const replyCore = makeCliReplyCore({ executionConflict,reserveExecution,hub: cliEvents, holdBusy: (l) => boot.holdBusy(l), log: (t, l) => log(t, l), dangerously, ...(claudeCli ? { claudeBin: claudeCli } : {}), networkGate: guardRt.gate, liveWindow, startCwd })
    const handExecutor = makeHandReplyExecutor(replyCore, {
      hub: cliEvents,
      notifyBrain: async (text) => {
        const link = forwarder?.brain()
        if (!link || !a2a) throw new Error('no brain to notify')
        const r = await a2a.client.send({ url: `${link.url}/a2a/notify`, bearer: link.key, body: { agent_id: boot.selfId, text } })
        if (!r.ok) throw new Error(r.error ?? `http_${r.http_status ?? '?'}`)
      },
      log: (t, l) => log(t, l),
    })
    boot.a2aServer?.setCliHandlers({
      onEvent: async (agent, raw) => {
        const parsed = CliEventRequest.safeParse(raw)
        if (!parsed.success) return { ok: false, error: 'invalid_body' }
        const ev: CliEvent = { ...parsed.data, origin_agent: agent.id, machine: parsed.data.machine || agent.name }
        return { ok: true, action: cliEvents.ingest(ev) }
      },
      onPermissionOpen: async (agent, raw) => {
        const parsed = CliPermissionRequest.safeParse(raw)
        if (!parsed.success) return { error: 'invalid_body' }
        const req: CliPermissionRequestT = { ...parsed.data, machine: parsed.data.machine || agent.name }
        return cliPermissions.open(req, { forwarded: true })
      },
      onPermissionWait: async (_agent, hash, waitMs) => ({ hash, status: await cliPermissions.wait(hash, waitMs) }),
      onReply: async (_agent, req) => handExecutor(req),
    })
    // 「今天」一眼看完(2026-10-14):终端登记处 + 一起做,过去 24 小时。微信「日报」、GET /v1/overseer/today、
    // 手机 /m/api/today 读同一个函数。工作台在下面才建 ⇒ 晚绑定(调用时它早已就绪)。只读,只在被问时算。
    const overseerToday = makeOverseerTodaySource({
      terminal: () => cliSessionViews({ includeEnded: true, limit: TODAY_TERMINAL_LIMIT }),
      workbench: () => workbenchForToday,
      ccDecided: (since) => ({ ...permissionDecisions.countsSince(since), recent: permissionDecisions.since(since, 20) }),
      jobs: (since) => summarizeJobs(jobsStore, since),
      localMachine: osHostname(),
      log: (t, l) => log(t, l),
    })
    internalApi.setOverseerToday(overseerToday)
    // 接上终端里的 Claude Code / Codex(2026-10-14):「CC 现在怎么样」那一行 + 桌面「接上」/「修复」的路由。
    // 只在主人点了确认时写 hook 配置,绝不自动装。
    const terminalHooks = makeTerminalHooksService({ deps: defaultTerminalHooksDeps, sessions: () => cliEvents.list({ includeEnded: true, limit: 500 }) })
    internalApi.setCliHooks(terminalHooks)
    // 「看 码」「@码 文本」:主人对某条终端会话说话。只认主人;那边的会话 v1 先说明。
    // 定时任务的文件(spec 2026-10-20-scheduled-jobs-design):微信「定时」与每分钟一拍的 runner 共用一份。
    const jobsStore = makeJobsStore(stateDir)
    // 「CC 做过的事」(B9,spec 2026-10-20-cc-activity-design):没留记录的动作(主动说话 / 定时 / 提醒)补记一行,
    // 只记状态 + id;手机时间线把它和已有记录(规则批 / 一起做 / 终端 / 信 / 记忆 / CLI 升级)合起来。只算主人。
    const activityLog = makeActivityLog({ stateDir, now: () => Date.now(), log: (t, l) => log(t, l) })
    const activityOwner = () => resolveAdminChatId(loadAccess(), loadCompanionConfig(stateDir), null)
    const activity = {
      now: () => Date.now(),
      sources: () => {
        const since = Date.now() - ACTIVITY_WINDOW_MS
        return collectActivity({
          now: () => Date.now(), ownerChatId: activityOwner,
          decisions: () => permissionDecisions.since(since, 200),
          tasks: () => db.query<{ id: string; title: string; status: string; updatedAt: number; ownerChatId: string | null }, [number]>('SELECT id,title,status,updated_at AS updatedAt,owner_chat_id AS ownerChatId FROM workbench_tasks WHERE updated_at>=? ORDER BY updated_at DESC LIMIT 200').all(since),
          terminal: () => cliEvents.list({ includeEnded: true, limit: 200 }).filter(v => v.last_event_at >= since),
          letters: () => listLetters(stateDir),
          memoryLog: () => {
            const o = activityOwner(), root = o ? ownerMemoryRoot(stateDir, o) : null
            const f = root ? join(root, MEMORY_LOG_FILE) : null
            if (!f || !fsExistsSync(f)) return []
            return fsReadFileSync(f, 'utf8').split('\n').slice(-200).flatMap((l: string) => { try { const r = JSON.parse(l); return r && typeof r.at === 'string' ? [r] : [] } catch { return [] } })
          },
          log: () => activityLog.read(since),
          jobs: () => jobsStore.list().jobs,
          reminderText: (id) => {
            const o = activityOwner()
            return o ? db.query<{ text: string }, [string, string]>('SELECT text FROM reminders WHERE id=? AND chat_id=?').get(id, o)?.text ?? null : null
          },
          cliUpgrades: () => Object.entries(makeCliUpgradeStateStore(stateDir).load()).map(([cli, s]) => ({ cli, last: s.lastUpgrade ?? null })),
        })
      },
    }
    // 早报的口味(对标 #7):memory/<主人>/brief-prefs.md,「早报 少点 / 多点 …」写它。
    const briefOwner = () => resolveAdminChatId(loadAccess(), loadCompanionConfig(stateDir), null)
    const briefPrefs = makeBriefPrefs(() => { const o = briefOwner(); return o ? join(stateDir, 'memory', o) : null })
    // 微信「做过的事 [今天|本周]」(B9 在微信上):与手机时间线同一组来源,只认主人。
    const activityCommand = makeActivityCommand({
      isOwner: (chatId) => resolveAdminChatId(loadAccess(), loadCompanionConfig(stateDir), null) === chatId,
      say: (c, t) => ilink.sendMessage(c, t),
      now: () => Date.now(), timeZone: () => loadCompanionConfig(stateDir).timezone ?? 'Asia/Shanghai',
      items: () => { const r = buildActivity(activity.sources(), { now: Date.now(), limit: 100 }); return { items: r.items, degraded: r.degraded } },
    })
    // 微信「经验 <项目> …」(第二轮对标 ★2):项目经验,每家执行者都照着做。只认主人;项目按名字认。
    // 工作台在后面才接上(wireWorkbench);启动中途来的「经验」命令读到空的持有者 ⇒ 回「还在启动」,不碰 TDZ(评审 #443)
    const workbenchRef: { current: ReturnType<typeof wireWorkbench> | null } = { current: null }
    const lessonsCommand = makeProjectLessonsCommand({
      isOwner: (chatId) => resolveAdminChatId(loadAccess(), loadCompanionConfig(stateDir), null) === chatId,
      say: (c, t) => ilink.sendMessage(c, t),
      projects: () => workbenchRef.current ? workbenchRef.current.projects().map(p => ({ name: p.name, path: p.path })) : null,
      lessons: makeProjectLessons(stateDir),
    })
    const jobsCommand = makeJobsCommand({
      store: jobsStore,
      isOwner: (chatId) => resolveAdminChatId(loadAccess(), loadCompanionConfig(stateDir), null) === chatId,
      say: (c, t) => ilink.sendMessage(c, t),
      timezone: () => loadCompanionConfig(stateDir).timezone ?? 'Asia/Shanghai',
      now: () => Date.now(),
      log: (t, l) => log(t, l),
      jobExecutor: () => pickJobExecutor(id => boot.registry.has(id as never)),
      briefPrefs,
    })
    // 读日历和提醒(只读,spec 2026-10-20-calendar-read-design):默认关;「日历 开」才请求授权(Mac 上弹框)。
    // 只进主人的轮次:早报素材 + 「日历」命令 + admin 档的 calendar_agenda 工具;不给访客 / trusted / 定时会话工具面 / 社交。
    const calendar = makeCalendar({
      stateDir, run: defaultRunner, platform: process.platform,
      bundleHasUsage: () => appBundleHasCalendarUsage(process.execPath),
      now: () => Date.now(), timezone: () => loadCompanionConfig(stateDir).timezone ?? 'Asia/Shanghai',
      log: (t, l) => log(t, l),
    })
    // CC 的 calendar_agenda 工具(admin 档,只读):与「日历」命令同一段话。
    internalApi.setCalendarAgenda((offset) => agendaReplyText(calendar, offset))
    const calendarCommand = makeCalendarCommand({
      calendar,
      isOwner: (chatId) => resolveAdminChatId(loadAccess(), loadCompanionConfig(stateDir), null) === chatId,
      say: (c, t) => ilink.sendMessage(c, t),
    })
    const cliReplyHandler = makeCliReplyHandler({
      executionConflict,reserveExecution,
      hub: cliEvents,
      isOwner: (chatId) => resolveAdminChatId(loadAccess(), loadCompanionConfig(stateDir), null) === chatId,
      sendMessage: scopedSend((c: string, t: string) => ilink.sendMessage(c, t)),
      sharePage: async (title, md, chatId) => (await ilink.sharePage(title, md, { chat_id: chatId })).url,
      holdBusy: (l) => boot.holdBusy(l),
      log: (t, l) => log(t, l),
      dangerously,
      networkGate: guardRt.gate,
      liveWindow, startCwd,
      localMachine: osHostname(),
      listSessions: () => cliSessionViews({ limit: 50 }),
      today: overseerToday,
      ...(a2a ? { remote: makeRemoteReply({ registry: a2a.registry, client: a2a.client, selfId: boot.selfId }) } : {}),
    })
    // 「一件事」登记处:一份 store,工作台、微信入站、app 对话、内部 API 都用它(2026-09-16)。
    const matters = makeMatterStore(db)
    // 回报投递队列(v65,task-3,2026-09-23):每轮答复入队一次,sweeper 按到期时间取件送达。
    const reportOutbox = makeReportOutboxStore(db)
    const workbench = wireWorkbench({ db, stateDir, boot, internalApi, matters, reportOutbox, networkGate: guardRt.gate, permissionGate,
      onTurnError: (providerId, code, message) => { cliUpgradeRef.current?.onTurnError(providerId, code, message) },
      executionConflict:(path,providerId,nativeId)=>boot.sessionManager.hasProjectConflict(path)||
        (!!nativeId&&Object.values(boot.sessionStore.all()).some(s=>s.provider===providerId&&s.session_id===nativeId))||
        legacyClaims.conflicts({owner:'workbench',path,providerId,nativeId})||
        (!!nativeId&&cliEvents.sessions().some(s=>s.source===providerId&&s.session_id===nativeId&&!!s.origin_agent)), askUser: ilink.askUser, log: (t,l) => log(t,l) })
    boot.sessionManager.setExecutionGuard((path,providerId,nativeId)=>workbench.conflictsExternal(path,providerId,nativeId))
    internalApi.setWorkbench(workbench)
    workbenchForToday = workbench
    workbenchRef.current = workbench
    // 暂停在跑的任务(2026-10-03):health 的 guard 块 / `guard status` 列出被冻住的任务。
    guardRt.setSuspendedTasks(() => workbench.networkSuspended())
    lc.register({ name: 'workbench', stop: () => workbench.shutdown() })
    const wired = wireMain({
      workbench,
      cliSessions: () => cliEvents.list({ limit: 50 }),
      activity, activityLog,
      overseerToday,
      terminalHooks,
      // 手机拍板 / 说一句:拍板与微信「y/n 码」、桌宠权限卡同一份待批;说一句与微信「@码」同一个 core。
      cliActions: makeCliPhoneActions({
        hub: cliEvents, relay: cliPermissions, core: replyCore, localMachine: osHostname(), log: (t, l) => log(t, l), liveIds: () => liveSessionIds(),
        resolve: (h, d) => { const ok = ilink.resolvePermission(h, d); if (ok) petSignals.noteContact(); return ok },
      }),
      matters, guardRuntime: guardRt, subsystems: () => sup.statuses(),
      panelTokens: internalApi.panelTokens,
      cliReply: chainReplyHandlers([jobsCommand, calendarCommand, activityCommand, lessonsCommand, cliReplyHandler]),
      stickers: stickerLib,
      requestRestart: (reason) => requestRestart(reason),
      llmHealth,
      stateDir, db, ilink, accounts, boot, dangerously, chatPrefs, careLedger, replySinks,
      outboundTaps, huntStore, petSignals, replyDelivery,
      // 随身 CC 首屏:聊天日摘要读 turn_records;presence 走 internal-api 的共用入口。
      turns: turnRecordStore,
      presence: () => internalApi.getPresence(),
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
    // 「一件事」活动时间:先于工作台停(LIFO),退订 changes + 清节流定时器。
    lc.register({ name: 'matter-activity', stop: async () => wired.stopMatterActivity() })
    // 与手机页共用同一个「一件事」读写面(pipeline-deps 里建的那一个)。
    if (wired.mattersService) internalApi.setMatters(wired.mattersService)
    // 同上,桌宠的「在做什么」—— 组装闭包在 pipeline-deps(那里才有 boot)。
    internalApi.setPetTurn(wired.petTurn)
    ticksRef = wired.ticks
    cliAppPush = wired.appPush
    internalApi.setSettingsLink(wired.settingsPanelLink)
    internalApi.setConnections(wired.connections)
    internalApi.setPhoneConnect(wired.phoneConnect)
    const pipeline = buildInboundPipeline(wired.pipelineDeps)
    wireRef(wired.refs.pipeline, pipeline)
    wireRef(wired.refs.appTurn, pipeline.appTurn)
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
    // 外部 CLI provider 的退避重探计时器(2026-10-04)—— 关停时别再起探测、别再晚注册。
    lc.register({ name: 'provider-probes', stop: async () => { boot.stopProviderProbes?.() } })
    lc.register(registerSessions(wired.sessionsDeps))
    lc.register(registerIlink(wired.ilinkDeps))
    let workbenchNotifications:ReturnType<typeof wireWorkbenchNotifications>|undefined
    let workbenchArtifacts:ReturnType<typeof wireWorkbenchArtifacts>|undefined
    // Register before polling so shutdown stops inbound, drains task sends, then flushes ilink.
    lc.register({name:'workbench-notifications',stop:async()=>{await workbenchNotifications?.close()}})
    lc.register({name:'workbench-artifacts',stop:async()=>{await workbenchArtifacts?.close()}})
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
    // 每晚整理长期记忆 memory.md(2026-09-25)。15 分钟一次「该不该跑」,运行时在 pipeline-deps 造好。
    const memoryNightlyLc = await sup.start('memory-nightly', () => registerMemoryNightly({
      runtime: wired.memoryNightly, holdBusy: (l) => boot.holdBusy(l), log: (t, l) => log(t, l),
    }))
    if (memoryNightlyLc) lc.register(memoryNightlyLc)
    internalApi.setMemoryNightly(wired.memoryNightly)
    // CC 的信(2026-10-16):不定期写一封信、排成信纸寄到微信;主人说「给我写封信」时 cc_letter 工具当场写。
    // 开关 companion.letters_enabled 默认关。可选子系统:坏了只降级。
    const letters = wireLetters({
      stateDir, db,
      providerFor: (c) => { const m = boot.coordinator.getMode(c); return m && m.kind === 'solo' ? m.provider : undefined },
      strongEval: (id) => (typeof boot.registry.getStrongEval === 'function' ? boot.registry.getStrongEval(id as never) : null),
      cheapEval: (c) => resolveCheapEval({ getMode: (x) => boot.coordinator.getMode(x), registry: boot.registry }, c),
      wechatSuspended: () => boot.health.health.shouldSuspend('wechat'),
      sendText: (c, t) => ilink.sendMessage(c, t),
      // 逐页发不逐页记;寄出之后整封记成主人对话里的一行(App 对话页看得见),微信不通时寄到 App(2026-10-18)。
      sendFile: (c, f) => ilink.sendFile(c, f, { mirror: false }),
      mirror: (c, pages) => ilink.noteSentMedia?.(c, pages.map(path => ({ kind: 'file' as const, path }))),
      app: () => wired.companionApp,
      holdBusy: (l) => boot.holdBusy(l), log: (t, l) => log(t, l),
    })
    const lettersLc = await sup.start('letters', () => letters.start())
    if (lettersLc) lc.register(lettersLc)
    internalApi.setLetters(letters.runtime)
    // 外部 agent CLI 自动升级(主人 2026-10-04,docs/maintainer/cli-auto-upgrade.md):空闲时用官方升级器升、
    // 升完立刻自检、不过就退回 + 记坏版本 + 告诉主人一次。可选子系统:坏了只降级。
    const cliUpgrade = await sup.start('cli-upgrade', () => startCliUpgrade({
      stateDir, sessionManager: boot.sessionManager, busyLabels: () => boot.busyLabels(), holdBusy: (l) => boot.holdBusy(l),
      registry: boot.registry, networkGate: guardRt.gate,
      // 开机探测失败、正在重探的 provider:升完立刻重探一次,注册上再自检(#211)。
      reprobeProvider: (id) => boot.reprobeProvider?.(id) ?? Promise.resolve(null),
      mintSessionToken: (tier, key, o) => internalApi.mintSessionToken(tier, key, o),
      invalidateSession: (key) => internalApi.invalidateSession(key),
      sendOwner: async (text) => {
        const owner = resolveAdminChatId(loadAccess(), loadCompanionConfig(stateDir), null)
        if (!owner) return false
        const r = await ilink.sendMessage(owner, text) as { error?: string }
        return !r.error
      },
      notifyDesktop: (t, b) => notifyDesktop(t, b),
      log: (t, l) => log(t, l),
    }))
    if (cliUpgrade) { lc.register(cliUpgrade.lifecycle); wireRef(cliUpgradeRef, cliUpgrade.upgrader); internalApi.setCliUpgrade(cliUpgrade.upgrader) }
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
    // 2026-10-18:与伙伴推送同一条规矩 —— 微信能用走微信;不能用 / 发失败且 App 收得到(主人那条)⇒ 落到
    // App(记进对话 + 推一条 companion)。都不通 ⇒ 微信的错误原样回给 sweeper,退避照旧。
    const remindersLc = await sup.start('reminders', () => registerReminders({
      store: makeRemindersStore(db),
      send: async (chatId, text) => {
        const r = await wired.proactive.sendOnce(chatId, text)
        if (r.ok && r.channel === 'app') log('REMINDERS', `chat=${chatId} delivered to the app (wechat not usable)`)
        return r.ok ? { ok: true } : { ok: false, ...(r.error ? { error: r.error } : {}) }
      },
      log: (t, l) => log(t, l),
      activityLog,
      isOwner: (chatId: string) => resolveAdminChatId(loadAccess(), loadCompanionConfig(stateDir), null) === chatId,
    }))
    if (remindersLc) lc.register(remindersLc)
    // 主人亲手写的定时任务(spec 2026-10-20-scheduled-jobs-design):每分钟一拍,到点在只读的独立会话里跑一轮,
    // 走伙伴主动消息的出口;只给主人那条对话。坏了只降级,不挡启动。
    // 早报(spec 2026-10-20-morning-brief-design):素材在本机拼好 —— 日报原文、今天到期的提醒、agenda、口味;
    // 发出去了就记一次主动消息(careLedger.claim),当天的问候按它冷却,取代而不是叠加。
    const briefTz = () => loadCompanionConfig(stateDir).timezone ?? 'Asia/Shanghai'
    const briefTurn = makeBriefTurn({
      runJobTurn: (a) => wired.ticks.runJobTurn(a),
      ownerChatId: briefOwner,
      // 今天的日程和提醒事项:只在开着且授权时有;没授权 / 读失败 ⇒ 省略(不说成没安排)
      calendar: async () => { const a = await calendar.agenda(0); return a.ok && a.text ? a.text : null },
      today: () => {
        const t = overseerToday()
        const c = t.counts
        return c.needsYou + c.done + c.running + c.stuck === 0 ? null : formatOverseerToday(t)
      },
      reminders: async () => {
        const o = briefOwner()
        if (!o) return []
        const tz = briefTz(), today = localParts(Date.now(), tz).day
        return (await makeRemindersStore(db).list(o))
          .filter(r => r.status === 'pending' && localParts(Date.parse(r.due_at), tz).day === today)
          .map(r => ({ at: localParts(Date.parse(r.due_at), tz).hhmm, text: r.text }))
      },
      agenda: () => {
        const o = briefOwner()
        const f = o ? join(stateDir, 'memory', o, 'agenda.md') : null
        if (!f || !fsExistsSync(f)) return []
        return selectDue(parseAgenda(fsReadFileSync(f, 'utf8')), localParts(Date.now(), briefTz()).day).map(i => `${i.body}(期限 ${i.due})`)
      },
      prefs: () => briefPrefs.read(),
      claim: (c, iso) => { careLedger.claim(c, iso) },
    })
    // 周报(B9 之上):这一周「CC 做过的事」—— 与手机时间线同一组来源,翻几页收齐(最多 300 条)。
    const recapTurn = makeRecapTurn({
      runJobTurn: (a) => wired.ticks.runJobTurn(a),
      // 这一周各执行者自己报的用量(v82):「这周额度花在哪了」
      usage: (since) => makeWorkbenchStore(db).usage.sinceByProvider(since),
      ownerChatId: briefOwner, now: () => Date.now(), timeZone: briefTz,
      activity: () => {
        const src = activity.sources(), now = Date.now(), out: ActivityItem[] = []
        let cursor: string | null = null
        for (let page = 0; page < 3; page++) {
          const r = buildActivity(src, { now, limit: 100, cursor })
          out.push(...r.items)
          if (!r.next) break
          cursor = r.next
        }
        return out
      },
    })
    const jobsLc = await sup.start('scheduled-jobs', () => registerScheduledJobs({
      store: jobsStore,
      activityLog,
      timezone: () => loadCompanionConfig(stateDir).timezone ?? 'Asia/Shanghai',
      now: () => Date.now(),
      runTurn: async (job, nowIso) => {
        if (job.brief) return briefTurn(job, nowIso)
        if (job.recap) return recapTurn(job, nowIso)
        const owner = resolveAdminChatId(loadAccess(), loadCompanionConfig(stateDir), null)
        if (!owner) return 'skipped:no_owner'
        return wired.ticks.runJobTurn({ chatId: owner, jobId: job.id, text: job.text, nowIso })
      },
      notifyOwner: (text) => {
        const owner = resolveAdminChatId(loadAccess(), loadCompanionConfig(stateDir), null)
        if (owner) void wired.proactive.sendOnce(owner, text)
      },
      holdBusy: (l) => boot.holdBusy(l),
      log: (t, l) => log(t, l),
    }))
    if (jobsLc) lc.register(jobsLc)
    // 回报投递(task-3,2026-09-23):每轮答复回原对话说一声,人不在就等人回来
    // 再送(errcode=-2 不计入放弃窗口,保持 pending 退避重试)。同样是可选子
    // 系统:sweeper 坏了只降级,不挡启动。
    // 独立的一份 WorkbenchStore 实例,只用来给"放弃投递"这件事在那件事自己的
    // 时间线上留一笔(评审修复轮 3 ③)——同一个 db,跟 wireWorkbench 内部那份
    // 各自持有自己的预备语句,写入互相可见,不需要共享实例。
    const reportEventStore = makeWorkbenchStore(db)
    const reportsLc = await sup.start('reports', () => registerReportSweeper({
      store: reportOutbox,
      matters,
      send: async (chatId, text) => {
        const r = await ilink.sendMessage(chatId, text) as { msgId?: string; error?: string }
        return r.error ? { ok: false, error: r.error } : { ok: true }
      },
      log: (t, l) => log(t, l),
      noteAbandoned: (matterId, text) => {
        try { reportEventStore.addEvent(matterId, 'system', text) } catch { /* best effort — the drop itself already succeeded */ }
      },
    }))
    if (reportsLc) lc.register(reportsLc)
    // 5. one-shot startup sweeps — fire-and-forget
    runStartupSweeps({ ...wired.startupDeps, previousRun })
    // 外部集成反馈 #6:这个 flag 的语义像"跳过工具确认",实际是全局提权
    // (resolveEffectiveTier 对每个 allowlist 会话都返回 admin)。日志明说,
    // 让 operator 看清 blast radius;按会话生效见导图 [待]。
    const modeStr = dangerously
      ? 'mode=dangerouslySkipPermissions=true — 注意:此模式下所有 allowlist 会话均按 admin 处理(全局提权),不只是跳过确认'
      : 'mode=strict (Phase 1 permission relay active)'
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
        // 给主人看的是功能名(和「CC 现在怎么样」同一张表),原始错误只在上面那行日志里。
        const names = [...new Set(degradedSubsystems.map(d => SUBSYSTEM_NAMES[d.name] ?? d.name))].join('、')
        // ilink.sendMessage resolves { error } instead of rejecting (ilink-glue
        // swallows assertChatRoutable etc.), so the failure signal is the
        // resolved error field; keep .catch as belt-and-suspenders only.
        void ilink.sendMessage(adminChatId,
          `这次开机有几样没起来：${names}。其它功能照常。`,
        ).then(r => {
          if (r.error) log('SUBSYS', `admin degraded summary send failed: ${r.error}`)
        }).catch(err => log('SUBSYS', `admin degraded summary send failed: ${err instanceof Error ? err.message : String(err)}`))
      }
    }
    didStartup = true
    // The worker can arm timers immediately: construct only once partial-startup cleanup is active.
    workbenchNotifications=wireWorkbenchNotifications({workbench,ilink})
    workbenchArtifacts=wireWorkbenchArtifacts({workbench,ilink})
    void workbenchNotifications.wake().catch(()=>log('WORKBENCH','Task notifications are waiting for storage recovery.'))
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
import { resolveDaemonStateDir } from './resolve-state-dir'
import { APP_VERSION, BUILD_SHA } from '../lib/app-version'
export async function main() {
  const stateDir = resolveDaemonStateDir()
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
    // 有人让它停(launchctl kickstart -k / bootout、App 更新换包、注销关机)——
    // 先留纸条再收尾:哪怕收尾中途被 SIGKILL,下次开机也认得出这是计划内的。
    markCleanShutdown(stateDir, sig)
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
  // SIGWINCH — fire the daily introspection + optional Atelier tick now. This
  // is a local operator/testing control; the normal scheduler remains daily.
  process.on('SIGWINCH', () => {
    log('SCHED', 'SIGWINCH — manual introspect tick requested')
    handle.fireTick('introspect', new Date()).catch(err => log('SCHED', `SIGWINCH introspect tick failed: ${err instanceof Error ? err.message : String(err)}`))
  })
}

// Direct invocation: `bun src/daemon/main.ts` (dev mode). In compiled binaries
// the entry is cli.ts, which imports + calls main() explicitly, so this guard
// only matters for source-mode dev runs.
if (import.meta.main) {
  main().catch((err) => { console.error('[wechat-cc] fatal:', err); process.exit(1) })
}

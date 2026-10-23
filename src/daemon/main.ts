#!/usr/bin/env bun
import { startLifecycleModule, type LifecycleModuleHost } from './modules/lifecycle-module'
import { makeDaemonShutdown } from './runtime/shutdown'
import { makeJobsStore, summarizeJobs } from '../core/scheduled-jobs-store'
import { fromReplyHandler } from './commands/registry'
import { makeProjectLessonsCommand } from './project-lessons-command'
import { makeProjectLessons } from '../core/workbench/project-lessons'
import { makeMemoryImportCommand } from './memory/import-command'
import { agendaReplyText, appBundleHasCalendarUsage, makeCalendar, makeCalendarCommand } from './calendar/calendar'
import { makeMatterStore } from '../core/matters/store'
if (!process.env.CLAUDE_CODE_ENTRYPOINT) { process.env.CLAUDE_CODE_ENTRYPOINT = 'sdk-ts' }
// 回环守卫(spec 2026-09-09-cli-hook-push §3):daemon 经 SDK 拉起的 claude / codex
// 继承这个环境,主人装的 hooks 在它们身上也会触发;`wechat-cc hook` 看到这个变量
// 就直接退出,不然 daemon 自己的每个回合都会被推回微信。
process.env.WECHAT_CC_DAEMON_CHILD = '1'
import { join } from 'node:path'
import selfPkg from '../../package.json' with { type: 'json' }
import { homedir } from 'node:os'
import { acquireInstanceLockWaitingForShutdown, releaseInstanceLock, isHeartbeatFresh, writeHeartbeat, startHeartbeatTicker, HEARTBEAT_FILE, HEARTBEAT_STALE_MS, LOCK_WAIT_FOR_SHUTDOWN_MS } from './single-instance'
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
import { registerInternalApi, type InternalApiLifecycle } from './internal-api/lifecycle'
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
import { registerMemoryNightly } from './memory/nightly-lifecycle'
import { resolveCheapEval } from './memory-llm-ops'
import { wireLetters } from './bootstrap/wire-letters'
import { registerReminders, sendReminderVia } from './reminders/sweeper'
import { makeRemindersStore } from './reminders/store'
import { registerReportSweeper, sendReportVia } from './reports/sweeper'
import { makeReportOutboxStore } from './reports/outbox'
import { makeWorkbenchStore } from '../core/workbench/store'
import { buildInboundPipeline } from './inbound/build'
import { runStartupSweeps } from './startup-sweeps'
import { consumePreviousRunEvidence, markCleanShutdown, markPlannedRestart, peekCleanShutdown } from '../lib/restart-markers'
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
import { readOwnerDoc, renderOwnerForPrompt } from '../lib/memory-owner'
import { makeProviderRefusals } from './provider-refusals'
import { makeSelfChangeGlue } from './self-change-glue'
import { defaultRunner, makeCliReplyHandler } from './cli-reply-handler'
import { makeCliPhoneActions } from './cli-phone-actions'
import { liveSessionIds } from './claude-live-window'
import { scopedSend } from './inbound/reply-scope'
import { makeRemoteReply } from './cli-remote-reply'
import { notifyDesktop } from '../lib/desktop-notify'
import { hostname as osHostname } from 'node:os'
import { makeAtelierStore } from './atelier-store'
import { companionOfferEligible } from './companion/offer-eligibility'
import { countInboundMessagesSync, NEW_RELATIONSHIP_MSG_COUNT } from '../lib/messages-store'
import { SUPERVISED_ENV } from '../core/supervised-env'
import { SubsystemSupervisor } from './subsystems'
import { removeAgyGlobalMcp } from './bootstrap/agy-mcp-config'
import { randomBytes } from 'node:crypto'
import { wireWorkbench } from './bootstrap/wire-workbench'
import { wireCliSessions } from './bootstrap/wire-cli-sessions'
import { wireJobs } from './bootstrap/wire-jobs'
import { pinHuntForExistingOwner } from './companion/hunt-default'
import { makeTeardown } from './bootstrap/teardown'
import { startPendingFlush } from './speech/pending-notices'
import { wireActivity } from './bootstrap/wire-activity'
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
   * 收尾函数一建好就交出来(第三批 3b 第 2 步):开机途中收到 SIGTERM,信号处理拿它停掉已经起了的东西,
   * 不用等 bootDaemon 返回。以前信号处理在开机走完之后才装,开机途中收到 SIGTERM 就是默认行为:直接死,什么都不收。
   */
  onShutdownReady?: (shutdown: () => Promise<void>) => void
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
  // 主体 try 之前就失败(库打不开、迁移失败、ilink 适配器造不出来 ……)也要把锁、心跳、db 放掉:
  // main() 退出前会指数退避等上几十秒到 30 分钟,这段时间里锁还拿着,回滚拉起的老 sidecar / 手动 start 都抢不到
  // (重构第二批步 6a,wechat-cc-2a 评审)。都是幂等的:try 里失败时 shutdown 已经做过一遍也无妨。
  const undo: Array<() => void> = []
  try { return await bootDaemonInner(opts, undo) } catch (err) {
    for (const f of undo.reverse()) { try { f() } catch { /* 尽力 */ } }
    throw err
  }
}

async function bootDaemonInner(opts: BootDaemonOpts, undo: Array<() => void>): Promise<DaemonHandle> {
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
  // 撞上「上一个还在收尾」(launchctl kickstart -k:旧的还在停,新的已经起来)⇒ 等它退,最多 30 秒,别直接判失败
  // (以前每次都要退避 10 秒才起来)。判据是它开始优雅退出时自己写的纸条:pid 对得上、是这一分钟内写的。
  const lock = await acquireInstanceLockWaitingForShutdown(PID_PATH, {
    isHealthy: () => isHeartbeatFresh(HEARTBEAT_PATH, heartbeatStaleMs),
    holderShuttingDown: (pid) => { const m = peekCleanShutdown(stateDir); return !!m && m.pid === pid && Date.now() - m.ts < 2 * LOCK_WAIT_FOR_SHUTDOWN_MS },
    onWait: (pid) => log('DAEMON', `previous daemon pid=${pid} is still shutting down — waiting for it to exit (up to ${LOCK_WAIT_FOR_SHUTDOWN_MS / 1000}s)`),
  })
  if (!lock.ok) throw new Error(`[wechat-cc] ${lock.reason} (pid=${lock.pid})`)
  undo.push(() => releaseInstanceLock(PID_PATH))
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
  undo.push(stopHeartbeat)
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
      // 以前直接 process.exit(1),绕过了 main() 的退避 ⇒ access.json 坏了就是重启风暴。锁由外层放。
      process.stderr.write(`wechat channel: FATAL ${err.message}\n`)
    }
    throw err
  }
  const accounts = await loadAllAccounts(stateDir)
  if (accounts.length === 0) { releaseInstanceLock(PID_PATH); throw new Error('[wechat-cc] no accounts bound. Run `wechat-cc setup` first.') }
  const db = openDb({ path: join(stateDir, 'wechat-cc.db') })
  undo.push(() => db.close())
  // Per-turn observability store — written by the coordinator's recordTurn
  // (via bootstrap onTurnRecord) and read by internal-api GET /v1/turns.
  // Created here so both the internal-api registration and bootstrap below
  // share the one instance.
  const turnRecordStore = makeTurnRecordStore(db)
  // 执行者「真被拒着」(地区不可用):只看真回合,一轮真完成才清(provider-refusals.ts)
  const providerRefusals = makeProviderRefusals({ stateDir, log })
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
  // CC 开口那道门:wireMain 里才建,这里先占位(ilink 的权限卡、自改、终端会话都懒取它)
  const speechRef = new Ref<import('./speech/policy').SpeechPolicy>('speech')
  const ilink = makeIlinkAdapter({ stateDir, accounts, db, conversationStore, networkGate: guardRt.gate, speech: () => speechRef.current })
  const memoryFS = makeMemoryFS({ rootDir: join(stateDir, 'memory'), layout: 'all-chats' })
  const lc = new LifecycleSet((tag, line) => log(tag, line))
  // Subsystem degraded-boot (spec 2026-08-17) — 只包可选子系统;核心链不经它。
  const sup = new SubsystemSupervisor((t, l) => log(t, l))
  // 定时器那几样一行起一个模块(第三批 3b 第 5 步,modules/lifecycle-module.ts):停法登记在 lc 里它原来那一行的位置,停的顺序不变
  const moduleHost: LifecycleModuleHost = { sup, log: (t, l) => log(t, l), register: (name, stop) => lc.register({ name, stop }) }
  let pollingLcRef: { reconcile(): Promise<void>; bootSummary(): { eligible: number; started: number } } | null = null
  let ticksRef: TickBodies | null = null
  const BOOT_AT_ISO = new Date().toISOString()
  let bootRef: import('./bootstrap').Bootstrap | null = null

  // bootstrap 起的定时器 / 连接的收尾清单(bootstrap/teardown.ts):在这里建、直接交给 shutdown,启动半路失败也停得到。
  const bootTeardown = makeTeardown()
  // CC 开口那道门在 wireMain 里才造;bootstrap 里的社交通知比它早接线、晚发 ⇒ 用 Ref 交过去(只 set 一次)。
  // 收尾(重构第二批步 6a,runtime/shutdown.ts):不管启动有没有走完,都按倒序停已登记的子系统。
  const shutdown = makeDaemonShutdown({
    log: (t, l) => log(t, l),
    stopHeartbeat,
    lc,
    teardown: bootTeardown,
    boot: () => bootRef,
    removeAgyGlobalMcp: () => removeAgyGlobalMcp({ log }),
    closeDb: () => db.close(),
    releaseLock: () => releaseInstanceLock(PID_PATH),
  })
  opts.onShutdownReady?.(shutdown)

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
    // 这也是一次优雅退出:留优雅退出纸条(restart-markers 本来就这么写的,代码以前漏了),
    // 下一个进程撞上锁时才认得出「它在收尾」、等它退(single-instance acquireInstanceLockWaitingForShutdown)
    markCleanShutdown(stateDir, `restart:${reason}`)
    setTimeout(() => { void shutdown().finally(() => process.exit(0)) }, 500)
  }

  try {
    // Single shared chat-prefs instance for this daemon — both the reply
    // route (split behavior) and the /set command read/write through it.
    // A second instance would have a stale in-memory cache: the store's
    // write-through only protects its own writes, not cross-instance reads.
    const chatPrefs = makeChatPrefs(stateDir)
    // 打猎改成默认关(收敛清单 ②,主人 10-21 定):第一次带着新默认开机时,把正在每天打猎的主人(主动关心开着、没单独设过)
    // 写成显式的开,不让他跟着被关掉。只做一次(companion/hunt-default.ts);在任何伙伴 tick 之前。
    pinHuntForExistingOwner({ stateDir, chatPrefs, log: (t, l) => log(t, l) })
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
    // 核心链就地搬家第 2 步(设计稿 2026-10-23-core-chain-modules):停法登记在原来 lc.register(internalApi) 那一行的位置
    // (中间没有别的登记),关机顺序不变;起不来照旧整个开机失败。
    const internalApi: InternalApiLifecycle = (await startLifecycleModule(moduleHost, 'internal-api', () => registerInternalApi({
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
        speech: () => speechRef.current,
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
      // 微信回复前缀用短名;两种 Gemini 都开着时要分得开,所以按现在注册了谁来解析(收敛清单 ⑥)
      prefix: { conversationStore, providerDisplayName: (id) => providerDisplayName(id, bootRef?.registry.list() ?? []), permissionMode: dangerously ? 'dangerously' as const : 'strict' as const },
      turns: turnRecordStore,
      // Live-session lister + heartbeat probe back the admin self-diagnosis
      // tools (GET /v1/sessions, ops fields in /v1/health). listSessions is a
      // thunk over bootRef because SessionManager is built by bootstrap below
      // (after this registration) — returns null until then, so the route 503s.
      listSessions: () => bootRef?.sessionManager?.list() ?? null,
      heartbeatFresh: () => isHeartbeatFresh(HEARTBEAT_PATH),
      polling: () => pollingLcRef?.bootSummary() ?? null,
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
      providerRefusals: () => providerRefusals.all(),
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
      // non-GET request hold (index.ts) — and anything else that launches long work through internal-api.
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
    }), { required: true }))!
    // 2. bootstrap composes provider registry / session manager / coordinator
    const boot = await buildBootstrap({
      stateDir, db, ilink, loadProjects: ilink.loadProjects, networkGate: guardRt.gate, teardown: bootTeardown, speech: () => speechRef.current,
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
        providerRefusals.onTurn(r)
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
      // 主人原话(记忆编辑设计稿 2026-10-23 §1):只在主人自己的对话里注入,访客 / trusted 的对话读不到。
      ownerMemoryFor: (c) => {
        if (c !== loadCompanionConfig(stateDir).default_chat_id) return ''
        return renderOwnerForPrompt(readOwnerDoc(join(stateDir, 'memory', c)))
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
    internalApi.provide({ delegate: { dispatchOneShot: boot.dispatchDelegate, knownPeers: () => boot.registry.list() } })
    // Wire conversation dep now that coordinator is available. Routes access
    // deps.conversation at request time, so this late assignment is safe.
    internalApi.provide({ conversation: { setMode: (chatId, mode) => boot.coordinator.setMode(chatId, mode) } })
    // Wire A2A deps — registry, client, recordEvent — so POST /v1/a2a/send works.
    // Undefined ⇔ a2a-server subsystem degraded (wireA2aServer threw) — setA2A
    // stays unwired and POST /v1/a2a/send keeps 503ing, same posture as any
    // other never-configured subsystem.
    if (boot.a2aDeps) internalApi.provide({ a2a: boot.a2aDeps })
    // Wire the social surface (笔友信道 + 心愿) — only present when
    // social_enabled + social_disclosure_policy are both configured. So
    // POST /v1/social/wish{,/send,/cancel} work when the feature is on.
    if (boot.social) internalApi.provide({ social: boot.social })
    // Wire the Knowledge Kernel store + semanticSearch (Phase 01 T5) — only
    // present when knowledge_enabled is configured. Without this, every
    // /v1/knowledge/* route 503s knowledge_not_wired even though boot
    // already constructed the store (review finding: this call was missing
    // entirely — no setKnowledge existed on internalApi at all).
    if (boot.knowledge) internalApi.provide({ knowledge: boot.knowledge })
    // Wire the 配对码 engine (spec §7) — only present when mailbox_relays is
    // configured. So POST /v1/pair/start + /v1/pair/accept work when wired.
    if (boot.pairing) internalApi.provide({ pairing: boot.pairing })
    // Wire the daemon-owned LLM memory ops (spec 2026-07-23-daemon-owns-llm-
    // memory-ops, Task 1's makeMemoryLlmOps) now that the coordinator +
    // provider registry are available. So POST /v1/memory/{synthesize,
    // profile/generate} work — this is now the ONLY place LLM memory ops
    // run (never the compiled CLI sidecar).
    internalApi.provide({ memoryLlm: makeMemoryLlmOps({
      stateDir, db, getMode: (c) => boot.coordinator.getMode(c), registry: boot.registry,
    }) })
    // Wire the incident store (Task 8) — same live instance `wireHealth`
    // constructed inside buildBootstrap, so GET /v1/health/incidents (the
    // desktop's "last incident" banner + notification) reads what the
    // health runtime actually wrote, not a second stale copy.
    internalApi.provide({ incidents: boot.health.incidents })
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
      internalApi.provide({ llmHealth: llmHealth, llmRegistered: () => boot.registry.list(), llmNames: (id) => boot.registry.namesOf(id), llmEndpoints: () => {
        // 自配 base_url:目前只有 openai-compatible 端点可指向国内/本地服务。
        // 网络体检据此探真实端点,而非硬编码的 api.openai.com。
        const eps: Record<string, string> = {}
        const b = boot.agentConfig.openaiBaseUrl
        if (b) eps.openai = b
        return eps
      } })
    }
    // 3. main-wiring builds all deps for pipeline + lifecycles
    // 工作台在后面才接上(wireWorkbench):经持有者取,没就绪时各处按「还没有」处理(TDZ,评审 #443 / 重构第二批步 6a)
    const workbenchRef: { current: ReturnType<typeof wireWorkbench> | null } = { current: null }
    // wireMain 在后面;导入记忆写入要它的 memoryNightly ⇒ 同样经持有者取(没就绪 ⇒ 这次没记上)
    const wiredRef: { current: ReturnType<typeof wireMain> | null } = { current: null }
    const jobsStore = makeJobsStore(stateDir)
    // 终端会话(重构第二批步 6c,bootstrap/wire-cli-sessions.ts)
    const cli = wireCliSessions({
      speech: () => speechRef.current,
      stateDir, dangerously, db, ilink, lc, internalApi, boot, networkGate: guardRt.gate,
      workbench: () => workbenchRef.current,
      jobsSince: (since) => summarizeJobs(jobsStore, since),
    })
    const { cliEvents, cliPermissions, replyCore, permissionDecisions, permissionGate, cliSessionViews,
      legacyClaims, executionConflict, reserveExecution, liveWindow, startCwd, overseerToday, terminalHooks } = cli
    const a2a = boot.a2aDeps
    // 「CC 做过的事」(重构第二批步 6c,bootstrap/wire-activity.ts):手机时间线 / 微信「做过的事」/ 周报共用一组来源。
    const { activityLog, activity, command: activityCommand } = wireActivity({ stateDir, db, ilink, permissionDecisions, cliEvents, jobsStore })
    // 微信「经验 <项目> …」(第二轮对标 ★2):项目经验,每家执行者都照着做。只认主人;项目按名字认。
    const projectLessons = makeProjectLessons(stateDir)
    const lessonsCommand = makeProjectLessonsCommand({
      isOwner: (chatId) => resolveAdminChatId(loadAccess(), loadCompanionConfig(stateDir), null) === chatId,
      say: (c, t) => ilink.sendMessage(c, t),
      projects: () => workbenchRef.current ? workbenchRef.current.projects().map(p => ({ name: p.name, path: p.path })) : null,
      lessons: projectLessons,
    })
    // 微信「导入记忆」(第二轮对标 #7):主人把别的助手对他的了解贴回来,点头的才写进记忆。只认主人。
    // wired 在下面才建好;这里只在主人真用时才调,那时早已就绪。
    const memoryImportCommand = makeMemoryImportCommand({
      isOwner: (chatId) => resolveAdminChatId(loadAccess(), loadCompanionConfig(stateDir), null) === chatId,
      say: (c, t) => ilink.sendMessage(c, t),
      now: () => Date.now(),
      importEntries: (items, label) => { if (!wiredRef.current) throw new Error('memory_not_wired'); return wiredRef.current.memoryNightly.importEntries(items, label) },
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
    internalApi.provide({ calendarAgenda: (offset) => agendaReplyText(calendar, offset) })
    const calendarCommand = makeCalendarCommand({
      calendar,
      isOwner: (chatId) => resolveAdminChatId(loadAccess(), loadCompanionConfig(stateDir), null) === chatId,
      say: (c, t) => ilink.sendMessage(c, t),
    })
    // 定时 / 早报 / 周报 / 换一家来审(重构第二批步 6c,bootstrap/wire-jobs.ts):命令现在就要(进命令表),
    // 每分钟一拍的 runner 要 wireMain 之后的只读轮 ⇒ 先建、后 start()。只读轮经 wiredRef 取,没就绪 ⇒ 抛 not_wired。
    const jobs = wireJobs({
      stateDir, db, ilink, boot, sup, lc, jobsStore, activityLog, activity, calendar, overseerToday, careLedger,
      quietWindow: () => { const o = resolveAdminChatId(loadAccess(), loadCompanionConfig(stateDir), null); return o ? chatPrefs.get(o).quiet : undefined },
      // async:没就绪时是一个被拒的 promise,不是同步抛 —— requestReview 的 .catch 接得住,照实告诉主人「没审成」
      runJobTurn: async (a) => { if (!wiredRef.current) throw new Error('jobs_not_wired'); return wiredRef.current.ticks.runJobTurn(a) },
      // 定时那边的一句(连续失败被暂停 …)经 CC 开口那道门(第三批 3a,job_notice 归 report)
      sendProactive: (chatId, text, kind = 'job_notice') => {
        if (!wiredRef.current) { log('JOBS', `proactive send dropped (not wired yet) chat=${chatId}`); return }
        void wiredRef.current.speech.tell(kind, chatId, text)
      },
    })
    const jobsCommand = jobs.command
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
    // 核心链就地搬进模块容器的第 1 步(设计稿 2026-10-23-core-chain-modules):停法登记在原来 lc.register 那一行的位置,
    // 关机顺序不变;起不来照旧整个开机失败(required)。状态进 /v1/health.subsystems。
    const workbenchLc = await startLifecycleModule(moduleHost, 'workbench', () => {
      const service = wireWorkbench({ db, stateDir, boot, internalApi, matters, reportOutbox, networkGate: guardRt.gate, permissionGate, requestReview: (r) => jobs.requestReview(r),
      onTurnError: (providerId, code, message) => {
        cliUpgradeRef.current?.onTurnError(providerId, code, message)
        // 一起做里被拒也算(只有 agy 用一起做时,大脑那一行不该落后)
        providerRefusals.onTurn({ provider: providerId, outcome: 'error', ...(code ? { errorCode: code } : {}), endedAt: Date.now() })
      },
      onTurnCompleted: (providerId) => providerRefusals.onTurn({ provider: providerId, outcome: 'completed', endedAt: Date.now() }),
      providerRefusal: (providerId) => providerRefusals.get(providerId),
      executionConflict:(path,providerId,nativeId)=>boot.sessionManager.hasProjectConflict(path)||
        (!!nativeId&&Object.values(boot.sessionStore.all()).some(s=>s.provider===providerId&&s.session_id===nativeId))||
        legacyClaims.conflicts({owner:'workbench',path,providerId,nativeId})||
        (!!nativeId&&cliEvents.sessions().some(s=>s.source===providerId&&s.session_id===nativeId&&!!s.origin_agent)), askUser: ilink.askUser, log: (t,l) => log(t,l) })
      return { name: 'workbench', stop: () => service.shutdown(), service }
    }, { required: true })
    const workbench = workbenchLc!.service
    boot.sessionManager.setExecutionGuard((path,providerId,nativeId)=>workbench.conflictsExternal(path,providerId,nativeId))
    internalApi.provide({ workbench: workbench })
    workbenchRef.current = workbench
    // 暂停在跑的任务(2026-10-03):health 的 guard 块 / `guard status` 列出被冻住的任务。
    guardRt.setSuspendedTasks(() => workbench.networkSuspended())
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
      matters, guardRuntime: guardRt, subsystems: () => sup.statuses(), providerRefusals: () => providerRefusals.all(),
      panelTokens: internalApi.panelTokens,
      // 命令表的顺序就是优先级(重构第二批步 2;与原来文本命令链的顺序一致)
      commands: [fromReplyHandler('jobs', jobsCommand), fromReplyHandler('calendar', calendarCommand), fromReplyHandler('activity', activityCommand), fromReplyHandler('lessons', lessonsCommand), fromReplyHandler('memory-import', memoryImportCommand), fromReplyHandler('cli', cliReplyHandler, { ownsSlash: (m) => /^\s*\/(?:cli|today)\s*[?？]?\s*$/i.test(m.text ?? '') })],
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
    internalApi.provide({ companionConverse: wired.companionConverse })
    // 「一件事」活动时间:先于工作台停(LIFO),退订 changes + 清节流定时器。
    lc.register({ name: 'matter-activity', stop: async () => wired.stopMatterActivity() })
    // 手机那一簇(隧道 / notifier / 订阅 / 设置面板,重构第二批步 6d):登记在 polling 之前 ⇒ 倒序时入站先停,
    // App 在途的回复还能经隧道送完(App 的入站本身也走隧道)。
    lc.register({ name: 'phone', stop: () => wired.stopPhone() })
    // 与手机页共用同一个「一件事」读写面(pipeline-deps 里建的那一个)。
    if (wired.mattersService) internalApi.provide({ matters: wired.mattersService })
    // 同上,桌宠的「在做什么」—— 组装闭包在 pipeline-deps(那里才有 boot)。
    internalApi.provide({ petTurn: wired.petTurn })
    ticksRef = wired.ticks
    cli.setAppPush(wired.appPush)
    internalApi.provide({ settingsLink: wired.settingsPanelLink })
    internalApi.provide({ connections: wired.connections })
    internalApi.provide({ phoneConnect: wired.phoneConnect })
    wiredRef.current = wired
    speechRef.set(wired.speech)
    // 推后了的 report / blocking 补说的那一拍(speech/pending-notices.ts):门这一层唯一的触发点,关机停
    lc.register(startPendingFlush(wired.speech, (t, l) => log(t, l)))
    const pipeline = buildInboundPipeline(wired.pipelineDeps)
    wireRef(wired.refs.pipeline, pipeline)
    wireRef(wired.refs.appTurn, pipeline.appTurn)
    // 4. register lifecycles (LIFO stop = startup order reversed)
    await startLifecycleModule(moduleHost, 'companion.push', () => registerCompanionPush(wired.companionPushDeps))
    await startLifecycleModule(moduleHost, 'companion.introspect', () => registerCompanionIntrospect(wired.companionIntrospectDeps))
    const ingestLc = await startLifecycleModule(moduleHost, 'companion.ingest', () => registerIngest(wired.companionIngestDeps))
    if (ingestLc) wireRef(wired.refs.ingestNudge, ingestLc.nudge)   // inbound path nudges ingestion on fresh activity
    const guardLc = await sup.start('guard', () => registerGuard(wired.guardDeps))
    if (guardLc) { wireRef(wired.refs.guard, guardLc); lc.register(guardLc) }
    // 外部 CLI provider 的退避重探计时器(2026-10-04)—— 关停时别再起探测、别再晚注册。
    lc.register({ name: 'provider-probes', stop: async () => { boot.stopProviderProbes?.() } })
    // 核心链就地搬家第 3 步(设计稿 2026-10-23-core-chain-modules):位置不变、关机顺序不变;起不来照旧整个开机失败。
    await startLifecycleModule(moduleHost, 'sessions', () => registerSessions(wired.sessionsDeps), { required: true })
    // 核心链就地搬家第 4 步:同上。ilink 的 30 秒清扫计时器(ilink/context.ts)和 speechRef 环留给 PR 6。
    await startLifecycleModule(moduleHost, 'ilink', () => registerIlink(wired.ilinkDeps), { required: true })
    let workbenchNotifications:ReturnType<typeof wireWorkbenchNotifications>|undefined
    let workbenchArtifacts:ReturnType<typeof wireWorkbenchArtifacts>|undefined
    // Register before polling so shutdown stops inbound, drains task sends, then flushes ilink.
    lc.register({name:'workbench-notifications',stop:async()=>{await workbenchNotifications?.close()}})
    lc.register({name:'workbench-artifacts',stop:async()=>{await workbenchArtifacts?.close()}})
    const pollingLc = registerPolling({ ...wired.pollingDeps, runPipeline: pipeline })
    wireRef(wired.refs.polling, pollingLc); lc.register(pollingLc); pollingLcRef = pollingLc
    // 笔友信箱的轮询器从第三批 3b 第 3 步起是社交那一组里的一个模块(bootstrap/social-module.ts),不在这里起。
    // 每晚整理长期记忆 memory.md(2026-09-25)。15 分钟一次「该不该跑」,运行时在 pipeline-deps 造好。
    await startLifecycleModule(moduleHost, 'memory-nightly', () => registerMemoryNightly({
      runtime: wired.memoryNightly, holdBusy: (l) => boot.holdBusy(l), log: (t, l) => log(t, l),
    }))
    internalApi.provide({ memoryNightly: wired.memoryNightly })
    // CC 的信(2026-10-16):不定期写一封信、排成信纸寄到微信;主人说「给我写封信」时 cc_letter 工具当场写。
    // 开关 companion.letters_enabled 默认关。可选子系统:坏了只降级。
    const letters = wireLetters({
      stateDir, db,
      providerFor: (c) => { const m = boot.coordinator.getMode(c); return m && m.kind === 'solo' ? m.provider : undefined },
      strongEval: (id) => (typeof boot.registry.getStrongEval === 'function' ? boot.registry.getStrongEval(id as never) : null),
      cheapEval: (c) => resolveCheapEval({ getMode: (x) => boot.coordinator.getMode(x), registry: boot.registry }, c),
      wechatSuspended: () => boot.health.health.shouldSuspend('wechat'),
      speech: wired.speech,
      sendText: (c, t) => ilink.sendMessage(c, t),
      // 逐页发不逐页记;寄出之后整封记成主人对话里的一行(App 对话页看得见),微信不通时寄到 App(2026-10-18)。
      sendFile: (c, f) => ilink.sendFile(c, f, { mirror: false }),
      mirror: (c, pages) => ilink.noteSentMedia?.(c, pages.map(path => ({ kind: 'file' as const, path }))),
      app: () => wired.companionApp,
      holdBusy: (l) => boot.holdBusy(l), log: (t, l) => log(t, l),
    })
    await startLifecycleModule(moduleHost, 'letters', () => letters.start())
    internalApi.provide({ letters: letters.runtime })
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
        // 经 CC 开口那道门(upgrade_notice 归 report);被推后 / 没发出去 ⇒ false,调用方照旧发桌面通知
        return wired.speech.tell('upgrade_notice', owner, text)
      },
      notifyDesktop: (t, b) => notifyDesktop(t, b),
      log: (t, l) => log(t, l),
    }))
    if (cliUpgrade) { lc.register(cliUpgrade.lifecycle); wireRef(cliUpgradeRef, cliUpgrade.upgrader); internalApi.provide({ cliUpgrade: cliUpgrade.upgrader }) }
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
    // App(记进对话 + 推一条 companion)。10-21 起经 SpeechPolicy:都不通 ⇒ 留着、不算失败,通了就送。
    await startLifecycleModule(moduleHost, 'reminders', () => registerReminders({
      store: makeRemindersStore(db),
      // 走 SpeechPolicy(第三批 3a,requested:免打扰 / 别烦我照发);两条路都送不到 ⇒ 留着、不算失败(reminders/sweeper sendReminderVia)
      send: sendReminderVia(wired.speech, (t, l) => log(t, l)),
      log: (t, l) => log(t, l),
      activityLog,
      isOwner: (chatId: string) => resolveAdminChatId(loadAccess(), loadCompanionConfig(stateDir), null) === chatId,
    }))
    await jobs.start()
    // 回报投递(task-3,2026-09-23):每轮答复回原对话说一声,人不在就等人回来
    // 再送(errcode=-2 不计入放弃窗口,保持 pending 退避重试)。同样是可选子
    // 系统:sweeper 坏了只降级,不挡启动。
    // 独立的一份 WorkbenchStore 实例,只用来给"放弃投递"这件事在那件事自己的
    // 时间线上留一笔(评审修复轮 3 ③)——同一个 db,跟 wireWorkbench 内部那份
    // 各自持有自己的预备语句,写入互相可见,不需要共享实例。
    const reportEventStore = makeWorkbenchStore(db)
    await startLifecycleModule(moduleHost, 'reports', () => registerReportSweeper({
      store: reportOutbox,
      matters,
      // 一件事做完的回报走 SpeechPolicy(第三批 3a):推后留在 outbox,发出去以后的失败照旧回给 sweeper(reports/sweeper sendReportVia)
      send: sendReportVia(wired.speech),
      log: (t, l) => log(t, l),
      noteAbandoned: (matterId, text) => {
        try { reportEventStore.addEvent(matterId, 'system', text) } catch { /* best effort — the drop itself already succeeded */ }
      },
    }))
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
        // 经 CC 开口那道门(boot_notice 归 report);「CC 现在怎么样」里同样看得到这几样
        void wired.speech.tell('boot_notice', adminChatId, `这次开机有几样没起来：${names}。其它功能照常。`)
          .then(sent => { if (!sent) log('SUBSYS', 'admin degraded summary not sent (deferred by speech policy or send failed)') })
          .catch(err => log('SUBSYS', `admin degraded summary send failed: ${err instanceof Error ? err.message : String(err)}`))
      }
    }
    // The worker can arm timers immediately: construct only once partial-startup cleanup is active.
    workbenchNotifications=wireWorkbenchNotifications({workbench,ilink,speech:wired.speech})
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
import { recordBootFailure, clearBootFailures } from './runtime/boot-backoff'
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
  // 信号处理在开机**之前**装(第三批 3b 第 2 步):开机途中收到 SIGTERM(launchctl kickstart -k、换包、注销)也走收尾,
  // 停掉已经起了的那些(收尾清单、已经登记的子系统、db、锁),而不是默认行为直接死。收尾函数一建好 bootDaemon 就交过来。
  let shutdownFn: (() => Promise<void>) | null = null
  let alreadyShuttingDown = false
  const cliShutdown = async (sig: string) => {
    if (alreadyShuttingDown) { log('DAEMON', `${sig} during shutdown — forcing exit`); process.exit(130) }
    alreadyShuttingDown = true; log('DAEMON', `${sig} received, shutting down${handleReady ? '' : ' (during boot)'}`)
    // 有人让它停(launchctl kickstart -k / bootout、App 更新换包、注销关机)——
    // 先留纸条再收尾:哪怕收尾中途被 SIGKILL,下次开机也认得出这是计划内的。
    markCleanShutdown(stateDir, sig)
    if (shutdownFn) await shutdownFn()
    process.exit(0)
  }
  process.on('SIGINT', () => void cliShutdown('SIGINT'))
  process.on('SIGTERM', () => void cliShutdown('SIGTERM'))
  let handleReady = false
  let handle: DaemonHandle
  try { handle = await bootDaemon({ stateDir, dangerously, onShutdownReady: (fn) => { shutdownFn = fn } }) } catch (err) {
    console.error('[wechat-cc] fatal:', err)
    // 指数退避(重构第二批步 6a):launchd / systemd 只是每 5–10 秒拉起一次,确定性的启动失败(配置坏了、迁移失败)
    // 会变成重启风暴。退出前按连续失败次数等:10s、20s、40s … 封顶 30 分钟。
    const { count, delayMs } = recordBootFailure(stateDir, Date.now())
    // 原因也进 channel.log:以前只在 stderr(launchd.err.log),日志里只有一句「startup failed」,self soak / self discover
    // 和主人都看不出为什么(10-21~22 真机 9 次,原因全是「another daemon already running」,只能去翻 stderr)。
    log('DAEMON', `startup failed (${count} in a row): ${(err instanceof Error ? err.message : String(err)).slice(0, 300)} — waiting ${Math.round(delayMs / 1000)}s before exit`)
    await new Promise(r => setTimeout(r, delayMs))
    process.exit(1)
  }
  clearBootFailures(stateDir)
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
  handleReady = true
  shutdownFn = () => handle.shutdown()
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

/**
 * 地基(架构终态 A1,docs/architecture-end-state-2026-10-25.md):模块容器之前就得有、而且没有「启停」可言的东西。
 *
 * 锁、心跳、上一次怎么停的、账号、db、几个 store,以及几份**必须是同一个实例**的共享对象(chatPrefs、贴纸库、
 * care-ledger、reply-sinks、outbound-taps、桌宠信号 ……:写的和读的在不同模块里,两个实例等于永远收不到、
 * 而且不报错)。它们都只是「造出来」,不开始干活;干活的一律是模块(daemon-modules.ts)。
 *
 * 这里失败(锁抢不到、库打不开、access.json 坏了)⇒ 抛;`undo` 里登记的按倒序放掉(main.ts 的 bootDaemon 负责)。
 */
import { join } from 'node:path'
import { acquireInstanceLockWaitingForShutdown, releaseInstanceLock, isHeartbeatFresh, writeHeartbeat, startHeartbeatTicker, HEARTBEAT_FILE, HEARTBEAT_STALE_MS, LOCK_WAIT_FOR_SHUTDOWN_MS } from './single-instance'
import { openDb, type Db } from '../lib/db'
import { log } from '../lib/log'
import { dedupeAccountsByUserId } from '../lib/dedupe-accounts'
import { loadAccess, AccessConfigCorruptError } from '../lib/access'
import { consumePreviousRunEvidence, peekCleanShutdown } from '../lib/restart-markers'
import { makeMemoryFS } from '../adapters/store/memory-fs'
import { makeConversationStore } from '../adapters/store/conversation-store'
import { makeTurnRecordStore } from '../adapters/store/turn-record-store'
import { loadAllAccounts, type IlinkAccount } from './ilink-glue'
import { makeMessagesStore } from '../lib/messages-store'
import { makeJobsStore } from '../core/scheduled-jobs-store'
import { makeMatterStore } from '../adapters/store/matters-store'
import { makeChatPrefs } from './chat-prefs'
import { makeOutboundTaps } from './outbound-taps'
import { makePetSignals } from './pet-signals'
import { makeJournal } from '../adapters/store/journal-store'
import { makeReplySinks } from './reply-sinks'
import { makeCareLedger } from './companion/care-ledger'
import { makeProviderRefusals } from './provider-refusals'
import { SubsystemSupervisor } from './subsystems'
import { makeProjects } from './projects'

export async function openFoundation(opts: { stateDir: string }, undo: Array<() => void>) {
  const { stateDir } = opts
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
  const releaseLock = () => releaseInstanceLock(PID_PATH)
  undo.push(releaseLock)
  // 上一个进程是怎么停的(计划内纸条 / 优雅退出纸条 / 最后一跳心跳)——
  // **必须**在写本进程第一跳心跳之前读,否则停机时长就量成了 0。
  // 读完就删,结果交给 notify-startup 决定要不要在微信里说话。
  const previousRun = consumePreviousRunEvidence(stateDir)
  // Stamp an initial heartbeat immediately so this just-started daemon reads
  // as healthy before its first poll cycle lands. A dedicated ticker then
  // refreshes it on a fixed cadence, DECOUPLED from poll work — so a long inline
  // turn (or macOS sleep/wake) can't let the heartbeat go stale and invite a
  // second daemon to steal the lock. The poll loop's per-cycle stamp stays as a
  // belt-and-suspenders signal.
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
  // to boot — through the typed exception so tests can catch it.
  try { loadAccess() }
  catch (err) {
    if (err instanceof AccessConfigCorruptError) {
      // 以前直接 process.exit(1),绕过了 main() 的退避 ⇒ access.json 坏了就是重启风暴。锁由外层放。
      process.stderr.write(`wechat channel: FATAL ${err.message}\n`)
    }
    throw err
  }
  const accounts: IlinkAccount[] = await loadAllAccounts(stateDir)
  if (accounts.length === 0) throw new Error('[wechat-cc] no accounts bound. Run `wechat-cc setup` first.')
  const db: Db = openDb({ path: join(stateDir, 'wechat-cc.db') })
  undo.push(() => db.close())

  // ConversationStore must be constructed BEFORE the ilink adapter — the
  // adapter's setUserName/resolveUserName go through it. Legacy
  // conversations.json and user_names.json are backfilled here on first
  // boot and renamed to *.migrated when done.
  const conversationStore = makeConversationStore(db, {
    migrateFromFile: join(stateDir, 'conversations.json'),
    migrateFromUserNamesFile: join(stateDir, 'user_names.json'),
  })

  // Single shared chat-prefs instance for this daemon — both the reply
  // route (split behavior) and the /set command read/write through it.
  // A second instance would have a stale in-memory cache: the store's
  // write-through only protects its own writes, not cross-instance reads.
  const chatPrefs = makeChatPrefs(stateDir)

  return {
    stateDir,
    heartbeatPath: HEARTBEAT_PATH,
    stopHeartbeat,
    releaseLock,
    previousRun,
    accounts,
    db,
    bootAtIso: new Date().toISOString(),
    // Per-turn observability store — written by the coordinator's recordTurn
    // (via bootstrap onTurnRecord) and read by internal-api GET /v1/turns.
    turnRecordStore: makeTurnRecordStore(db),
    // 执行者「真被拒着」(地区不可用):只看真回合,一轮真完成才清(provider-refusals.ts)
    providerRefusals: makeProviderRefusals({ stateDir, log }),
    conversationStore,
    memoryFS: makeMemoryFS({ rootDir: join(stateDir, 'memory'), layout: 'all-chats' }),
    messagesStore: makeMessagesStore(db),
    // 项目登记(别名 → 文件夹):以前挂在 ilink 适配器上,跟微信无关(架构终态 A6)。
    projects: makeProjects(stateDir),
    jobsStore: makeJobsStore(stateDir),
    // 「一件事」登记处:一份 store,工作台、微信入站、app 对话、内部 API 都用它(2026-09-16)。
    matters: makeMatterStore(db),
    chatPrefs,
    // pushTick claims/reads it; the inbound path resets the no-reply streak on every message.
    careLedger: makeCareLedger(stateDir),
    // reply-sink registry: the POST /v1/wechat/reply route captures into it when a sink is open;
    // the companion-converse closure opens/closes it around a real turn.
    replySinks: makeReplySinks(),
    // 打猎战利品(2026-09-03):旁听而非改道,见 outbound-taps.ts。开 tap 的是打猎那一拍,往里写的是发送路径。
    outboundTaps: makeOutboundTaps(),
    // 桌宠信号(spec 2026-09-05-cc-desktop-pet §5.1):纯内存,重启就忘 —— 描述的本来就只是当下。
    petSignals: makePetSignals(),
    // 伙伴日志(背包,v36 起):打猎、串门见闻、明信片、回忆都进这一张表;桌宠 / 手机首屏 / 设置面板 / 微信「背包」读它。
    // 读写路由归日志模块(src/features/journal)。
    journal: makeJournal(db),
    // 子系统状态的汇总处:模块容器整组交给它收养,/v1/health.subsystems 读它。
    sup: new SubsystemSupervisor((t, l) => log(t, l)),
  }
}

export type Foundation = Awaited<ReturnType<typeof openFoundation>> & {
  dangerously: boolean
  schedulerIntervalMs?: number
  /** daemon 自己要求的优雅重启(运维 POST /v1/daemon/restart、空闲加载新代码 ……)。 */
  requestRestart(reason: string): void
}

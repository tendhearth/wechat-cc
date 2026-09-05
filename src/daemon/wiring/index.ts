/**
 * wiring/ — main.ts dep factory hub. Composes the three sub-builders into
 * one wireMain() entry. Holds zero business logic — pure orchestration.
 */
import type { Db } from '../../lib/db'
import type { IlinkAdapter, IlinkAccount } from '../ilink-glue'
import type { Bootstrap } from '../bootstrap'
import type { Access } from '../../lib/access'
import { Ref } from '../../lib/lifecycle'
import type { GuardLifecycle } from '../guard/lifecycle'
import type { PollingLifecycle } from '../polling-lifecycle'
import type { InboundPipelineDeps } from '../inbound/build'
import type { PipelineRun } from '../inbound/types'
import type { CompanionPushDeps, CompanionIntrospectDeps, CompanionIngestDeps } from '../companion/lifecycle'
import type { SchedulerDeps } from '../guard/scheduler'
import type { SessionsLifecycleDeps } from '../sessions-lifecycle'
import type { IlinkLifecycleDeps } from '../ilink-lifecycle'
import type { PollingDeps } from '../polling-lifecycle'
import type { StartupSweepDeps } from '../startup-sweeps'
import type { ChatPrefsStore } from '../chat-prefs'
import type { CareLedger } from '../companion/care-ledger'
import type { ReplySinks } from '../reply-sinks'
import { buildPipelineDeps } from './pipeline-deps'
import { buildLifecycleDeps } from './lifecycle-deps'
import { buildTickBodies, type TickBodies } from './tick-bodies'
import { makeMemoryLlmOps } from '../memory-llm-ops'
import { makeAtelierStore } from '../atelier-store'
import { makeJsonAtelierPlanner } from '../atelier-planner'
import { locateAtelierSdCli, resolveAtelierRenderer } from '../atelier-renderer-resolve'
import { buildAtelierContext, runAtelierCycle } from '../atelier-runtime'
import { makeObservationsStore } from '../observations/store'
import { resolveIntrospectChatId } from '../companion/introspect-runtime'
import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'

export interface WireMainOpts {
  stateDir: string
  db: Db
  ilink: IlinkAdapter
  /** Sticker library — threaded to tick-bodies' daily sticker-artist step. */
  stickers?: import('../stickers').StickerLib
  /** 远程访问开关的重启触发(settings-panel set_remote)。 */
  requestRestart?: (reason: string) => void
  /** Loaded before makeIlinkAdapter — passed separately because IlinkAdapter doesn't expose accounts. */
  accounts: IlinkAccount[]
  boot: Bootstrap
  /** `--dangerously` flag — read by startup-sweeps for notification text. */
  dangerously: boolean
  /**
   * Task 11 — tick-bodies resolve `default_chat_id`'s tier from
   * access.json on each tick. Threaded through wireMain so the eval
   * harness can inject a fake `loadAccess` without touching disk.
   */
  loadAccess: () => Access
  log: (tag: string, line: string, fields?: Record<string, unknown>) => void
  /** Forwarded to buildLifecycleDeps — eval harness override. */
  schedulerIntervalMs?: number
  /**
   * Shared chat-prefs instance (constructed once in main.ts, also passed to
   * registerInternalApi's getChatPrefs) — threaded through to buildPipelineDeps
   * so the /set command reads/writes the SAME store the reply-route split
   * logic reads. A second instance would have a stale in-memory cache.
   */
  chatPrefs: ChatPrefsStore
  /**
   * Shared care-ledger instance (constructed once in main.ts alongside
   * chatPrefs) — threaded through so pushTick's claim/read and the inbound
   * no-reply reset operate on the SAME store. A second instance would have
   * a stale in-memory cache.
   */
  careLedger: CareLedger
  /**
   * Shared reply-sink registry (constructed once in main.ts, also passed to
   * registerInternalApi's `replySinks`) — threaded through to
   * buildPipelineDeps so the companion-converse closure opens sinks on the
   * SAME registry the reply route captures into.
   */
  replySinks: ReplySinks
  /**
   * 打猎战利品(2026-09-03)。和 replySinks 一样必须是 main.ts 里那个**同
   * 一个实例**:开 tap 的是打猎那一拍,往里写的是发送路径。经 `...opts`
   * 透传进 buildTickBodies。
   */
  outboundTaps?: { tap(chatId: string): { close(): string[] } }
  // 三条用途:tick-bodies 用 recordHunt(打猎入库)与 list/summary(日程判断
  // 要看包袱里堆了什么),pipeline-deps 用 list(微信「背包」命令)。这里给
  // 全,下游各取所需 —— main.ts 传的是完整 Journal。
  /**
   * 桌宠信号(spec 2026-09-05-cc-desktop-pet §5.1)。和 replySinks/outboundTaps
   * 一样必须是 main.ts 那个**同一个实例**:写的一头在 bootstrap(tool_call /
   * 回合结束)与 pipeline-deps(起飞 / 主人联系),读的一头是 pipeline-deps
   * 组装出的 petTurn。两个实例 = 桌宠永远看不到动静,而且不会报任何错。
   */
  petSignals?: import('../pet-signals').PetSignals
  huntStore?: {
    recordHunt(a: { chatId: string; text: string; nowIso?: string }): number
    list(limit?: number): readonly { kind: string; title: string; url: string | null; ts: string; status: string }[]
    /** 包袱水位(spec 2026-09-05-companion-plan):水位之后有几条、最新一条是什么。 */
    summary(seenUntil: string | null): { unread: number; latest: { kind: string; title: string; ts: string } | null }
  }
}

export interface WiredDeps {
  pipelineDeps: InboundPipelineDeps
  /**
   * App-conversation-channel converse closure (voice arc Stage 0, Task 2).
   * main.ts late-binds this onto internal-api via setCompanionConverse()
   * once wireMain returns (bootstrap must be ready first).
   */
  companionConverse: (text: string) => Promise<{ reply: string }>
  /**
   * 桌宠 turn 闭包(CC 桌宠 Phase B)。main.ts 在 setCompanionConverse 旁边
   * setPetTurn 到 internal-api —— 同样要等 bootstrap 就绪。
   */
  petTurn: import('../internal-api/types').PetTurnDep
  /** Mint a fresh graphical-settings-panel URL (10-min token). Null when no
   *  LAN/owner. Wired to GET /v1/settings/link for the desktop QR entry. */
  settingsPanelLink: () => Promise<string | null>
  companionPushDeps: CompanionPushDeps
  companionIntrospectDeps: CompanionIntrospectDeps
  companionIngestDeps: CompanionIngestDeps
  guardDeps: SchedulerDeps
  sessionsDeps: SessionsLifecycleDeps
  ilinkDeps: IlinkLifecycleDeps
  pollingDeps: Omit<PollingDeps, 'runPipeline'>
  startupDeps: StartupSweepDeps
  /**
   * The same TickBodies object used by the lifecycle onTick callbacks.
   * Exposed so bootDaemon can wire DaemonHandle.fireTick directly to it —
   * eval harness calls fireTick to drive ticks deterministically.
   */
  ticks: TickBodies
  /**
   * Late-bound references — main.ts populates via wireRef() after the
   * corresponding lifecycle is registered. Closures (admin handler's
   * pollHandle, mwGuard's guardState) read .current at call time.
   */
  refs: {
    polling: Ref<PollingLifecycle>
    guard: Ref<GuardLifecycle>
    pipeline: Ref<PipelineRun>
    ingestNudge: Ref<() => void>
  }
}

export function wireMain(opts: WireMainOpts): WiredDeps {
  const refs = {
    polling: new Ref<PollingLifecycle>('polling'),
    guard: new Ref<GuardLifecycle>('guard'),
    pipeline: new Ref<PipelineRun>('pipeline'),
    ingestNudge: new Ref<() => void>('ingestNudge'),
  }
  // CC 画的你 —— 小像自动刷新用的 generatePortrait(portrait-artist tick)。
  // memory-llm-ops 是无状态工厂(每次读盘),tick 与 pipeline-deps 各持一个
  // 无妨。构造在 buildTickBodies 前,以便传入。
  const tickMemoryLlm = makeMemoryLlmOps({
    stateDir: opts.stateDir, db: opts.db,
    getMode: (cid) => opts.boot.coordinator.getMode(cid),
    registry: opts.boot.registry,
  })
  // Atelier is deliberately lazy and default-off. The callback is mounted
  // only when the persisted mode is enabled and both local sidecar/model
  // paths are explicitly available; missing assets remain a safe no-op.
  const runAtelierTick = async ({ nowIso }: { nowIso?: string } = {}): Promise<void> => {
    const cfg = (await import('../companion/config')).loadCompanionConfig(opts.stateDir)
    if (cfg.atelier_mode === 'off') return
    const sdCliPath = locateAtelierSdCli({
      explicitPath: process.env.WECHAT_CC_ATELIER_SD_CLI,
      execPath: process.execPath,
      stateDir: opts.stateDir,
      existsSync,
    })
    const modelPath = process.env.WECHAT_CC_ATELIER_SD_MODEL ?? join(opts.stateDir, 'atelier', 'models', 'sd-turbo.safetensors')
    const renderer = resolveAtelierRenderer({ platform: process.platform, arch: process.arch, existsSync, sdCliPath, modelPath, workDir: join(opts.stateDir, 'atelier', 'tmp') })
    if (!renderer) { opts.log('ATELIER', 'skip — local renderer/model unavailable'); return }
    const sdkEval = opts.boot.registry.getCheapEval()
    if (!sdkEval) { opts.log('ATELIER', 'skip — no cheap evaluator'); return }
    const store = makeAtelierStore(opts.stateDir)
    const planner = makeJsonAtelierPlanner({ evaluate: sdkEval })
    // Feed CC its own derived signals (recent observations + persona) so a real
    // creative impulse can form. Falls back to empty context when CC has no
    // anchor chat yet — that just means no impulse, never a crash.
    const chatId = resolveIntrospectChatId(opts.stateDir)
    const memoryRoot = join(opts.stateDir, 'memory')
    let observations: Awaited<ReturnType<ReturnType<typeof makeObservationsStore>['listActive']>> = []
    let persona: string | null = null
    if (chatId) {
      try {
        observations = await makeObservationsStore(opts.db, chatId, { migrateFromFile: join(memoryRoot, chatId, 'observations.jsonl') }).listActive()
      } catch (err) { opts.log('ATELIER', `observations unavailable: ${String(err)}`) }
      try { persona = readFileSync(join(memoryRoot, chatId, 'persona.md'), 'utf8') } catch { /* persona is optional */ }
    }
    const result = await runAtelierCycle({
      stateDir: opts.stateDir,
      mode: cfg.atelier_mode,
      planner,
      renderer,
      store,
      context: buildAtelierContext({
        observations,
        persona,
        recentWorks: store.list(6).map(w => ({ id: w.id, createdAt: w.createdAt, subject: w.impulse.subject, surface: w.impulse.surface, medium: w.impulse.medium })),
        nowLocal: nowIso ?? new Date().toISOString(),
      }),
      log: (tag, line) => opts.log(tag, line),
    })
    opts.log('ATELIER', result.status === 'created'
      ? `cycle created record=${result.recordId} shared=${result.shared}`
      : `cycle ${result.status}`)
  }
  const ticks = buildTickBodies({
    ...opts,
    permissionMode: opts.dangerously ? 'dangerously' : 'strict',
    generatePortrait: (chatId) => tickMemoryLlm.generatePortrait(chatId),
    // Connection-health gate (Task 7) — companion ticks read
    // boot.health.health.shouldSuspend('wechat') to stop proactive outbound
    // while the connection is confirmed down (see TickDeps.health's doc
    // comment in ./tick-bodies.ts).
    health: opts.boot.health.health,
    runAtelierTick,
  })
  const { pipelineDeps, companionConverse, petTurn, settingsPanelLink } = buildPipelineDeps(opts, refs)
  const lifecycleDeps = buildLifecycleDeps(opts, ticks)
  return {
    pipelineDeps,
    companionConverse,
    petTurn,
    settingsPanelLink,
    ...lifecycleDeps,
    ticks,
    refs,
  }
}

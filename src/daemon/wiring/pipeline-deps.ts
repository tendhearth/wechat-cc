import { makeOwnerChatFileReader, ownerChatReadingEvent } from './owner-chat-reading'
/**
 * Pipeline dep builder — admin/mode/onboarding handler construction +
 * 13-mw deps assembly into InboundPipelineDeps.
 *
 * Refs are passed in for late-bound polling/guard access from closures.
 */
import { makeCommandRegistry, yieldNumbersToOpenChoice } from '../commands/registry'
import { makePermissionAnswer } from '../permission-answer'
import { choiceTakes, type OpenChoice } from '../inbound/mw-task-reference'
import { makeTaskCommand } from '../commands/task-command'
import { join } from 'node:path'
import { memoryFactsFor, recallFromMemory } from '../../features/memory'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import type { PollingLifecycle } from '../polling-lifecycle'
import type { InboundPipelineDeps } from '../inbound/build'
import type { PipelineRun } from '../inbound/types'
import { isAdmin, loadAccess, appendAllowFrom } from '../../lib/access'
import { resolveTier } from '../../domain/user-tier'
import type { PetTurnDep } from '../internal-api/types'
import { makeAdminCommands } from '../admin-commands'
import { makeSelfChangeSpawner, resolveSelfCli } from '../self-change-spawn'
import { makeModeCommands } from '../mode-commands'
import { loadCompanionConfig } from '../../lib/companion-config'
import { resolveAdminChatId } from '../companion/resolve-admin'
import { makeCheapJudge, type TaskCandidate } from '../../features/workbench'
import { scopedSend } from '../inbound/reply-scope'
import type { AppTurn } from '../inbound/build'
import { basename as pathBasename } from 'node:path'
import { wireConnections } from './wire-connections'
import { wirePhone } from './wire-phone'
import { makeControlCommands } from './command-router'
import { ensureChatAndNote, makeMatterActivity, wireMatterActivity } from '../matter-activity'
import { makeGuestRequestStore } from '../guest-requests'
import { makeForwardBudget } from '../../domain/forward-budget'
import type { InboundMsg } from '../../domain/prompt-format'
import { makeOnboardingHandler } from '../onboarding'
import { botName, botNameFromModeFallback } from '../bot-name'
import { loadAgentConfig, saveAgentConfig } from '../../lib/agent-config'
import { socialState } from '../social-state'
import { writeConfigKey } from '../config-surface'
import { makeOpenaiModels } from '../openai-models'
import { findOnPath } from '../../lib/util'
import { isCompiledBundle } from '../../lib/runtime-info'
import type { A2AAgentRecord } from '../../lib/agent-config'
import { materializeAttachments } from '../media'
import { makeFireMilestonesFor, makeMaybeWriteWelcomeObservation, makeRecordInbound } from './side-effects'
import { makeMessagesStore } from '../../lib/messages-store'
import { wireMemory } from '../../features/memory'
import { wirePetTurn } from './wire-pet-turn'
import { wireCompanionConverse } from './wire-converse'
import { makeDedupStore } from '../../lib/dedup-store'
import { DEFAULT_DELEGATE_TIMEOUT_MS } from '../../app/a2a-delegate'
import type { YiHub, YiDispatch } from '../../app/yi-hub'
import type { ExecResult } from '../../ports/a2a'
import { makeMattersService } from '../../app/matters/service'
import { makeSayReceipts } from '../../adapters/store/say-receipts'
import { surfaceOrigin, fileChunkResponse } from '../../features/phone'

export interface DelegateDeps {
  listHands: () => readonly A2AAgentRecord[]
  hub: Pick<YiHub, 'dispatchTask' | 'isConnected'>
  pushDelegate: (hand: A2AAgentRecord, task: YiDispatch, selfId: string, timeoutMs: number) => Promise<ExecResult>
  selfId: string
  timeoutMs: number
}

export { resolveOwnerSessionKey, type OwnerSessionKeyDeps } from './owner-session-key'

export function makeDelegateToHand(deps: DelegateDeps) {
  return async (handName: string, task: string): Promise<ExecResult & { knownHands?: string[] }> => {
    const hands = deps.listHands().filter(a => a.capabilities?.includes('exec'))
    const hand = hands.find(a => a.id === handName || a.name === handName)
    if (!hand) return { ok: false, reason: 'unknown_hand', knownHands: hands.map(a => a.name || a.id) }
    // **不指定 peer**:哪个 agent 跑在那台机器上,只有那台机器知道。
    // 2026-09-02 真机实验:一台只跑 openai-compatible(Kimi)、没装 claude
    // CLI 的机器配成 hand 之后,委派永远失败,因为这里替它选了 claude ——
    // 而回来的错误是「Claude Code process exited with code 1」,看不出因果。
    const dispatch: YiDispatch = { prompt: task }
    if (hand.transport === 'ws') return deps.hub.dispatchTask(hand.id, dispatch, deps.timeoutMs)
    return deps.pushDelegate(hand, dispatch, deps.selfId, deps.timeoutMs)
  }
}

export type { PipelineDepsOpts } from './pipeline-deps-opts'
import type { PipelineDepsOpts } from './pipeline-deps-opts'
import { makeJobsStore } from '../../adapters/store/scheduled-jobs-store'
import { makeGuestOwnerNotify } from '../inbound/guest-notify'
import { Ref } from '../../lib/lifecycle'
import { makeProactiveOutbound, type AppChannel, type ProactiveOutbound } from '../companion/proactive-channel'
import type { SpeechPolicy } from '../speech/policy'
import { wireSpeech } from './wire-speech'

/**
 * 比 pipeline-deps 晚才有的几样(环的那一头,模块容器的 `ctx.late`):调用时现取,还没有 ⇒ null。
 */
export interface PipelineDepsLate {
  polling(): PollingLifecycle | null
  pipeline(): PipelineRun | null
  /** 可选:没接(测试 / 最小嵌入)时 App 一轮不过消费表,直接进对话。 */
  appTurn?(): AppTurn | null
  /** Ingest nudge — fired per new inbound so the knowledge base tracks fresh activity. */
  ingestNudge(): (() => void) | null
}

/** 管道一定已经在了的地方(它自己的回话 / 访客批准后再派一次)用:没有就是接线错了,照实抛。 */
function pipelineOf(late: PipelineDepsLate, why: string): PipelineRun {
  const p = late.pipeline()
  if (!p) throw new Error(`pipeline not wired yet (${why})`)
  return p
}

const STARTED_AT_ISO = new Date().toISOString()
const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..', '..')
const CLI_ENTRY = join(REPO_ROOT, 'cli.ts')

export interface BuildPipelineDepsResult {
  pipelineDeps: InboundPipelineDeps
  /** 关机时停手机那一簇(隧道 / notifier / 订阅 / 设置面板);main.ts 在 polling 之前登记。 */
  stopPhone: () => Promise<void>
  /** Mint a fresh settings-panel URL (10-min single-active token) — the
   *  微信 /set(进程内)与 GET /v1/settings/link(admin 档,plan 7a;selftest phone 用)。
   *  桌面「连接手机」走 phoneConnect / POST /v1/phone/link。 */
  settingsPanelLink: () => Promise<string | null>
  /** 手机「跟 CC 说」的任务表(收下即回,converse = companionConverse);没接 matters ⇒ null。 */
  phoneChat: import('../../features/phone').PhoneChat | null
  /** 「CC 的连接」快照(缓存 10 s);手机与 admin 路由共用。 */
  connections: () => import('../connections').ConnectionsSnapshot
  /** 桌面「连接手机」(plan 7a)。 */
  phoneConnect: import('../../features/phone').PhoneConnectDep
  /** 「一件事」读写面(有 matters store 才有)。 */
  mattersService: import('../../app/matters/service').MattersService | null
  /** 退订工作台事件 + 清「一件事」活动时间的节流定时器;main.ts 登记进 shutdown。可重复调用。 */
  stopMatterActivity: () => void
  /**
   * App-conversation-channel converse closure (voice arc Stage 0, Task 2).
   * Late-bound onto internal-api by main.ts via setCompanionConverse()
   * once this returns — bootstrap (boot.coordinator) isn't available until
   * after buildPipelineDeps runs, so it can't be wired at internal-api
   * registration time (see main.ts's staged startup: internal-api first,
   * then bootstrap, then this wiring pass).
   */
  companionConverse: (text: string, origin?: 'desktop' | 'phone', images?: import('../app-reply').ConverseImage[]) => Promise<import('../app-reply').ConverseResult>
  /**
   * 桌宠 turn 的组装闭包(CC 桌宠 Phase B)。和 companionConverse 挨着造,因为
   * 需要同一批东西:ownerChatId(companion 配置)、resolveOwnerSessionKey +
   * boot.sessionManager(在飞判断)、opts.petSignals(三个时间戳)、消息库
   * (主人最近一次入站)。main.ts 经 setPetTurn late-bind 到 internal-api。
   */
  petTurn: PetTurnDep
  /** 每晚记忆整理运行时;main.ts 挂定时器并接到 internal-api。 */
  memoryNightly: import('../../features/memory').MemoryNightlyRuntime
  /** 手机 app 原生推送出口(中继 v2);没开 v2 ⇒ 调用回 null。终端会话推送用(main.ts 懒绑定)。 */
  appPush: import('../../features/terminal').AppPushOutlet
  /**
   * CC 主动找你的 App 那条路(2026-10-18,companion/app-channel.ts):记进主人对话 + companion 推送。
   * 没开中继 v2 / 没有「一件事」库(手机对话不存在)⇒ null,伙伴与提醒只走微信。
   */
  companionApp: import('../companion/proactive-channel').AppChannel | null
  /** CC 主动找你的出口(微信能用走微信,不能用落到 App)。 */
  proactive: ProactiveOutbound
  /** CC 主动开口唯一的门(第三批 3a)。 */
  speech: SpeechPolicy
}

export function buildPipelineDeps(opts: PipelineDepsOpts, late: PipelineDepsLate): BuildPipelineDepsResult {
  const { stateDir, db, ilink, boot, log, chatPrefs, careLedger, replySinks } = opts
  // 消费者的回话:微信来的一轮直发微信;App 来的一轮(withReplyScope 里)截住交还 App(inbound/reply-scope)。
  const send = scopedSend((cid: string, txt: string, o?: { source: 'workbench' }) => ilink.sendMessage(cid, txt, o))
  const inboxDir = join(stateDir, 'inbox')

  // CC 主动找你的出口 + 开口那道门(第三批 3a)。记忆通知在下面就要用,所以在最前面造。
  // App 那条路(companionApp)要等 wirePhone 才有 —— 这是一个真实的环:记忆 → 手机页(要显示记忆)→ App 通道 → 门 → 记忆通知。
  // proactive-channel 的 app() 本来就是为这个设计的懒取;这里用 Ref 接上(只 set 一次,没开中继 v2 就一直是 null)。
  const companionAppRef = new Ref<AppChannel>('companionApp')
  const proactive = makeProactiveOutbound({
    wechatDegraded: () => boot.health.health.shouldSuspend('wechat'),
    wechatClosedSince: (chatId) => ilink.proactiveClosedSince(chatId),
    sendWechat: (chatId, text) => ilink.sendMessage(chatId, text),
    // ilink.sendFile 失败是抛错 —— 折成 {error},proactive-channel 才能改走 App(新贴纸那一句,第三批 3a)
    sendWechatFile: async (chatId, path) => { try { await ilink.sendFile(chatId, path); return {} } catch (err) { return { error: err instanceof Error ? err.message : String(err) } } },
    app: () => companionAppRef.current,
    log: (tag, line) => log(tag, line),
  })
  const speech = wireSpeech({ stateDir, db, chatPrefs, proactive, log: (tag, line) => log(tag, line) })

  // A2A exec (delegate a task to a hand) runs a FULL agent on the hand —
  // often tens of seconds to minutes. The shared a2aDeps.client's 10s timeout
  // is tuned for notify/send; exec needs a long one. Lazily built + reused.
  let execA2AClient: import('../../ports/a2a').A2AClient | undefined

  const fireMilestonesFor = makeFireMilestonesFor({ stateDir, db, dayTzOffsetMinutes: boot.agentConfig.day_tz_offset_minutes })

  // Disk-first then mutate: if saveAgentConfig throws (EACCES, ENOSPC),
  // the in-memory boot.agentConfig stays untouched so callers can retry.
  // Mutate via index access so existing readers (who hold the same object
  // reference) see the new value on next lookup.
  //
  // Read fresh from disk before merging: another process (CLI
  // `wechat-cc agent add`, the dashboard install route, a future
  // a2a-registry mutation) may have written to agent-config.json
  // since boot. Using the boot-time snapshot here would clobber
  // those fields. Read → spread → write keeps a2a_agents and any
  // other fields written by sibling processes intact.
  const setBotName = async (name: string | null): Promise<void> => {
    const current = loadAgentConfig(stateDir)
    const next: typeof current = { ...current, bot_name: name }
    await saveAgentConfig(stateDir, next)
    boot.agentConfig.bot_name = name
  }
  const getBotName = (): string | null => boot.agentConfig.bot_name ?? null

  const recordInbound = makeRecordInbound({
    stateDir, db,
    log: (tag, line) => log(tag, line),
    dayTzOffsetMinutes: boot.agentConfig.day_tz_offset_minutes,
  })
  const messagesStore = makeMessagesStore(db)
  const dedupStore = makeDedupStore(db)
  // Guest path (spec docs/superpowers/specs/2026-08-18-guest-path-design.md
  // §1/§2) — durable pending-request/invite-code store and the per-sender
  // forward budget mw-access's guest branch gates on. Both built ONCE here
  // and reused across every inbound (the budget in particular needs a
  // process-lifetime Map to actually rate-limit anything).
  const guestRequests = makeGuestRequestStore({ stateDir })
  const guestForwardBudget = makeForwardBudget({ perSender: 3, windowMs: 3600_000 })
  // Targeted hydrate for a NOT-(yet)-allowlisted guest chat — replicates
  // mw-capture-ctx's two calls (account routing + context-token capture)
  // WITHOUT mw-capture-ctx's markChatActive side effect on lastActiveRef
  // (spec §2: a stranger's first message must never become the
  // operator-relay target). routeChatToAccount is the narrower seam
  // (ilink-glue.ts / ilink/transport.ts) that does ONLY the account-routing
  // half of markChatActive. Split into a (chatId, accountId, contextToken)
  // primitive so the T5 owner-command seam's 允许 handler can hydrate from
  // a STORED GuestRequest's routing fields (fix round 1, Important #3) —
  // not just from a live InboundMsg.
  const hydrateRoute = (chatId: string, accountId: string, contextToken: string): void => {
    ilink.routeChatToAccount(chatId, accountId)
    if (contextToken) ilink.captureContextToken(chatId, contextToken)
  }
  const hydrateGuestChatRoute = (msg: InboundMsg): void => {
    hydrateRoute(msg.chatId, msg.accountId, msg.contextToken ?? '')
  }

  // 管理员控制命令路由 — 从 dispatch 闭包抽出(命令逻辑本体在 command-router.ts)。
  const controlCommands = makeControlCommands({
    isAdmin: (c) => isAdmin(c),
    loadAccess: () => loadAccess(),
    appendAllowFrom: (c) => { appendAllowFrom(c) },
    ...(boot.sendAssistantText ? { sendAssistantText: (c, t) => boot.sendAssistantText!(c, t) } : {}),
    ...(boot.social ? { social: { wish: boot.social.wish, penpal: { startVisit: (c) => boot.social!.penpal.startVisit(c) }, intro: boot.social.intro } } : {}),
    ...(boot.penpal ? { penpal: boot.penpal } : {}),
    ...(boot.pairing ? { pairing: boot.pairing } : {}),
    socialState: () => socialState(opts.subsystems?.(), loadAgentConfig(stateDir), !!boot.social),
    guestRequests,
    hydrateRoute,
    sendMessage: (c, t) => ilink.sendMessage(c, t).then(r => r as { error?: string }),
    redispatch: (run) => pipelineOf(late, 'guest approve redispatch')(run),
    log: (tag, line) => log(tag, line),
  })
  // Owner notification for the guest branch — resolveAdminChatId
  // (admins-membership-based), NEVER resolveOperatorChatId (mw-identity has
  // already written a conversations row for this stranger by the time
  // mw-access runs, which would make them a resolveOperatorChatId candidate
  // — spec §0). Direct ilink.sendMessage, same pattern as main.ts's
  // degraded-subsystem admin summary (~:487-501) — the guest's text is
  // truncated/escaped by mw-access BEFORE it ever reaches this closure, and
  // never passes through a prompt.
  // 经 CC 开口那道门(guest_request,blocking);交给门就算办完,重试归待说队列(inbound/guest-notify.ts)
  const notifyOwnerOfGuest = makeGuestOwnerNotify({ speech: () => speech, adminChatId: () => resolveAdminChatId(loadAccess(), loadCompanionConfig(stateDir), null), log: (t, l) => log(t, l) })
  // 记忆(src/features/memory,经 index.ts):LLM 记忆操作、每晚整理;欢迎时的观察(side-effects.ts)。
  const { memoryLlmOps, memoryNightly } = wireMemory({ stateDir, db, boot, chatPrefs, careLedger, speech, log })
  const maybeWriteWelcomeObservation = makeMaybeWriteWelcomeObservation({
    stateDir,
    db,
    agentConfig: boot.agentConfig,
    getMode: (cid) => boot.coordinator.getMode(cid),
  })

  const adminCommandsHandler = makeAdminCommands({
    stateDir, isAdmin,
    sessionState: ilink.sessionState,
    pollHandle: {
      stopAccount: (id) => late.polling()?.stopAccount(id) ?? Promise.resolve(),
      stopAccountAndWait: async (id) => { await late.polling()?.stopAccountAndWait(id) },
      running: () => late.polling()?.running() ?? [],
    },
    resolveUserName: (cid) => ilink.resolveUserName(cid),
    sendMessage: send,
    sharePage: (t, c, o) => ilink.sharePage(t, c, o),
    // /reset and /health ai need to see the same registry/sessionManager/
    // sessionStore the coordinator drives — that's how dropping a session
    // here is visible on the next inbound dispatch.
    resolveProject: boot.resolve,
    registry: boot.registry,
    sessionManager: boot.sessionManager,
    sessionStore: boot.sessionStore,
    log,
    startedAt: STARTED_AT_ISO,
    // busy-registry hold (spec 2026-08-11 §2) — 整理记忆/派活 are dispatched
    // fire-and-forget outside SessionManager; boot.holdBusy is the same
    // registry the self-restart idle check reads.
    holdBusy: boot.holdBusy,
    getBotName,
    setBotName,
    botNameFallback: (cid) => botNameFromModeFallback(boot.coordinator.getMode(cid)),
    // Follows the admin conversation's provider (decided design); falls back
    // to the registry's cheapest eval when the mode isn't solo / unknown.
    // Delegates to the shared factory (src/features/memory/llm-ops.ts) so this path and
    // the internal-api routes the desktop calls resolve cheapEval identically.
    synthesizeMemory: (adminChatId) => memoryLlmOps.synthesize(adminChatId),
    readCuratedMemory: async () => memoryNightly.readCurated(),
    runMemoryNightlyNow: () => memoryNightly.runNow(),
    // Read back the synthesized overview so the admin can see what the bot
    // understands about them ("看记忆" / "你对我的理解" from WeChat).
    readOverview: async (adminChatId) => {
      const { readFile } = await import('node:fs/promises')
      const { OVERVIEW_FILENAME } = await import('../../lib/memory-synthesis')
      try { return await readFile(join(stateDir, 'memory', adminChatId, OVERVIEW_FILENAME), 'utf8') }
      catch { return null }
    },
    // 粘一串配对码进微信 = 加一台手。大脑那台**就是绑了微信的那台**,
    // 让 owner 为了粘一串码去开终端没道理。内部就是 CLI 的 `hand join`。
    joinHandByCode: async (code: string) => {
      const { joinHand } = await import('../../cli/hand-pairing')
      try {
        const r = await joinHand(stateDir, { code, selfId: boot.selfId })
        if (!r.ok) return { ok: false as const, error: r.error ?? 'pair_failed' }
        const rec = boot.a2aDeps?.registry.get(r.id)
        return { ok: true as const, id: r.id, name: rec?.name ?? r.id, url: r.url }
      } catch (err) {
        return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
      }
    },
    // 列出已配对的手 —— 把「名字打错就列出来」那点发现性还回去
    // (触发器改成按名字认之后,它在那条路上被拿掉了,见 matchDelegate)。
    listHands: () => {
      const a2a = boot.a2aDeps
      if (!a2a) return []
      try {
        return a2a.registry.list()
          .filter(h => h.capabilities?.includes('exec'))
          .map(h => ({ id: h.id, name: h.name || h.id, ...(h.url ? { url: h.url } : {}) }))
      } catch { return [] }
    },
    // 微信里的「背包」速览。读同一张 journal —— 桌面端那个区块是它的
    // 可编辑版。读失败返回空数组而不是抛:一次查询挂掉不该让整条 admin
    // 命令链断在这里。
    huntBag: () => {
      if (!opts.journal?.list) return []
      try { return opts.journal.list(50) } catch { return [] }
    },
    // 触发器按**已注册的手名**认派活(不按动词)—— 见 admin-commands 的
    // matchDelegate。id 和 name 都给,两种叫法都能触发。
    knownHandNames: () => {
      const a2a = boot.a2aDeps
      if (!a2a) return []
      try {
        return a2a.registry.list()
          .filter(h => h.capabilities?.includes('exec'))
          .flatMap(h => (h.name && h.name !== h.id ? [h.id, h.name] : [h.id]))
      } catch { return [] }
    },
    // Delegate a task to a registered "hand" (another machine running wechat-cc
    // with A2A exec). Resolves the hand by id or name, routes ws hands through
    // the hub and push hands via HTTP /a2a/exec (one-brain-many-hands).
    delegateToHand: async (handName, task) => {
      const a2a = boot.a2aDeps
      if (!a2a) return { ok: false as const, reason: 'A2A 未启用(agent-config 没配 a2a_listen / 没注册手)' }
      // T2 review finding (split identity) — this used to independently
      // resolve `process.env.WECHAT_A2A_SELF_ID || 'wechat-cc'`, so a
      // slug-minting daemon (spec §2) broadcast one identity via
      // wireSocial/wirePairing and a DIFFERENT ('wechat-cc') identity here.
      // boot.selfId is resolved exactly once at bootstrap and shared by
      // every outbound seam — see Bootstrap['selfId']'s doc comment.
      const selfId = boot.selfId
      const timeoutMs = Number(process.env.WECHAT_A2A_EXEC_TIMEOUT_MS) || DEFAULT_DELEGATE_TIMEOUT_MS
      // Stub hub: when Part B hasn't wired yiHub yet, ws hands fall back to
      // a graceful offline error rather than crashing.
      const stubHub: Pick<YiHub, 'dispatchTask' | 'isConnected'> = {
        dispatchTask: () => Promise.resolve({ ok: false, reason: 'ws_hub_unavailable' }),
        isConnected: () => false,
      }
      const hub = (boot as { yiHub?: Pick<YiHub, 'dispatchTask' | 'isConnected'> }).yiHub ?? stubHub
      return makeDelegateToHand({
        listHands: () => a2a.registry.list(),
        hub,
        pushDelegate: async (hand, dispatch, sid, tms) => {
          const { delegateToHand: doDelegate } = await import('../../app/a2a-delegate')
          const { createA2AClient } = await import('../../adapters/a2a/a2a-client')
          execA2AClient ??= createA2AClient({ timeoutMs: tms })
          return doDelegate(execA2AClient, { hand, selfId: sid, prompt: dispatch.prompt })
        },
        selfId,
        timeoutMs,
      })(handName, task)
    },
    // 微信「自改 <需求>」的执行端(spec 2026-09-18)。流水线最后要部署 + 重启
    // 这个 daemon,所以只能 detached 起独立进程 —— 同 updateSelf 的理由。
    selfChange: makeSelfChangeSpawner({
      resolve: () => resolveSelfCli({
        compiled: isCompiledBundle(),
        execPath: process.execPath,
        repoRoot: REPO_ROOT,
        bunPath: findOnPath('bun'),
        exists: existsSync,
      }),
      spawn,
      env: process.env,
      stateDir,
      cwd: REPO_ROOT,
      log: (line) => log('SELF_CHANGE', line),
    }),
    updateSelf: async () => {
      if (!existsSync(CLI_ENTRY)) return { ok: false as const, reason: 'source_cli_not_found' }
      const bun = findOnPath('bun')
      if (!bun) return { ok: false as const, reason: 'bun_not_found' }
      const child = spawn(bun, [CLI_ENTRY, 'update', '--json'], {
        cwd: REPO_ROOT,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: process.env,
      })
      child.unref()
      return { ok: true as const, pid: child.pid }
    },
  })


  // 主人的 chat:设置面板与微信管家都要,算一次(评审 2026-09-16 去重)。
  const ownerChatId = () => resolveAdminChatId(loadAccess(), loadCompanionConfig(stateDir), null)
  // 「一件事」的活动时间(spec 2026-10-01 §3):微信入站与工作台事件节流地推 updated_at。随 daemon 常驻。
  const matterActivity = opts.matters ? makeMatterActivity({ touch: id => opts.matters!.touch(id), log: (tag, line) => log(tag, line) }) : null
  // 回调里只记一笔(note 不同步写库,见 matter-activity.ts 头注释)。stop 退订 + 清定时器,main.ts 登记进 shutdown。
  const stopMatterActivity = wireMatterActivity(matterActivity, opts.workbench?.changes)
  // App 里跟 CC 说一句(重构第二批步 6c,wire-converse.ts):提到「一件事」与手机对话之前,两处直接拿它,不再靠「在下面才定义」的捕获。
  const companionConverse = wireCompanionConverse({
    stateDir, boot, careLedger, replySinks, messagesStore, ilink, log,
    appTurn: () => late.appTurn?.() ?? null,
    matters: opts.matters, petSignals: opts.petSignals, stickers: opts.stickers,
  })

  // 「一件事」读写面:工作台续接 + 对主人 chat 的 app 通道;手机页与内部 API 共用这一个实例。
  const mattersService = opts.matters ? makeMattersService({
    store: opts.matters,
    ownerChatId,
    // 执行者叫什么(收敛清单 ⑥):唯一出处是 registry,三端只读 agentNames。
    executorName: (id: string) => boot.registry.namesOf(id).name,
    ...(opts.workbench ? { workbench: opts.workbench } : {}),
    chat: {
      ownerChatId,
      say: (text: string, surface?: 'desktop' | 'phone') => companionConverse(text, surface ?? 'desktop'),
      // Retain stored reply extras, including attachment-only rows; paths stay in the daemon.
      file: makeOwnerChatFileReader({ownerChatId,inboxDir:join(stateDir,'inbox'),readChunk:fileChunkResponse,stickerDir:join(stateDir,'stickers'),message:(chatId,id)=>messagesStore.get(chatId,id)}),
      recent: async (chatId: string, limit: number) => (await messagesStore.listRange(chatId, { limit })).map(row=>ownerChatReadingEvent(row,join(stateDir,'inbox'))).filter(r => r.text.trim() !== '' || r.replyExtras),
      search: async (chatId: string, query: string, limit: number) => (await messagesStore.search(chatId, query, limit)).map(r => ({ id: r.id, kind: r.direction === 'in' ? 'user' as const : 'text' as const, text: r.text, createdAt: Date.parse(r.ts), source: r.source })),
    },
    // 手机对聊天那件事「说一句」按 requestId 去重(v70,与工作台输入回执同一规矩)。
    sayReceipts: makeSayReceipts(db),
    originOf: surfaceOrigin,
  }) : null
  // 「CC 的连接」与「CC 现在怎么样」(重构第二批步 6c,wire-connections.ts)。
  // 配对过的手机数从设置面板读,面板又要 connections 当值 —— 真环。显式的晚绑定:手机那一簇建好之后才填;
  // 没填 ⇒ 0(不靠 try/catch 吞 TDZ,catch 只留给真的读失败,#488 评审)。
  const phoneDevices: { current: (() => number) | null } = { current: null }
  const connections = wireConnections({
    stateDir, boot, ilink, ownerChatId,
    phoneDevices: () => phoneDevices.current?.() ?? 0,
    ...(opts.workbench ? { workbench: opts.workbench } : {}),
    ...(opts.guardRuntime ? { guardRuntime: opts.guardRuntime } : {}),
    ...(opts.terminalHooks ? { terminalHooks: opts.terminalHooks } : {}),
    ...(opts.subsystems ? { subsystems: opts.subsystems } : {}),
    ...(opts.providerRefusals ? { providerRefusals: opts.providerRefusals } : {}),
  })
  // 手机那一簇(重构第二批步 6c,wire-phone.ts):推送 / 主人对话 / 手机对话 / App 主动通道 / 媒体镜像 / 设置面板 / 隧道 / notifier / 订阅。
  // 簇里的环在 wirePhone 里面解(显式的 late 对象);这里只拿结果。关机停它的那一项 main.ts 登记在 polling 之前。
  const phone = wirePhone({
    opts, stateDir, db, boot, ilink, log, chatPrefs, messagesStore,
    ownerChatId, matterActivity, companionConverse, mattersService, memoryNightly, connections, speech,
  })
  phoneDevices.current = () => phone.settingsPanel.phoneDevices().length
  const { appPush, companionApp, phoneChat, settingsPanel } = phone
  if (companionApp) companionAppRef.set(companionApp)


  const modeHandler = makeModeCommands({
    socialState: () => socialState(opts.subsystems?.(), loadAgentConfig(stateDir), !!boot.social),
    // 设免打扰时撞上的早报 / 周报当场说(定时那份存在文件里,每次现读,另起一个只读实例不会读到旧的)
    initiativeJobTimes: () => makeJobsStore(stateDir).list().jobs.filter(j => j.brief || j.recap).map(j => ({ label: j.brief ? '早报' : '周报', at: j.schedule.at })),
    coordinator: boot.coordinator,
    registry: boot.registry,
    defaultProviderId: boot.defaultProviderId,
    agentConfig: boot.agentConfig,
    sendMessage: send,
    setUserName: (cid, name) => ilink.setUserName(cid, name),
    getUserName: (cid) => ilink.resolveUserName(cid) ?? null,
    // /api list · alias · /set cheap 的读写面 —— 全走 agent-config(mtime
    // 缓存读)/ config-surface(写),和面板同一条路。
    readConfig: () => {
      const c = loadAgentConfig(stateDir)
      return { openaiBaseUrl: c.openaiBaseUrl, openaiModel: c.openaiModel, openaiAliases: c.openaiAliases, cheapEvalProvider: c.cheapEvalProvider, trusted_providers: c.trusted_providers }
    },
    setOpenaiAlias: (alias, model) => {
      const c = loadAgentConfig(stateDir)
      const next = { ...(c.openaiAliases ?? {}) }
      if (model === null) delete next[alias]
      else next[alias] = model
      const { openaiAliases: _drop, ...rest } = c
      saveAgentConfig(stateDir, Object.keys(next).length > 0 ? { ...rest, openaiAliases: next } : rest)
    },
    setConfig: async (key, value) => {
      const r = await writeConfigKey(stateDir, key, value)
      return r.ok ? { ok: true } : { ok: false, error: r.error, detail: r.detail }
    },
    openaiModels: makeOpenaiModels({
      baseUrl: () => loadAgentConfig(stateDir).openaiBaseUrl,
      apiKey: () => process.env.WECHAT_OPENAI_API_KEY,
    }),
    providerNotes: () => boot.providerNotes?.() ?? {},
    ...(opts.requestRestart ? { requestRestart: (reason: string) => opts.requestRestart!(reason) } : {}),
    chatPrefs,
    log,
    isAdmin,
    settingsPanelLink: () => settingsPanel.linkUrl(),
    // /agy's tier-C guest gate (mode-commands.ts) — same loadAccess() +
    // resolveTier() pairing the coordinator's own resolveTier closure uses
    // (bootstrap/index.ts). loadAccess() has a 5s in-process TTL cache, so
    // this is cheap to call per inbound.
    //
    // DELIBERATELY does NOT mirror bootstrap/index.ts's resolveTier closure
    // in full: that one short-circuits to 'admin' when
    // `deps.dangerouslySkipPermissions` is set (the global --dangerously
    // override). This gate omits that branch on purpose — agy's tier-C MCP
    // config carries ONE long-lived 'trusted' token shared by every
    // conversation agy runs, with no per-session isolation (agy-mcp-
    // config.ts), so a guest chat must stay refused even on a
    // --dangerously-run daemon. Fail closed on that shared-token hazard;
    // do NOT "fix" this into parity with the coordinator's closure.
    resolveTier: (chatId) => resolveTier(chatId, loadAccess()),
  })

  const onboardingHandler = makeOnboardingHandler({
    isKnownUser: (uid) => ilink.resolveUserName(uid) !== undefined,
    setUserName: (cid, name) => ilink.setUserName(cid, name),
    sendMessage: async (cid, txt) => { await send(cid, txt) },
    botName: (cid) => botName(boot.coordinator.getMode(cid), boot.agentConfig),
    dispatchInbound: async (msg) => {
      // Re-fire this inbound through the normal pipeline. Onboarding has
      // already cleared its awaiting state and persisted the nickname, so
      // mw-onboarding will short-circuit (isKnownUser=true) and the message
      // flows to the provider as if it were just received.
      //
      // redispatch:true is load-bearing, not cosmetic — mw-dedup already
      // marked this exact message id "handled" at the end of turn 1 (SAME
      // boot, no restart involved), so without the flag this re-fire is
      // silently swallowed by mw-dedup's isHandled short-circuit and the
      // user's original question never reaches the provider.
      await pipelineOf(late, 'onboarding echo dispatch')({
        msg,
        receivedAtMs: Date.now(),
        requestId: randomBytes(4).toString('hex'),
        redispatch: true,
      })
    },
    log,
    isAdmin,
    getBotName,
    setBotName,
    stateDir,
  })

  // 命令表(重构第二批步 2 / 3b,spec §1):入站只有一站「命令」查这张表。**顺序就是优先级**(ids 就是真实顺序):
  // 任务 …(工作台)→ 管理员 → (各命令声明的 /词:/cli /today /visit,由 registry 排在兜底之前)→ mode(认任何 /词的兜底)→ 上手(没见过的用户 / 起名阶段的每一句)
  // → 权限 y/n → 文本命令(定时 / 日历 / 做过的事 / 经验 / 导入记忆 / 终端)→ 控制命令(串门 / 回信 / 配对 / 派 / 认识 / 访客)。
  // group 沿用老的 consumedBy 标签,trace、welcome、milestone、activity 不用改。
  // 管家「你说的是哪一件?回数字」开到什么时候(按对话):命令表据此把数字让给它。
  const butlerChoice = new Map<string, OpenChoice>()
  const consumePermissionAnswer = makePermissionAnswer({ ilink, log })
  const commandRegistry = makeCommandRegistry([
    // 「任务 …」(工作台控制,步 4):排第一 —— 以前是单独一种 intent,排在整张命令表之前。
    ...(opts.workbench ? [makeTaskCommand({ handleWechat: opts.workbench.handleWechat, sendMessage: (chatId: string, text: string) => send(chatId, text, { source: 'workbench' }) })] : []),
    // 管理员命令一条一行(第三批 3d,admin-commands.ts 的 commands()):admin.owner-only(非主人发显式命令)+ admin.<id>,两两互斥
    ...adminCommandsHandler.commands(),
    // 斜杠命令一条一行(第三批 3d,mode-commands.ts 的 commands()):mode.provider / set / … / help,最后 mode.unknown 是 /词兜底
    ...modeHandler.commands(),
    { id: 'onboarding', group: 'onboarding', probe: (m) => onboardingHandler.probe(m), handle: (m) => onboardingHandler.handle(m) },
    { id: 'permission-reply', group: 'permission-reply',
      probe: (m) => ilink.probePermissionReply(m.text ?? '', m.chatId, m.quote?.text),
      // 和 poll loop 的快车道同一个消费函数(daemon/permission-answer.ts)。
      handle: async (m) => consumePermissionAnswer(m) },
    // 文本命令里有早报拍板的「回 2」:管家的「哪一件?回数字」开着时,数字让给管家(整合者评审 #659)。
    ...yieldNumbersToOpenChoice(opts.commands ?? [], (c, text) => choiceTakes(text, butlerChoice.get(c), Date.now())),
    // 控制命令一条一行(第三批 3d,command-router.ts 的 makeControlCommands):control.social-off → visit(认 /visit)→ letter → pair → wish → intro → guest
    ...controlCommands,
  ])

  const pipelineDeps: InboundPipelineDeps = {
    trace: { log },
    identity: {
      upsertIdentity: (cid, ids) => boot.conversationStore.upsertIdentity(cid, ids),
    },
    access: {
      // loadAccess() has a 5s in-process TTL cache — safe to call per inbound.
      loadAccess,
      log,
      // Guest path (spec §2) — all six wired together; mw-access falls
      // back to the legacy silent drop if any one of them were absent.
      guestRequests,
      hydrateChatRoute: hydrateGuestChatRoute,
      sendMessage: (c, t) => ilink.sendMessage(c, t),
      notifyOwner: notifyOwnerOfGuest,
      budget: guestForwardBudget,
      // Injected (fix round 1, DI-convention fold #10) — mw-access no
      // longer imports appendAllowFrom directly, matching every other
      // side effect on this interface.
      appendAllowFrom,
    },
    capture: {
      markChatActive: (c, a) => ilink.markChatActive(c, a),
      captureContextToken: (c, t) => ilink.captureContextToken(c, t),
      onContextAvailable:(c,a)=>opts.workbench?.contextAvailable(c,a),
    },
    typing: { sendTyping: (c, a) => ilink.sendTyping(c, a) },
    ...(opts.matters?{matter:{ensureChat:ensureChatAndNote((c:string)=>opts.matters!.ensureChat(c,undefined,'wechat'),matterActivity),log:(t:string,l:string)=>log(t,l)}}:{}),
    ...(opts.workbench?{taskReference:{
      ownerChatId,
      noteChoice:(c:string,e:OpenChoice|null)=>{ if(e===null) butlerChoice.delete(c); else butlerChoice.set(c,e) },
      // 可指称的候选:七天内动过、未归档的任务,包括失败 / 中断的 —— 主人问"那件怎么了"
      // 时它得还在;焦点指向的任务失败了也不能凭空消失(真机 2026-09-16:Codex 额度耗尽
      // 把任务打成 failed,焦点随之静默失效,后面两句掉进了普通聊天)。项目显示名用目录名。
      candidates:():TaskCandidate[]=>{
        const since=Date.now()-7*24*60*60_000
        const tasks=opts.workbench!.list({archived:'exclude',limit:50}).tasks
          .filter(t=>t.phase!=='cancelled'&&t.updatedAt>=since)
          .sort((a,b)=>b.updatedAt-a.updatedAt)
        // 有「一件事」登记处时以它为准:候选就是"最近动过的事",顺序也是它的顺序;任务详情仍从工作台取。
        const ordered=opts.matters
          ?(()=>{const byId=new Map(tasks.map(t=>[t.id,t]));return opts.matters!.list({kind:'task',statuses:['open','replied','done'],since,limit:50}).flatMap(m=>{const t=byId.get(m.id);return t?[t]:[]})})()
          :tasks
        return ordered.map(t=>({id:t.id,title:t.title,project:pathBasename(t.path),path:t.path,providerId:t.providerId,phase:t.phase,updatedAt:t.updatedAt,error:t.error}))
      },
      // 额度止损:这家耗尽就不再往它送,问"交给另一位继续?";「是」就在同一文件夹给另一位新开一件。
      quotaExhausted:(id:string)=>opts.workbench!.quotaExhausted(id),
      fallbackExecutor:(id:string)=>opts.workbench!.fallbackExecutor(id),
      // 额度恢复后接着做(2026-10-20):主人回「等恢复」⇒ 排一次,只试一次。
      quotaResume:(id:string)=>opts.workbench!.quotaResume(id),
      watchTask:async(taskId:string,accountId:string)=>{opts.workbench!.setWechatWatch(taskId,accountId,true)},
      // 换人接着做:新那件的出生地跟着被接手的那件走(同 service/quota-handoff);那件不知道 ⇒ 也不写。
      createTask:async({fromTaskId,...input}:{path:string;providerId:string;text:string;fromTaskId?:string})=>{
        let origin:import('../../ports/matters').MatterOrigin|null=null
        try{origin=fromTaskId?opts.matters?.get(fromTaskId)?.origin??null:null}catch{/* 查不到就不写 */}
        const task=await opts.workbench!.create({...input,origin});return {id:task.id}
      },
      handleWechat:opts.workbench.handleWechat,
      sendMessage:(chatId:string,text:string)=>send(chatId,text,{source:'workbench'}),
      // 便宜模型只在名称命中多件 / 零命中且无焦点时被问,且只能选编号或说 0。没配就只走确定性各层。
      ...(boot.registry.getCheapEval()?{judge:makeCheapJudge(boot.registry.getCheapEval()!)}:{}),
      log,
    }}:{}),
    // 意图路由(第一步只记 trace 不改决策):探针全是各消费者自己交出来的只读判定。
    route: {
      probes: {
        command: (ctx) => commandRegistry.probe(ctx.msg),
      },
      ...(opts.matters ? { matterFor: (chatId: string) => opts.matters!.findBySurface('wechat', chatId)?.id ?? null } : {}),
      log,
    },
    commands: { registry: commandRegistry, log },
    attachments: { materializeAttachments, inboxDir, log },
    transcribeVoice: {
      // ilink.voice.transcribe loads STT config internally and throws
      // `no_stt_config` when unset — the middleware catches it (no-op).
      transcribeVoice: (audio, mime) => ilink.voice.transcribe!(audio, mime),
      log,
    },
    dedup: {
      isHandled: id => dedupStore.isHandled(id),
      markHandled: id => dedupStore.markHandled(id, new Date().toISOString()),
      recordAttempt: id => dedupStore.recordAttempt(id, new Date().toISOString()),
      log,
    },
    messages: {
      append: rec => messagesStore.append(rec),
      log,
      // self-restart (spec 2026-08-03-daemon-self-restart-on-stale-code) —
      // undefined when boot.markInboundActivity is absent (deps.requestRestart
      // wasn't wired into buildBootstrap, so the whole mechanism is inert).
      // mw-messages treats this as optional and no-ops when it's missing.
      markInboundActivity: boot.markInboundActivity,
    },
    activity: {
      // Piggyback the ingest nudge on the per-new-inbound recordInbound call:
      // fresh WeChat activity means new data to fold into the knowledge base.
      // Trailing-debounced + gated inside registerIngest, so this is O(1) here.
      recordInbound: (chatId, when) => { late.ingestNudge()?.(); return recordInbound(chatId, when) },
      resetCareNoReply: (c) => careLedger.resetNoReply(c),
      log,
    },
    milestone: { fireMilestonesFor, log },
    welcome: { maybeWriteWelcomeObservation, log },
    recall: {
      isAdmin,
      log,
      // Non-admin lane — deterministic keyword recall over the chat's OWN
      // memory files only (same subtree memory_read grants it). Sync under
      // the hood; wrapped to satisfy the middleware's async contract.
      recallFallback: async (chatId: string, text: string) => recallFromMemory(stateDir, chatId, text, memoryFactsFor(db, stateDir)),
      // Auto-recall (2026-08 memory-upgrades) — hybrid search over the
      // knowledge kernel, embedder-fallback shape mirrors POST /v1/knowledge/
      // search (routes-knowledge.ts): the shared embedder is the single
      // source of truth for the model space, so query and index always live
      // in the same space. Absent embedder/embedQuery ⇒ dep stays undefined
      // and mw-recall is inert (same gating as the route's 400 fallback).
      ...(boot.knowledge?.embedQuery && boot.knowledge.embedder
        ? {
            recall: async (_chatId: string, text: string) => {
              const k = boot.knowledge!
              const vec = await k.embedQuery!(text)
              const { results } = k.search(k.store, {
                queryVector: vec,
                queryText: text,
                model_id: k.embedder!.model_id,
                limit: 3,
              })
              return results.map((r) => {
                // source.db stamps seconds; tolerate ms just in case.
                const ts = new Date(r.time * (r.time < 1e12 ? 1000 : 1)).toISOString().slice(0, 10)
                return `[${ts} ${r.sender}] ${r.text.slice(0, 160)}`
              })
            },
          }
        : {}),
    },
    llmHealth: {
      health: boot.health.health,
      sendMessage: (c, t) => ilink.sendMessage(c, t).then(r => r as { msgId: string }),
      now: () => Date.now(),
      log,
    },
    dispatch: {
      coordinator: {
        // Async foraging spine — an operator "揭晓 <id>" reply triggers the
        // reveal flow (their action IS their consent) instead of dispatching a
        // normal agent turn. Try the echo side first; a null lookup means the
        // id is a pledge (I answered THEIR wish), so fall back to revealPledge.
        // Anything that isn't a reveal command falls through to a normal turn.
        // T9 — when BOTH lookups come back null (typo / expired / already-
        // connected id), the operator previously got silence; now a gentle
        // one-line "not found" reply so a mistyped id doesn't look like the
        // bot ignored them.
        // 管理员控制命令(揭晓/回信/配对/派/访客许可)由 command-router 处理;
        // 命中即止,否则落到正常 agent 分发。逻辑本体见 command-router.ts。
        dispatch: async (msg) => {
          // 桌宠「起飞了」的时刻(spec §5.1)。定义:一个「回合」= 从入站分发
          // 或 converse 进来的那一趟。所以记在命令路由**之后** —— 一句「待批准」
          // 被路由自己答掉了,桌宠不该说它在想事情。记在这里而不是 coordinator
          // 里,是因为不是每个 provider 都发 init 事件,而每条入站都从这儿过。
          opts.petSignals?.noteTurnStart(msg.chatId)
          try {
            return await boot.coordinator.dispatch(msg)
          } finally {
            // 成对:dispatch 抛错 / 被中途丢弃时 recordTurn 可能根本不响,
            // 起飞标记会永久挂着,桌宠就永远显示「在想」。noteTurnStop 只撤
            // 起飞标记;「刚忙完」那一笔仍然归 recordTurn。
            opts.petSignals?.noteTurnStop(msg.chatId)
          }
        },
      },
    },
  }

  // 桌宠的「在做什么」(重构第二批步 6c,wire-pet-turn.ts)
  const petTurn = wirePetTurn({ stateDir, ilink: opts.ilink, petSignals: opts.petSignals, boot, messagesStore })


  return { stopPhone: () => phone.stop(), appPush, companionApp, proactive, speech, pipelineDeps, companionConverse, petTurn, mattersService, memoryNightly, stopMatterActivity, settingsPanelLink: () => settingsPanel.linkUrl(), phoneChat, connections, phoneConnect: { link: (o) => settingsPanel.phoneLink(o), devices: () => settingsPanel.phoneDevices() } }
}

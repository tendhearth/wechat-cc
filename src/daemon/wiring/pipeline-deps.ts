/**
 * Pipeline dep builder — admin/mode/onboarding handler construction +
 * 13-mw deps assembly into InboundPipelineDeps.
 *
 * Refs are passed in for late-bound polling/guard access from closures.
 */
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import type { Ref } from '../../lib/lifecycle'
import type { IlinkAdapter } from '../ilink-glue'
import type { Bootstrap } from '../bootstrap'
import type { GuardLifecycle } from '../guard/lifecycle'
import type { PollingLifecycle } from '../polling-lifecycle'
import type { InboundPipelineDeps } from '../inbound/build'
import type { PipelineRun } from '../inbound/types'
import { isAdmin, loadAccess } from '../../lib/access'
import { makeAdminCommands } from '../admin-commands'
import { makeModeCommands } from '../mode-commands'
import type { ChatPrefsStore } from '../chat-prefs'
import type { CareLedger } from '../companion/care-ledger'
import type { ReplySinks } from '../reply-sinks'
import { loadCompanionConfig } from '../companion/config'
import type { InboundMsg } from '../../core/prompt-format'
import { parseRevealCommand } from '../../core/reveal-command'
import { parseLetterCommand } from '../../core/penpal-letter-command'
import { parsePairCommand } from '../../core/pair-command'
import { parseSeekCommand, resolveSeekRef } from '../../core/seek-command'
import { makeOnboardingHandler } from '../onboarding'
import { botName, botNameFromModeFallback } from '../bot-name'
import { loadAgentConfig, saveAgentConfig, withModelForProvider } from '../../lib/agent-config'
import { findOnPath } from '../../lib/util'
import type { A2AAgentRecord } from '../../lib/agent-config'
import { materializeAttachments } from '../media'
import { loadGuardConfig } from '../guard/store'
import { makeFireMilestonesFor, makeRecordInbound, makeMaybeWriteWelcomeObservation } from './side-effects'
import { makeMessagesStore } from '../../lib/messages-store'
import { makeDedupStore } from '../../lib/dedup-store'
import type { YiHub, YiDispatch } from '../../core/yi-hub'
import type { ExecResult } from '../../core/a2a-server'
import type { Mode, ProviderId } from '../../core/conversation'

export interface DelegateDeps {
  listHands: () => readonly A2AAgentRecord[]
  hub: Pick<YiHub, 'dispatchTask' | 'isConnected'>
  pushDelegate: (hand: A2AAgentRecord, task: YiDispatch, selfId: string, timeoutMs: number) => Promise<ExecResult>
  selfId: string
  timeoutMs: number
}

export interface OwnerSessionKeyDeps {
  resolveProject: (chatId: string) => { alias: string; path: string } | null
  getMode: (chatId: string) => Mode
  defaultProviderId: ProviderId
}

/**
 * Resolves the (alias, providerId) session-manager key for a chat the SAME
 * way ConversationCoordinator.dispatch resolves it internally (resolveProject
 * + mode → provider), mirroring the provider-derivation chain tick-bodies.ts's
 * dispatchToChat uses before its own isInFlight check. Exported/pure so the
 * app-conversation-channel in-flight guard (companionConverse below) is unit
 * testable without constructing a full Bootstrap.
 *
 * Used to check SessionManager.isInFlight with the EXACT key a real dispatch
 * will acquire — so an app /converse turn (companionConverse) refuses to
 * start while a WeChat turn is in flight on the owner's session. Without
 * this, a WeChat message and an app /converse racing on the owner's
 * default_chat_id both resolve the same SessionManager handle and dispatch
 * concurrently on one AgentSession → corruption (e.g. the openai provider
 * pushes to a shared mutable history array with no self-guard). Spec §3
 * (app-conversation-channel Task 2, HIGH review finding).
 *
 * Returns null when the chat has no resolvable project — dispatch would
 * drop the message in that case too, so there's nothing to guard.
 */
export function resolveOwnerSessionKey(chatId: string, deps: OwnerSessionKeyDeps): { alias: string; providerId: ProviderId } | null {
  const proj = deps.resolveProject(chatId)
  if (!proj) return null
  const mode = deps.getMode(chatId)
  const providerId =
    mode.kind === 'solo' ? mode.provider
    : mode.kind === 'primary_tool' ? mode.primary
    : (mode.participants?.[0] ?? deps.defaultProviderId)
  return { alias: proj.alias, providerId }
}

export function makeDelegateToHand(deps: DelegateDeps) {
  return async (handName: string, task: string): Promise<ExecResult & { knownHands?: string[] }> => {
    const hands = deps.listHands().filter(a => a.capabilities?.includes('exec'))
    const hand = hands.find(a => a.id === handName || a.name === handName)
    if (!hand) return { ok: false, reason: 'unknown_hand', knownHands: hands.map(a => a.name || a.id) }
    const dispatch: YiDispatch = { peer: 'claude', prompt: task }
    if (hand.transport === 'ws') return deps.hub.dispatchTask(hand.id, dispatch, deps.timeoutMs)
    return deps.pushDelegate(hand, dispatch, deps.selfId, deps.timeoutMs)
  }
}

export interface PipelineDepsOpts {
  stateDir: string
  db: import('../../lib/db').Db
  ilink: IlinkAdapter
  boot: Bootstrap
  log: (tag: string, line: string, fields?: Record<string, unknown>) => void
  /**
   * Shared chat-prefs instance — constructed once in main.ts and also fed
   * to registerInternalApi's getChatPrefs, so the /set command and the
   * reply-route split logic read/write the SAME in-memory-cached store.
   */
  chatPrefs: ChatPrefsStore
  /**
   * Shared care-ledger instance — constructed once in main.ts, also fed to
   * pushTick (via WireMainOpts). The inbound activity middleware resets the
   * no-reply streak through this SAME store on every inbound message.
   */
  careLedger: CareLedger
  /**
   * Shared reply-sink registry (app-conversation-channel, voice arc Stage
   * 0, Task 1/2) — constructed once in main.ts, also fed to
   * registerInternalApi's `replySinks` so the `POST /v1/wechat/reply`
   * route captures into the SAME sink the converse closure below opens.
   * A second instance would never see the capture.
   */
  replySinks: ReplySinks
}

export interface PipelineDepsRefs {
  polling: Ref<PollingLifecycle>
  guard: Ref<GuardLifecycle>
  pipeline: Ref<PipelineRun>
  /** Late-bound ingest nudge — fired per new inbound so the knowledge base tracks fresh activity. */
  ingestNudge: Ref<() => void>
}

const STARTED_AT_ISO = new Date().toISOString()
const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..', '..')
const CLI_ENTRY = join(REPO_ROOT, 'cli.ts')

export interface BuildPipelineDepsResult {
  pipelineDeps: InboundPipelineDeps
  /**
   * App-conversation-channel converse closure (voice arc Stage 0, Task 2).
   * Late-bound onto internal-api by main.ts via setCompanionConverse()
   * once this returns — bootstrap (boot.coordinator) isn't available until
   * after buildPipelineDeps runs, so it can't be wired at internal-api
   * registration time (see main.ts's staged startup: internal-api first,
   * then bootstrap, then this wiring pass).
   */
  companionConverse: (text: string) => Promise<{ reply: string }>
}

export function buildPipelineDeps(opts: PipelineDepsOpts, refs: PipelineDepsRefs): BuildPipelineDepsResult {
  const { stateDir, db, ilink, boot, log, chatPrefs, careLedger, replySinks } = opts
  const inboxDir = join(stateDir, 'inbox')

  // A2A exec (delegate a task to a hand) runs a FULL agent on the hand —
  // often tens of seconds to minutes. The shared a2aDeps.client's 10s timeout
  // is tuned for notify/send; exec needs a long one. Lazily built + reused.
  let execA2AClient: import('../../core/a2a-client').A2AClient | undefined

  const fireMilestonesFor = makeFireMilestonesFor({ stateDir, db })

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

  const recordInbound = makeRecordInbound({ stateDir, db })
  const messagesStore = makeMessagesStore(db)
  const dedupStore = makeDedupStore(db)
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
      stopAccount: (id) => refs.polling.current?.stopAccount(id) ?? Promise.resolve(),
      stopAccountAndWait: async (id) => { await refs.polling.current?.stopAccountAndWait(id) },
      running: () => refs.polling.current?.running() ?? [],
    },
    resolveUserName: (cid) => ilink.resolveUserName(cid),
    sendMessage: (cid, txt) => ilink.sendMessage(cid, txt),
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
    getBotName,
    setBotName,
    botNameFallback: (cid) => botNameFromModeFallback(boot.coordinator.getMode(cid)),
    synthesizeMemory: async (adminChatId) => {
      const { synthesizeOverview } = await import('../../lib/memory-synthesis')
      const { makeLifeStoresReader } = await import('../life-stores')
      // Follow the admin conversation's provider (decided design); fall back
      // to the registry's cheapest eval when the mode isn't solo / unknown.
      const mode = boot.coordinator.getMode(adminChatId)
      const provider = mode && mode.kind === 'solo' ? mode.provider : undefined
      const cheapEval = (provider ? boot.registry.get(provider)?.provider.cheapEval : null) ?? boot.registry.getCheapEval()
      if (!cheapEval) throw new Error('no LLM provider available for synthesis')
      // Bridge the daemon db → life stores so the overview also folds in the
      // life-side memory (kept on the daemon side of the cli/daemon boundary).
      return synthesizeOverview({ stateDir, adminChatId, sdkEval: (p) => cheapEval(p), lifeStores: makeLifeStoresReader(db, stateDir), includeFileSurvey: true })
    },
    // Read back the synthesized overview so the admin can see what the bot
    // understands about them ("看记忆" / "你对我的理解" from WeChat).
    readOverview: async (adminChatId) => {
      const { readFile } = await import('node:fs/promises')
      const { OVERVIEW_FILENAME } = await import('../../lib/memory-synthesis')
      try { return await readFile(join(stateDir, 'memory', adminChatId, OVERVIEW_FILENAME), 'utf8') }
      catch { return null }
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
      const timeoutMs = Number(process.env.WECHAT_A2A_EXEC_TIMEOUT_MS) || 300_000
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
          const { delegateToHand: doDelegate } = await import('../../core/a2a-delegate')
          const { createA2AClient } = await import('../../core/a2a-client')
          execA2AClient ??= createA2AClient({ timeoutMs: tms })
          return doDelegate(execA2AClient, { hand, selfId: sid, prompt: dispatch.prompt })
        },
        selfId,
        timeoutMs,
      })(handName, task)
    },
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

  const modeHandler = makeModeCommands({
    coordinator: boot.coordinator,
    registry: boot.registry,
    defaultProviderId: boot.defaultProviderId,
    agentConfig: boot.agentConfig,
    sendMessage: (cid, txt) => ilink.sendMessage(cid, txt),
    setUserName: (cid, name) => ilink.setUserName(cid, name),
    getUserName: (cid) => ilink.resolveUserName(cid) ?? null,
    // `/api <model>` — read-modify-write agent-config.json via
    // withModelForProvider/saveAgentConfig (per-provider field, unlike the
    // POST /v1/model route which pins the GLOBAL default provider's model).
    // The daemon's mtime-cached config reader (currentModelFor,
    // bootstrap/index.ts) then delivers it to the next openai spawn, no restart.
    pinModel: (providerId, model) => {
      // Write the TARGET provider's own model field (openai→openaiModel), NOT
      // the global default provider's — so `/api <model>` pins openai even when
      // the global default is claude. Mirrors currentModelFor's per-provider
      // resolution (bootstrap/index.ts). mtime-cached reader delivers it next spawn.
      const current = loadAgentConfig(stateDir)
      saveAgentConfig(stateDir, withModelForProvider(current, providerId, model))
    },
    chatPrefs,
    log,
    isAdmin,
  })

  const onboardingHandler = makeOnboardingHandler({
    isKnownUser: (uid) => ilink.resolveUserName(uid) !== undefined,
    setUserName: (cid, name) => ilink.setUserName(cid, name),
    sendMessage: async (cid, txt) => { await ilink.sendMessage(cid, txt) },
    botName: (cid) => botName(boot.coordinator.getMode(cid), boot.agentConfig),
    dispatchInbound: async (msg) => {
      // Re-fire this inbound through the normal pipeline. Onboarding has
      // already cleared its awaiting state and persisted the nickname, so
      // mw-onboarding will short-circuit (isKnownUser=true) and the message
      // flows to the provider as if it were just received.
      await refs.pipeline.deref('onboarding echo dispatch')({
        msg,
        receivedAtMs: Date.now(),
        requestId: randomBytes(4).toString('hex'),
      })
    },
    log,
    isAdmin,
    getBotName,
    setBotName,
  })

  const pipelineDeps: InboundPipelineDeps = {
    trace: { log },
    identity: {
      upsertIdentity: (cid, ids) => boot.conversationStore.upsertIdentity(cid, ids),
    },
    access: {
      // loadAccess() has a 5s in-process TTL cache — safe to call per inbound.
      loadAccess,
      log,
    },
    capture: {
      markChatActive: (c, a) => ilink.markChatActive(c, a),
      captureContextToken: (c, t) => ilink.captureContextToken(c, t),
    },
    typing: { sendTyping: (c, a) => ilink.sendTyping(c, a) },
    admin: { adminHandler: adminCommandsHandler },
    mode: { modeHandler },
    onboarding: { onboardingHandler },
    permissionReply: {
      handlePermissionReply: (text: string) => ilink.handlePermissionReply(text),
      log,
    },
    guard: {
      guardEnabled: () => loadGuardConfig(stateDir).enabled,
      guardState: () => refs.guard.current?.current() ?? { reachable: true, ip: null },
      sendMessage: (c, t) => ilink.sendMessage(c, t).then(r => r as { msgId: string }),
      log,
    },
    attachments: { materializeAttachments, inboxDir, log },
    dedup: {
      isHandled: id => dedupStore.isHandled(id),
      markHandled: id => dedupStore.markHandled(id, new Date().toISOString()),
      recordAttempt: id => dedupStore.recordAttempt(id, new Date().toISOString()),
      log,
    },
    messages: {
      append: rec => messagesStore.append(rec),
      log,
    },
    activity: {
      // Piggyback the ingest nudge on the per-new-inbound recordInbound call:
      // fresh WeChat activity means new data to fold into the knowledge base.
      // Trailing-debounced + gated inside registerIngest, so this is O(1) here.
      recordInbound: (chatId, when) => { refs.ingestNudge.current?.(); return recordInbound(chatId, when) },
      resetCareNoReply: (c) => careLedger.resetNoReply(c),
      log,
    },
    milestone: { fireMilestonesFor, log },
    welcome: { maybeWriteWelcomeObservation, log },
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
        dispatch: async (msg) => {
          if (boot.social && isAdmin(msg.chatId)) {
            const cmd = parseRevealCommand(msg.text)
            if (cmd) {
              const echoOutcome = await boot.social.revealer.revealEcho(cmd.id)
              const outcome = echoOutcome === null ? await boot.social.revealer.revealPledge(cmd.id) : echoOutcome
              if (outcome === null && boot.sendAssistantText) {
                void boot.sendAssistantText(msg.chatId, `没找到「${cmd.id}」这条,可能已过期或已牵线。`)
              }
              return
            }
          }
          // Pen-pal outbound reply (Task 10) — the owner's "回信 <channel>
          // <text>" WeChat reply sends a letter on that open channel instead
          // of dispatching a normal agent turn. Guarded on boot.penpal being
          // wired (Task 11); until then this block is inert and every
          // message — including a well-formed "回信" — falls through to a
          // normal turn, same as boot.social above.
          if (boot.penpal && isAdmin(msg.chatId)) {
            const letterCmd = parseLetterCommand(msg.text)
            if (letterCmd) {
              const r = await boot.penpal.sendLetter(letterCmd.channel, letterCmd.text)
              if (!r.ok && boot.sendAssistantText) {
                void boot.sendAssistantText(msg.chatId, '没找到这条笔友通道 / 发送失败。')
              }
              return
            }
          }
          // 配对 (spec §7) — admin-gated, deterministic parse, mirrors 揭晓/回信.
          // Inert (falls through to a normal turn) until boot.pairing is wired
          // (Task 6, i.e. mailbox_relays configured). start()/accept() are
          // SYNC calls the caller is waiting on — this seam renders EVERY
          // outcome itself (success + all failure reasons). boot.pairing's
          // own `notify` dep is reserved for the initiator's ASYNC poller
          // (card found later / TTL expiry) — see pairing.ts's notify doc
          // comment; it does NOT fire for anything start()/accept() resolve
          // synchronously, so there is no double-message here.
          if (boot.pairing && isAdmin(msg.chatId)) {
            const pair = parsePairCommand(msg.text)
            if (pair) {
              if (pair.kind === 'start') {
                const r = await boot.pairing.start()
                if (boot.sendAssistantText) {
                  const text = r.ok
                    ? `配对码 ${r.code},发给朋友,10 分钟内有效`
                    : '中继暂时够不着,配对码没能生成——稍后再试'
                  void boot.sendAssistantText(msg.chatId, text)
                }
              } else {
                const r = await boot.pairing.accept(pair.code)
                if (boot.sendAssistantText) {
                  const text = r.ok
                    ? `和 ${r.peer.name} 的 bot 连上了 ✓ 现在可以互相觅食/写信了`
                    : r.reason === 'self_pair'
                      ? '这是你自己的码,换个朋友的码试试'
                      : r.reason === 'id_conflict'
                        ? '对方 bot 使用旧版共享身份且与你已有的朋友撞名——请让对方升级出唯一身份后重试'
                        : r.reason === 'relay_drop_failed'
                          ? '名片没能投到中继,配对没完成——请重试'
                          : '码不对或已过期,让朋友重新生成一个'
                  void boot.sendAssistantText(msg.chatId, text)
                }
              }
              return
            }
          }
          // 派 / 取消 (P4 派心愿) — admin-gated confirm/cancel of a `proposed`
          // social_seek row, mirrors the 揭晓/配对 blocks above (renders every
          // outcome itself, no engine notify). `派` is ALREADY the delegate
          // imperative (admin-commands.ts's DELEGATE_RE: 让/派 <hand> 执行/跑
          // <task>) — parseSeekCommand's id-charset guard ([0-9a-fA-F-]+)
          // keeps a delegate command like "派 家里 跑 拉日志" from ever
          // matching here (belt); makeMwAdmin already runs before this
          // dispatch seam in the wired pipeline and consumes DELEGATE_RE
          // first (suspenders). Inert (falls through) until boot.social is
          // wired, same posture as the 揭晓/配对 blocks.
          if (boot.social && isAdmin(msg.chatId)) {
            const cmd = parseSeekCommand(msg.text)
            if (cmd) {
              const res = resolveSeekRef(cmd.ref, boot.social.seekStore.list())
              if (!res.ok) {
                if (boot.sendAssistantText) {
                  const text = res.reason === 'ambiguous'
                    ? '有多条心愿匹配这个开头,请给更长的编号(≥6 位)'
                    : '这条心愿不存在或已处理'
                  void boot.sendAssistantText(msg.chatId, text)
                }
                return
              }
              if (cmd.kind === 'confirm') {
                const r = await boot.social.broker.confirmSeek(res.id)
                if (boot.sendAssistantText) {
                  void boot.sendAssistantText(msg.chatId, r.ok ? '已发出,觅食中…(稍后回来看回声)' : '这条心愿不存在或已处理')
                }
              } else {
                await boot.social.broker.cancelSeek(res.id)
                if (boot.sendAssistantText) void boot.sendAssistantText(msg.chatId, '已作废')
              }
              return
            }
          }
          return boot.coordinator.dispatch(msg)
        },
      },
    },
  }

  // App-conversation-channel converse (voice arc Stage 0, Task 2) — drives
  // one real turn on the owner's own chat session and hands the reply back
  // synchronously. Synthesizes an InboundMsg the same shape a real WeChat
  // inbound would have (userId==chatId is correct for a solo owner chat)
  // and dispatches it straight through the coordinator — NOT through the
  // poll-loop/inbound-pipeline middleware chain, since this isn't a WeChat
  // inbound. The agent's `reply` tool still posts to POST /v1/wechat/reply
  // as normal; the open sink captures it instead of ilink-sending.
  const companionConverse = async (text: string): Promise<{ reply: string }> => {
    const ownerChatId = loadCompanionConfig(stateDir).default_chat_id
    if (!ownerChatId) throw new Error('companion_owner_chat_not_configured')
    // D3 review follow-up: app-converse captures the reply through a sink, but a
    // chatroom-mode chat is preempt-policy (submitTurn runs the turn BARE, no
    // per-chat lock) AND chatroom forbids the `reply` tool — so an app turn on a
    // chatroom-mode owner chat would run unserialized and capture nothing.
    // Reject clearly instead of hanging / returning an empty reply. (Pre-D3 this
    // was a silent no-op; D3 makes the policy explicit, so we guard it explicitly.)
    if (boot.coordinator.getMode(ownerChatId).kind === 'chatroom') {
      throw new Error('owner_chat_in_chatroom_mode')
    }
    // PRIMARY guard (spec §3, HIGH finding fix): refuse to start an app turn
    // while a WeChat turn is already dispatching on the owner's session.
    // replySinks.open() below only catches app-vs-app races (both go through
    // this closure); a WeChat inbound never touches replySinks, so without
    // this check a WeChat message and an app /converse racing on the same
    // (alias, providerId, chatId) would both acquire the SAME SessionManager
    // handle and dispatch concurrently on one AgentSession. Resolves the key
    // the exact same way ConversationCoordinator.dispatch will (see
    // resolveOwnerSessionKey above) and reuses SessionManager.isInFlight —
    // the SAME in-flight guard the companion push tick checks before
    // dispatching (tick-bodies.ts's dispatchToChat).
    const ownerKey = resolveOwnerSessionKey(ownerChatId, {
      resolveProject: boot.resolve,
      getMode: (cid) => boot.coordinator.getMode(cid),
      defaultProviderId: boot.defaultProviderId,
    })
    if (ownerKey && boot.sessionManager.isInFlight({ alias: ownerKey.alias, providerId: ownerKey.providerId, chatId: ownerChatId })) {
      // Same error string as the replySinks guard below so the route's
      // reply_sink_busy → 409 session_busy mapping (internal-api/routes.ts)
      // stays unchanged.
      throw new Error('reply_sink_busy')
    }
    // The isInFlight pre-check above is a fast, lock-free rejection for the
    // still-common case (WeChat turn already running) so the app UI gets an
    // immediate 409 without waiting on the mutex. Below, session
    // serialization (session-serialization-design.md) closes the residual
    // this pre-check alone can't: the SINK's entire open→close lifetime runs
    // INSIDE the per-chat turn (submitTurn's `within` hook), so a WeChat/tick
    // turn queued behind this app turn cannot start — and cannot have its
    // reply-tool output stolen by the still-open app sink — until this turn's
    // sink is closed. D3: submitTurn owns the lock/policy + the dispatch; the
    // app path just supplies the capture logic to run within the locked turn
    // (no more hand-rolled runExclusive/dispatchInner + the deadlock footgun).
    const synthetic: InboundMsg = {
      chatId: ownerChatId,
      userId: ownerChatId,
      text,
      msgType: 'text',
      createTimeMs: Date.now(),
      accountId: ilink.resolveAccountId(ownerChatId),
    }
    return boot.coordinator.submitTurn(synthetic, {
      within: async (dispatch) => {
        const sink = replySinks.open(ownerChatId)
        try {
          await dispatch()
          return { reply: sink.close() }
        } catch (err) {
          sink.close()
          throw err
        }
      },
    })
  }

  return { pipelineDeps, companionConverse }
}

/**
 * Pipeline dep builder — admin/mode/onboarding handler construction +
 * 13-mw deps assembly into InboundPipelineDeps.
 *
 * Refs are passed in for late-bound polling/guard access from closures.
 */
import { join } from 'node:path'
import { recallFromMemory } from '../memory/recall'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { Ref } from '../../lib/lifecycle'
import type { IlinkAdapter } from '../ilink-glue'
import type { Bootstrap } from '../bootstrap'
import type { GuardLifecycle } from '../guard/lifecycle'
import type { PollingLifecycle } from '../polling-lifecycle'
import type { InboundPipelineDeps } from '../inbound/build'
import type { PipelineRun } from '../inbound/types'
import { isAdmin, loadAccess, appendAllowFrom } from '../../lib/access'
import { resolveTier } from '../../core/user-tier'
import { makeAdminCommands } from '../admin-commands'
import { makeModeCommands } from '../mode-commands'
import type { ChatPrefsStore } from '../chat-prefs'
import type { CareLedger } from '../companion/care-ledger'
import type { ReplySinks } from '../reply-sinks'
import { loadCompanionConfig } from '../companion/config'
import { resolveAdminChatId } from '../companion/resolve-admin'
import { makeSettingsPanel } from '../settings-panel'
import { makeCommandRouter } from './command-router'
import { makeEventsStore } from '../events/store'
import { makeGuestRequestStore } from '../guest-requests'
import { makeForwardBudget } from '../../core/forward-budget'
import type { InboundMsg } from '../../core/prompt-format'
import { makeOnboardingHandler } from '../onboarding'
import { botName, botNameFromModeFallback } from '../bot-name'
import { loadAgentConfig, saveAgentConfig, withModelForProvider } from '../../lib/agent-config'
import { findOnPath } from '../../lib/util'
import type { A2AAgentRecord } from '../../lib/agent-config'
import { materializeAttachments } from '../media'
import { loadGuardConfig } from '../guard/store'
import { makeFireMilestonesFor, makeRecordInbound, makeMaybeWriteWelcomeObservation } from './side-effects'
import { makeMessagesStore } from '../../lib/messages-store'
import { makeMemoryLlmOps } from '../memory-llm-ops'
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
  /** Sticker library — 随身 CC 手机页展示 + 图片服务(main.ts 传入)。 */
  stickers?: import('../stickers').StickerLib
  /** 触发 daemon 重启(远程访问开关切换后套用新隧道接线)。main.ts 传入。 */
  requestRestart?: (reason: string) => void
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
  /** Mint a fresh settings-panel URL (10-min single-active token) — the
   *  desktop 「手机上改设置」 QR entry (GET /v1/settings/link). */
  settingsPanelLink: () => Promise<string | null>
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

  const recordInbound = makeRecordInbound({
    stateDir, db,
    sendMessage: (cid, txt) => ilink.sendMessage(cid, txt) as Promise<{ msgId?: string; error?: string }>,
    log: (tag, line) => log(tag, line),
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
  const commandRouter = makeCommandRouter({
    isAdmin: (c) => isAdmin(c),
    loadAccess: () => loadAccess(),
    appendAllowFrom: (c) => { appendAllowFrom(c) },
    ...(boot.sendAssistantText ? { sendAssistantText: (c, t) => boot.sendAssistantText!(c, t) } : {}),
    ...(boot.social ? { social: { revealer: boot.social.revealer, seekStore: boot.social.seekStore, broker: boot.social.broker } } : {}),
    ...(boot.penpal ? { penpal: boot.penpal } : {}),
    ...(boot.pairing ? { pairing: boot.pairing } : {}),
    guestRequests,
    hydrateRoute,
    sendMessage: (c, t) => ilink.sendMessage(c, t).then(r => r as { error?: string }),
    redispatch: (run) => refs.pipeline.deref('guest approve redispatch')(run),
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
  const notifyOwnerOfGuest = (text: string): Promise<{ error?: string }> => {
    const adminChatId = resolveAdminChatId(loadAccess(), loadCompanionConfig(stateDir), null)
    if (!adminChatId) return Promise.resolve({ error: 'no_admin_chat_configured' })
    return ilink.sendMessage(adminChatId, text)
  }
  // Shared LLM-backed memory ops (overview synthesis + profile generation),
  // wired with the daemon's OWN provider registry/coordinator so both the
  // WeChat admin-command path (below) and the internal-api routes the
  // desktop calls resolve cheapEval identically. Built once and reused.
  const memoryLlmOps = makeMemoryLlmOps({
    stateDir,
    db,
    getMode: (cid) => boot.coordinator.getMode(cid),
    registry: boot.registry,
  })
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
    // busy-registry hold (spec 2026-08-11 §2) — 整理记忆/派活 are dispatched
    // fire-and-forget outside SessionManager; boot.holdBusy is the same
    // registry the self-restart idle check reads.
    holdBusy: boot.holdBusy,
    getBotName,
    setBotName,
    botNameFallback: (cid) => botNameFromModeFallback(boot.coordinator.getMode(cid)),
    // Follows the admin conversation's provider (decided design); falls back
    // to the registry's cheapest eval when the mode isn't solo / unknown.
    // Delegates to the shared factory (memory-llm-ops.ts) so this path and
    // the internal-api routes the desktop calls resolve cheapEval identically.
    synthesizeMemory: (adminChatId) => memoryLlmOps.synthesize(adminChatId),
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

  // 微信可点开的图形设置面板 (2026-08-25) — lazily-started LAN server, every
  // endpoint gated on a one-active 10-min token. /set (no args) from an
  // admin appends the link. See settings-panel.ts's security posture.
  // Remote tunnel opt-in (随身 CC out-of-home) — resolve id/relay BEFORE the
  // panel so its /m page can bake them in for out-of-home phones.
  const remoteCfg = loadAgentConfig(stateDir) as { remote_tunnel?: boolean; remote_relay_url?: string }
  let remoteTunnel: { id: string; relay: string } | null = null
  if (remoteCfg.remote_tunnel === true) {
    const idPath = join(stateDir, 'tunnel-id.json')
    let did: string
    try { did = (JSON.parse(readFileSync(idPath, 'utf8')) as { id: string }).id }
    catch { did = 't' + randomBytes(18).toString('hex'); try { writeFileSync(idPath, JSON.stringify({ id: did }), { mode: 0o600 }) } catch { /* best effort */ } }
    remoteTunnel = { id: did, relay: remoteCfg.remote_relay_url ?? 'wss://cc.tendhearth.com/tunnel/phone' }
  }

  const settingsPanel = makeSettingsPanel({
    stateDir,
    ownerChatId: () => resolveAdminChatId(loadAccess(), loadCompanionConfig(stateDir), null),
    ...(remoteTunnel ? { remoteInfo: () => remoteTunnel } : {}),
    ...(opts.requestRestart ? {
      remote: {
        isEnabled: () => (loadAgentConfig(stateDir) as { remote_tunnel?: boolean }).remote_tunnel === true,
        setEnabled: (on: boolean) => {
          const cur = loadAgentConfig(stateDir)
          saveAgentConfig(stateDir, { ...cur, remote_tunnel: on } as typeof cur)
        },
        requestRestart: () => opts.requestRestart!('remote-toggle'),
      },
    } : {}),
    // 随身 CC 数据面 — facts/graph 来自 boot.knowledge(缺则手机页对应区留白)
    ...(boot.knowledge?.facts ? {
      todos: {
        facts: {
          findFacts: (k, pr, q2, st, li) => boot.knowledge!.facts!.findFacts(k, pr, q2, st, li),
          setFactStatus: (id, st, n) => boot.knowledge!.facts!.setFactStatus(id, st, n),
        },
        names: () => {
          try { return (boot.knowledge?.graph?.topContacts('closeness', 500, 'person') ?? []) as Array<{ username: string; display: string }> } catch { return [] }
        },
      },
    } : {}),
    ...(opts.stickers ? { stickers: { list: () => opts.stickers!.list(), dir: join(stateDir, 'stickers') } } : {}),
    chatPrefs: {
      get: (c) => ({ ...chatPrefs.get(c) }),
      set: (c, patch) => ({ ...chatPrefs.set(c, patch as Parameters<typeof chatPrefs.set>[1]) }),
    },
    getUserName: (c) => ilink.resolveUserName(c) ?? null,
    setUserName: (c, n) => ilink.setUserName(c, n),
    audit: (reasoning) => {
      const auditChat = resolveAdminChatId(loadAccess(), loadCompanionConfig(stateDir), null) ?? '_operator'
      makeEventsStore(db, auditChat).append({ kind: 'config_changed', trigger: 'settings_panel', reasoning })
        .catch(() => { /* audit is best-effort — same posture as routes-config */ })
    },
    log: (tag, line) => log(tag, line),
  })

  // 远程中继隧道 daemon leg — dials /tunnel/daemon out (NAT-piercing); phone
  // reaches it via the SAME settingsPanel.handleRequest. OFF unless
  // remote_tunnel:true (resolved into remoteTunnel above).
  if (remoteTunnel) {
    const daemonId = remoteTunnel.id
    const daemonRelay = (remoteCfg.remote_relay_url ?? 'wss://cc.tendhearth.com/tunnel/phone').replace('/tunnel/phone', '/tunnel/daemon')
    import('../tunnel-client').then(({ makeTunnelClient }) => {
      makeTunnelClient({
        daemonId,
        handleRequest: (req) => settingsPanel.handleRequest(req),
        knownDeviceTokens: () => {
          try { return Object.keys(JSON.parse(readFileSync(join(stateDir, 'settings-devices.json'), 'utf8'))) } catch { return [] }
        },
        relayUrl: daemonRelay,
        log: (tag, line) => log(tag, line),
      }).start()
      log('TUNNEL', `remote tunnel enabled — dialing relay as ${daemonId.slice(0, 8)}…`)
    }).catch(err => log('TUNNEL', `tunnel client load failed: ${err instanceof Error ? err.message : err}`))
  }

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
    sendMessage: async (cid, txt) => { await ilink.sendMessage(cid, txt) },
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
      await refs.pipeline.deref('onboarding echo dispatch')({
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
      recordInbound: (chatId, when) => { refs.ingestNudge.current?.(); return recordInbound(chatId, when) },
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
      recallFallback: async (chatId: string, text: string) => recallFromMemory(stateDir, chatId, text),
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
          if (await commandRouter.tryHandle(msg)) return
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
    // self-restart (spec 2026-08-03-daemon-self-restart-on-stale-code,
    // Task 3 review finding #1) — an App /converse turn is real owner
    // activity, but it dispatches straight through the coordinator and
    // NEVER passes through mw-messages (see this function's own doc
    // comment above), so without this call quietFor() would read Infinity
    // forever while the owner is mid-conversation in the desktop app,
    // making the idle-tick self-restart check free to fire between turns.
    // Same posture as mw-messages: optional, wrapped so a throw here can
    // never break the app turn it's marking.
    try { boot.markInboundActivity?.() } catch { /* 绝不能因为记一笔就打断 app 轮次 */ }
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

  return { pipelineDeps, companionConverse, settingsPanelLink: () => settingsPanel.linkUrl() }
}

/**
 * Pipeline dep builder — admin/mode/onboarding handler construction +
 * 13-mw deps assembly into InboundPipelineDeps.
 *
 * Refs are passed in for late-bound polling/guard access from closures.
 */
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
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
import { makeOnboardingHandler } from '../onboarding'
import { botName, botNameFromModeFallback } from '../bot-name'
import { loadAgentConfig, saveAgentConfig } from '../../lib/agent-config'
import { materializeAttachments } from '../media'
import { loadGuardConfig } from '../guard/store'
import { makeFireMilestonesFor, makeRecordInbound, makeMaybeWriteWelcomeObservation } from './side-effects'
import { makeMessagesStore } from '../../lib/messages-store'

export interface PipelineDepsOpts {
  stateDir: string
  db: import('../../lib/db').Db
  ilink: IlinkAdapter
  boot: Bootstrap
  log: (tag: string, line: string, fields?: Record<string, unknown>) => void
}

export interface PipelineDepsRefs {
  polling: Ref<PollingLifecycle>
  guard: Ref<GuardLifecycle>
  pipeline: Ref<PipelineRun>
}

const STARTED_AT_ISO = new Date().toISOString()

export function buildPipelineDeps(opts: PipelineDepsOpts, refs: PipelineDepsRefs): { pipelineDeps: InboundPipelineDeps } {
  const { stateDir, db, ilink, boot, log } = opts
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
      const { synthesizeOverview } = await import('../../cli/memory-synthesis')
      // Follow the admin conversation's provider (decided design); fall back
      // to the registry's cheapest eval when the mode isn't solo / unknown.
      const mode = boot.coordinator.getMode(adminChatId)
      const provider = mode && mode.kind === 'solo' ? mode.provider : undefined
      const cheapEval = (provider ? boot.registry.get(provider)?.provider.cheapEval : null) ?? boot.registry.getCheapEval()
      if (!cheapEval) throw new Error('no LLM provider available for synthesis')
      // Pass the daemon db so the overview also folds in the life-side memory.
      return synthesizeOverview({ stateDir, adminChatId, sdkEval: (p) => cheapEval(p), db })
    },
    // Delegate a task to a registered "hand" (another machine running wechat-cc
    // with A2A exec). Resolves the hand by id or name, then calls its /a2a/exec
    // and returns the result (one-brain-many-hands).
    delegateToHand: async (handName, task) => {
      const a2a = boot.a2aDeps
      if (!a2a) return { ok: false as const, reason: 'A2A 未启用(agent-config 没配 a2a_listen / 没注册手)' }
      // Only exec-capable agents are delegation targets — a notify-only agent
      // has no /a2a/exec, so don't match it (and don't list it as a "known
      // hand", which would mislead the discovery reply).
      const hands = a2a.registry.list().filter(a => a.capabilities?.includes('exec'))
      const hand = hands.find(a => a.id === handName || a.name === handName)
      if (!hand) return { ok: false as const, reason: 'unknown_hand', knownHands: hands.map(a => a.name || a.id) }
      const { delegateToHand: doDelegate } = await import('../../core/a2a-delegate')
      const { createA2AClient } = await import('../../core/a2a-client')
      execA2AClient ??= createA2AClient({ timeoutMs: Number(process.env.WECHAT_A2A_EXEC_TIMEOUT_MS) || 300_000 })
      // The brain's id as the hand knows it (the hand registers the brain under
      // this id + a matching key). Configurable; defaults to a stable slug.
      const selfId = process.env.WECHAT_A2A_SELF_ID || 'wechat-cc'
      return doDelegate(execA2AClient, { hand, selfId, prompt: task })
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
    messages: {
      append: rec => messagesStore.append(rec),
      log,
    },
    activity: { recordInbound, log },
    milestone: { fireMilestonesFor, log },
    welcome: { maybeWriteWelcomeObservation, log },
    dispatch: { coordinator: { dispatch: (msg) => boot.coordinator.dispatch(msg) } },
  }

  return { pipelineDeps }
}

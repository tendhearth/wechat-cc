import { describe, it, expect, vi, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Guest path (spec docs/superpowers/specs/2026-08-18-guest-path-design.md
// §3) — the `dispatch.coordinator.dispatch` seam in pipeline-deps.ts
// intercepts the owner's WeChat "允许/拒绝/邀请码/待批准" replies before
// they reach a normal agent turn. Mirrors
// pipeline-deps-pairing-dispatch.test.ts's harness: `isAdmin`/`appendAllowFrom`
// read/write access.json off the module-level STATE_DIR (src/lib/config.ts),
// which is NOT one of buildPipelineDeps's injectable opts — so STATE_DIR is
// redirected to a temp dir via vi.mock BEFORE anything imports
// access.ts/config.ts, and pipeline-deps is loaded dynamically afterward so
// it (transitively) picks up the mock.
const ACCESS_STATE_DIR = mkdtempSync(join(tmpdir(), 'pipeline-deps-guest-dispatch-access-test-'))
vi.mock('../../lib/config.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/config')>()
  return { ...actual, STATE_DIR: ACCESS_STATE_DIR }
})

const { buildPipelineDeps } = await import('./pipeline-deps')
const { Ref } = await import('../../lib/lifecycle')
const { openTestDb } = await import('../../lib/db')
const { makeReplySinks } = await import('../reply-sinks')
const { _clearCache, _resetSnapshotForTest } = await import('../../lib/access')

import type { Bootstrap } from '../bootstrap/index'
import type { IlinkAdapter } from '../ilink-glue'
import type { ChatPrefsStore } from '../chat-prefs'
import type { CareLedger } from '../companion/care-ledger'
import type { InboundMsg } from '../../core/prompt-format'
import type { Mode } from '../../core/conversation'
import type { PipelineRun } from '../inbound/types'

const fakeHealth = {
  health: { shouldSuspend: () => false, get: () => ({ consecutiveFailures: 0 }) },
} as unknown as Bootstrap['health']

const ACCESS_FILE = join(ACCESS_STATE_DIR, 'access.json')
function writeAccess(admins: string[]): void {
  writeFileSync(ACCESS_FILE, JSON.stringify({ dmPolicy: 'allowlist', allowFrom: [], admins }, null, 2))
}
function readAllowFrom(): string[] {
  return (JSON.parse(readFileSync(ACCESS_FILE, 'utf8')) as { allowFrom: string[] }).allowFrom
}

afterAll(() => { rmSync(ACCESS_STATE_DIR, { recursive: true, force: true }) })

function setup(admins: string[] = ['admin_chat']) {
  writeAccess(admins)
  _clearCache()
  _resetSnapshotForTest()
  const stateDir = mkdtempSync(join(tmpdir(), 'pipeline-deps-guest-dispatch-test-'))
  const db = openTestDb()
  const coordinatorDispatch = vi.fn(async (_msg: InboundMsg) => {})
  const sendAssistantText = vi.fn(async (_chatId: string, _text: string) => {})
  const boot = {
    sessionManager: { isInFlight: vi.fn(() => false) } as unknown as Bootstrap['sessionManager'],
    sessionStore: {} as Bootstrap['sessionStore'],
    conversationStore: { upsertIdentity: vi.fn() } as unknown as Bootstrap['conversationStore'],
    registry: { get: vi.fn(), list: vi.fn(() => []), getCheapEval: vi.fn(() => null), has: vi.fn(() => false) } as unknown as Bootstrap['registry'],
    coordinator: { dispatch: coordinatorDispatch, getMode: vi.fn((): Mode => ({ kind: 'solo', provider: 'claude' })), cancel: vi.fn(() => false) } as unknown as Bootstrap['coordinator'],
    resolve: vi.fn(() => null),
    formatInbound: vi.fn() as unknown as Bootstrap['formatInbound'],
    sdkOptionsForProject: vi.fn() as unknown as Bootstrap['sdkOptionsForProject'],
    buildInstructions: vi.fn(() => ''),
    defaultProviderId: 'claude',
    agentProviderKind: 'claude',
    dispatchDelegate: vi.fn() as unknown as Bootstrap['dispatchDelegate'],
    a2aDeps: undefined,
    a2aServer: null,
    agentConfig: { bot_name: null } as unknown as Bootstrap['agentConfig'],
    sendAssistantText,
    social: undefined,
    penpal: undefined,
    pairing: undefined,
    health: fakeHealth,
  } as unknown as Bootstrap

  const sendMessage = vi.fn(async (_c: string, _t: string) => ({ msgId: 'sent:1' }))
  const routeChatToAccount = vi.fn()
  const captureContextToken = vi.fn()
  const ilink = {
    sendMessage,
    routeChatToAccount,
    captureContextToken,
    markChatActive: vi.fn(),
  } as unknown as IlinkAdapter

  const chatPrefs: ChatPrefsStore = { get: () => ({}), set: () => ({}), list: () => [] }
  const careLedger: CareLedger = { get: () => ({ noReplyCount: 0 }), claim: vi.fn(), claimHunt: vi.fn(), resetNoReply: vi.fn() }
  const replySinks = makeReplySinks()
  const pipelineRun = vi.fn(async (_ctx: Parameters<PipelineRun>[0]) => {})
  const pipelineRef = new Ref<PipelineRun>('pipeline')
  pipelineRef.set(pipelineRun)

  const { pipelineDeps } = buildPipelineDeps(
    { stateDir, db, ilink, boot, log: () => {}, chatPrefs, careLedger, replySinks },
    { polling: new Ref('polling'), guard: new Ref('guard'), pipeline: pipelineRef, ingestNudge: new Ref('ingestNudge') },
  )
  return {
    pipelineDeps, coordinatorDispatch, sendAssistantText, sendMessage, routeChatToAccount, captureContextToken,
    pipelineRun, stateDir, guestRequests: pipelineDeps.access.guestRequests!,
  }
}

function teardown(stateDir: string): void {
  rmSync(stateDir, { recursive: true, force: true })
}

const guestFirstMsg: InboundMsg = {
  chatId: 'guest_chat', userId: 'guest_chat', text: '在吗?我想问点事', msgType: 'text',
  createTimeMs: 1, accountId: 'acct1', contextToken: 'ctx-tok',
}

function adminMsg(text: string): InboundMsg {
  return { chatId: 'admin_chat', userId: 'admin_chat', text, msgType: 'text', createTimeMs: Date.now(), accountId: 'acct1' }
}

describe('pipeline-deps guest-command dispatch seam (允许/拒绝/邀请码/待批准, spec §3)', () => {
  it('a non-admin sending "允许 123456" is never consumed — falls through to a normal turn', async () => {
    const { pipelineDeps, coordinatorDispatch, stateDir } = setup(['admin_chat'])
    try {
      await pipelineDeps.dispatch.coordinator.dispatch({
        chatId: 'stranger', userId: 'stranger', text: '允许 123456', msgType: 'text', createTimeMs: 1, accountId: 'acct1',
      })
      expect(coordinatorDispatch).toHaveBeenCalledTimes(1)
    } finally { teardown(stateDir) }
  })

  it('a non-command admin message falls through to a normal turn', async () => {
    const { pipelineDeps, coordinatorDispatch, stateDir } = setup()
    try {
      await pipelineDeps.dispatch.coordinator.dispatch(adminMsg('今天天气不错'))
      expect(coordinatorDispatch).toHaveBeenCalledTimes(1)
    } finally { teardown(stateDir) }
  })

  it('允许 <valid code>: appendAllowFrom persists, owner + guest get their texts, and the pipeline redispatches firstMsg with redispatch:true', async () => {
    const { pipelineDeps, coordinatorDispatch, sendAssistantText, sendMessage, pipelineRun, stateDir, guestRequests } = setup()
    try {
      const { request } = guestRequests.upsertRequest({
        chatId: 'guest_chat', firstMsg: guestFirstMsg, contextToken: 'ctx-tok', accountId: 'acct1',
      })

      await pipelineDeps.dispatch.coordinator.dispatch(adminMsg(`允许 ${request.code}`))

      expect(readAllowFrom()).toContain('guest_chat')
      expect(sendAssistantText).toHaveBeenCalledWith('admin_chat', '✅ 已允许 guest_chat')
      expect(sendMessage).toHaveBeenCalledWith('guest_chat', '主人同意啦!')
      expect(pipelineRun).toHaveBeenCalledTimes(1)
      const [ctx] = pipelineRun.mock.calls[0]!
      expect(ctx.msg).toEqual(guestFirstMsg)
      expect(ctx.redispatch).toBe(true)
      expect(coordinatorDispatch).not.toHaveBeenCalled()   // consumed, not a normal turn
    } finally { teardown(stateDir) }
  })

  it('允许 <valid code>: hydrates the chat route from the STORED request fields BEFORE sending the guest welcome (fix round 1, Important #3)', async () => {
    const { pipelineDeps, sendMessage, routeChatToAccount, captureContextToken, stateDir, guestRequests } = setup()
    try {
      const { request } = guestRequests.upsertRequest({
        chatId: 'guest_chat', firstMsg: guestFirstMsg, contextToken: 'stored-tok', accountId: 'acct-stored',
      })

      const callOrder: string[] = []
      routeChatToAccount.mockImplementation(() => { callOrder.push('route') })
      captureContextToken.mockImplementation(() => { callOrder.push('capture') })
      sendMessage.mockImplementation(async () => { callOrder.push('send'); return { msgId: 'sent:1' } })

      await pipelineDeps.dispatch.coordinator.dispatch(adminMsg(`允许 ${request.code}`))

      expect(routeChatToAccount).toHaveBeenCalledWith('guest_chat', 'acct-stored')
      expect(captureContextToken).toHaveBeenCalledWith('guest_chat', 'stored-tok')
      // hydrate (route + capture) happened before the guest-facing send.
      expect(callOrder.indexOf('route')).toBeLessThan(callOrder.indexOf('send'))
      expect(callOrder.indexOf('capture')).toBeLessThan(callOrder.indexOf('send'))
    } finally { teardown(stateDir) }
  })

  it('允许 <valid code>: a failed guest-welcome send is logged (owner already got their ✅, but the failure is not swallowed)', async () => {
    const logLines: string[] = []
    writeAccess(['admin_chat'])
    _clearCache(); _resetSnapshotForTest()
    const stateDir = mkdtempSync(join(tmpdir(), 'pipeline-deps-guest-dispatch-logtest-'))
    const db = openTestDb()
    const sendAssistantText = vi.fn(async () => {})
    const boot = {
      sessionManager: { isInFlight: vi.fn(() => false) } as unknown as Bootstrap['sessionManager'],
      sessionStore: {} as Bootstrap['sessionStore'],
      conversationStore: { upsertIdentity: vi.fn() } as unknown as Bootstrap['conversationStore'],
      registry: { get: vi.fn(), list: vi.fn(() => []), getCheapEval: vi.fn(() => null), has: vi.fn(() => false) } as unknown as Bootstrap['registry'],
      coordinator: { dispatch: vi.fn(async () => {}), getMode: vi.fn((): Mode => ({ kind: 'solo', provider: 'claude' })), cancel: vi.fn(() => false) } as unknown as Bootstrap['coordinator'],
      resolve: vi.fn(() => null),
      formatInbound: vi.fn() as unknown as Bootstrap['formatInbound'],
      sdkOptionsForProject: vi.fn() as unknown as Bootstrap['sdkOptionsForProject'],
      buildInstructions: vi.fn(() => ''),
      defaultProviderId: 'claude',
      agentProviderKind: 'claude',
      dispatchDelegate: vi.fn() as unknown as Bootstrap['dispatchDelegate'],
      a2aDeps: undefined,
      a2aServer: null,
      agentConfig: { bot_name: null } as unknown as Bootstrap['agentConfig'],
      sendAssistantText,
      social: undefined,
      penpal: undefined,
      pairing: undefined,
      health: fakeHealth,
    } as unknown as Bootstrap
    const ilink = {
      sendMessage: vi.fn(async () => ({ msgId: 'err:1', error: 'session_timeout' })),
      routeChatToAccount: vi.fn(),
      captureContextToken: vi.fn(),
      markChatActive: vi.fn(),
    } as unknown as IlinkAdapter
    const chatPrefs: ChatPrefsStore = { get: () => ({}), set: () => ({}), list: () => [] }
    const careLedger: CareLedger = { get: () => ({ noReplyCount: 0 }), claim: vi.fn(), claimHunt: vi.fn(), resetNoReply: vi.fn() }
    const replySinks = makeReplySinks()
    const pipelineRef = new Ref<PipelineRun>('pipeline')
    pipelineRef.set(vi.fn(async () => {}))
    const { pipelineDeps } = buildPipelineDeps(
      { stateDir, db, ilink, boot, log: (tag, line) => { logLines.push(`${tag} ${line}`) }, chatPrefs, careLedger, replySinks },
      { polling: new Ref('polling'), guard: new Ref('guard'), pipeline: pipelineRef, ingestNudge: new Ref('ingestNudge') },
    )
    try {
      const guestRequests = pipelineDeps.access.guestRequests!
      const { request } = guestRequests.upsertRequest({
        chatId: 'guest_chat', firstMsg: guestFirstMsg, contextToken: 'ctx-tok', accountId: 'acct1',
      })
      await pipelineDeps.dispatch.coordinator.dispatch(adminMsg(`允许 ${request.code}`))
      expect(sendAssistantText).toHaveBeenCalledWith('admin_chat', '✅ 已允许 guest_chat')   // owner still told
      expect(logLines.some(l => l.includes('session_timeout'))).toBe(true)   // but the failure is on record
    } finally { teardown(stateDir) }
  })

  it('允许 <wrong/expired code>: "码不对或已过期", no allowFrom write, no redispatch', async () => {
    const { pipelineDeps, sendAssistantText, pipelineRun, stateDir } = setup()
    try {
      await pipelineDeps.dispatch.coordinator.dispatch(adminMsg('允许 999999'))
      expect(readAllowFrom()).not.toContain('guest_chat')
      expect(sendAssistantText).toHaveBeenCalledWith('admin_chat', '❌ 码不对或已过期(发「待批准」看当前请求)')
      expect(pipelineRun).not.toHaveBeenCalled()
    } finally { teardown(stateDir) }
  })

  it('拒绝 <valid code>: owner told, guest gets NOTHING, request now denied (guestRequests.wasDenied true)', async () => {
    const { pipelineDeps, sendAssistantText, sendMessage, stateDir, guestRequests } = setup()
    try {
      const { request } = guestRequests.upsertRequest({
        chatId: 'guest_chat', firstMsg: guestFirstMsg, contextToken: 'ctx-tok', accountId: 'acct1',
      })

      await pipelineDeps.dispatch.coordinator.dispatch(adminMsg(`拒绝 ${request.code}`))

      expect(sendAssistantText).toHaveBeenCalledWith('admin_chat', '已拒绝,ta 不会再打扰你。')
      expect(sendMessage).not.toHaveBeenCalled()   // guest chat gets nothing
      expect(guestRequests.wasDenied('guest_chat')).toBe(true)
      expect(readAllowFrom()).not.toContain('guest_chat')
    } finally { teardown(stateDir) }
  })

  it('拒绝 <wrong/expired code>: same "码不对或已过期" reply as 允许', async () => {
    const { pipelineDeps, sendAssistantText, stateDir } = setup()
    try {
      await pipelineDeps.dispatch.coordinator.dispatch(adminMsg('拒绝 999999'))
      expect(sendAssistantText).toHaveBeenCalledWith('admin_chat', '❌ 码不对或已过期(发「待批准」看当前请求)')
    } finally { teardown(stateDir) }
  })

  it('邀请码: creates a real single-use invite and echoes its exact copy', async () => {
    const { pipelineDeps, sendAssistantText, stateDir, guestRequests } = setup()
    try {
      await pipelineDeps.dispatch.coordinator.dispatch(adminMsg('邀请码'))
      expect(sendAssistantText).toHaveBeenCalledTimes(1)
      const [chatId, text] = sendAssistantText.mock.calls[0]!
      expect(chatId).toBe('admin_chat')
      const m = /^邀请码:(\d{6})\(48 小时内有效,一次一人\)。把这串数字发给朋友,ta 加我微信好友后把码发给我就能聊了。$/.exec(text)
      expect(m).not.toBeNull()
      const code = m![1]!
      // The code is REAL and single-use — consuming it once succeeds, twice fails.
      expect(guestRequests.consumeInvite(code)).toBe(true)
      expect(guestRequests.consumeInvite(code)).toBe(false)
    } finally { teardown(stateDir) }
  })

  it('待批准 with nothing pending: exact empty-state copy', async () => {
    const { pipelineDeps, sendAssistantText, stateDir } = setup()
    try {
      await pipelineDeps.dispatch.coordinator.dispatch(adminMsg('待批准'))
      expect(sendAssistantText).toHaveBeenCalledWith('admin_chat', '目前没有待批准的请求。')
    } finally { teardown(stateDir) }
  })

  it('待批准 with one pending request: one line, exact shape, truncated/escaped preview', async () => {
    const { pipelineDeps, sendAssistantText, stateDir, guestRequests } = setup()
    try {
      const { request } = guestRequests.upsertRequest({
        chatId: 'guest_chat',
        firstMsg: { ...guestFirstMsg, text: 'line one\nline two is quite long '.repeat(3) },
        contextToken: 'ctx-tok',
        accountId: 'acct1',
      })

      await pipelineDeps.dispatch.coordinator.dispatch(adminMsg('待批准'))

      expect(sendAssistantText).toHaveBeenCalledTimes(1)
      const [chatId, text] = sendAssistantText.mock.calls[0]!
      expect(chatId).toBe('admin_chat')
      const re = /^「(\d{6})」 (\S+):"(.*)"\(剩 (\d+) 小时\)$/
      const m = re.exec(text)
      expect(m).not.toBeNull()
      expect(m![1]).toBe(request.code)
      expect(m![2]).toBe('guest_chat')
      expect(m![3]!.length).toBeLessThanOrEqual(60)
      expect(m![3]).not.toContain('\n')
      expect(Number(m![4])).toBeLessThanOrEqual(48)
    } finally { teardown(stateDir) }
  })
})

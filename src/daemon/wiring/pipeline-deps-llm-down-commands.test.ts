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
const ACCESS_STATE_DIR = mkdtempSync(join(tmpdir(), 'pipeline-deps-llm-down-access-test-'))
vi.mock('../../lib/config.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/config')>()
  return { ...actual, STATE_DIR: ACCESS_STATE_DIR }
})

const { buildPipelineDeps } = await import('./pipeline-deps')
const { buildInboundPipeline } = await import('../inbound/build')
const { openTestDb } = await import('../../lib/db')
const { makeReplySinks } = await import('../reply-sinks')
const { _clearCache, _resetSnapshotForTest } = await import('../../lib/access')

import type { Bootstrap } from '../bootstrap/index'
import type { IlinkAdapter } from '../ilink-glue'
import type { ChatPrefsStore } from '../chat-prefs'
import type { CareLedger } from '../companion/care-ledger'
import type { InboundMsg } from '../../domain/prompt-format'
import type { Mode } from '../../domain/conversation'
import type { PipelineRun } from '../inbound/types'

// 模型挂了:llm 子系统判定该暂停(其余照常)
let llmDown = true
const fakeHealth = {
  health: { shouldSuspend: (k: string) => llmDown && k === 'llm', get: () => ({ consecutiveFailures: llmDown ? 5 : 0 }) },
} as unknown as Bootstrap['health']

const ACCESS_FILE = join(ACCESS_STATE_DIR, 'access.json')
function writeAccess(admins: string[]): void {
  writeFileSync(ACCESS_FILE, JSON.stringify({ dmPolicy: 'allowlist', allowFrom: admins, admins }, null, 2))
}
function readAllowFrom(): string[] {
  return (JSON.parse(readFileSync(ACCESS_FILE, 'utf8')) as { allowFrom: string[] }).allowFrom
}

afterAll(() => { rmSync(ACCESS_STATE_DIR, { recursive: true, force: true }) })

function setup(admins: string[] = ['admin_chat']) {
  writeAccess(admins)
  _clearCache()
  _resetSnapshotForTest()
  const stateDir = mkdtempSync(join(tmpdir(), 'pipeline-deps-llm-down-test-'))
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
    sendTyping: vi.fn(async () => {}),
  } as unknown as IlinkAdapter

  const chatPrefs: ChatPrefsStore = { get: () => ({}), set: () => ({}), list: () => [] }
  const careLedger: CareLedger = { get: () => ({ noReplyCount: 0 }), claim: vi.fn(), claimHunt: vi.fn(), claimVisit: vi.fn(), claimMemory: vi.fn(), resetNoReply: vi.fn(), unclaim: vi.fn() }
  const replySinks = makeReplySinks()
  const pipelineRun = vi.fn(async (_ctx: Parameters<PipelineRun>[0]) => {})
  const pipelineRef = { current: pipelineRun as PipelineRun }

  const { pipelineDeps } = buildPipelineDeps(
    { stateDir, db, ilink, boot, log: () => {}, chatPrefs, careLedger, replySinks },
    { polling: () => null, pipeline: () => pipelineRef.current, ingestNudge: () => null },
  )
  return {
    pipelineDeps, coordinatorDispatch, sendAssistantText, sendMessage, routeChatToAccount, captureContextToken,
    pipelineRun, stateDir, guestRequests: pipelineDeps.access.guestRequests!,
  }
}

function teardown(stateDir: string): void {
  rmSync(stateDir, { recursive: true, force: true })
}


// 每条消息一个不同的 createTimeMs:没有 msgId 的消息按 (userId, createTimeMs) 去重,同一毫秒造出的两条会被当成重复丢掉
// (ubuntu CI 上对照那条偶发红就是这个,10-21)。
let msgSeq = 0
function adminMsg(text: string): InboundMsg {
  return { chatId: 'admin_chat', userId: 'admin_chat', text, msgType: 'text', createTimeMs: Date.now() + ++msgSeq, accountId: 'acct1' }
}

/**
 * 重构第二批 · 步 1c(spec 2026-10-20-refactor-batch2-design §1.5 bug 2 的现状;只加测试):
 * 模型挂了时,完全不用模型的主人命令(邀请码 / 待批准)走完整入站流水线,今天落到哪里。
 * 以前 command-router 排在派发里、llm-health 之后 ⇒ 它们到不了(§1.5 bug 2)。步 2 把命令提到 llm-health 之前,现在照常回。
 */
describe('模型挂了时的主人命令(步 1c 基线)', () => {
  it('邀请码 / 待批准 still answer while llm is suspended (步 2:命令排在 llm-health 之前;以前到不了)', async () => {
    const s = setup(['admin_chat'])
    try {
      const pipeline = buildInboundPipeline(s.pipelineDeps as never)
      for (const text of ['邀请码', '待批准']) await pipeline({ msg: adminMsg(text), receivedAtMs: Date.now(), requestId: `r-${text}` })
      const said = [...s.sendAssistantText.mock.calls.map(c => String(c[1])), ...s.sendMessage.mock.calls.map(c => String(c[1]))]
      expect(said.some(t => t.startsWith('邀请码:'))).toBe(true)
      expect(said.some(t => t.includes('目前没有待批准'))).toBe(true)
      expect(s.coordinatorDispatch).not.toHaveBeenCalled()
    } finally { teardown(s.stateDir) }
  })
  it('control: the same commands DO reach the router when the model is healthy (so the test above is about llm-health, not something else)', async () => {
    llmDown = false
    const s = setup(['admin_chat'])
    try {
      const pipeline = buildInboundPipeline(s.pipelineDeps as never)
      for (const text of ['邀请码', '待批准']) await pipeline({ msg: adminMsg(text), receivedAtMs: Date.now(), requestId: `h-${text}` })
      const said = [...s.sendAssistantText.mock.calls.map(c => String(c[1])), ...s.sendMessage.mock.calls.map(c => String(c[1]))]
      expect(said.some(t => t.startsWith('邀请码:'))).toBe(true)
      expect(said.some(t => t.includes('目前没有待批准'))).toBe(true)
    } finally { teardown(s.stateDir); llmDown = true }
  })
})

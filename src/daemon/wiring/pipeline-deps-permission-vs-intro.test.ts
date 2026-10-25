import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { inboundTurn } from './test-inbound-turn'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The `dispatch.coordinator.dispatch` seam in pipeline-deps.ts intercepts an
// owner control command ("回信 <ch> <text>" / "派 <ref>" / "取消 <ref>") before
// it reaches a normal agent turn. `isAdmin` (src/lib/access.ts) reads
// access.json from the module-level STATE_DIR (src/lib/config.ts), which is
// NOT one of buildPipelineDeps's injectable opts — so, mirroring
// src/lib/access.test.ts, STATE_DIR is redirected to a temp dir via
// vi.mock BEFORE anything imports access.ts/config.ts, and pipeline-deps is
// loaded dynamically afterward so it (transitively) picks up the mock.
const ACCESS_STATE_DIR = mkdtempSync(join(tmpdir(), 'pipeline-deps-social-access-test-'))
// importOriginal + spread (fix round 2, hardening) — same rationale as
// pipeline-deps-pairing-dispatch.test.ts: a plain-object factory would
// silently drop UNDER_TEST_RUNNER (and any other config.ts export) in this
// module graph, defeating agy-mcp-config.ts's/providers.ts's test-runner
// guards (fix round 1) should this graph ever boot providers.
vi.mock('../../lib/config.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/config')>()
  return { ...actual, STATE_DIR: ACCESS_STATE_DIR }
})

const { buildPipelineDeps } = await import('./pipeline-deps')
const { openTestDb } = await import('../../lib/db')
const { makeReplySinks } = await import('../reply-sinks')

import type { Bootstrap } from '../bootstrap/index'
import type { IlinkAdapter } from '../ilink-glue'
import type { ChatPrefsStore } from '../chat-prefs'
import type { CareLedger } from '../companion/care-ledger'
import type { InboundMsg } from '../../core/prompt-format'
import type { Mode } from '../../core/conversation'

// Connection-health (Task 9) — buildPipelineDeps dereferences boot.health.health
// unconditionally (llmHealth mw dep), so every `boot` fixture needs a minimal
// stand-in even though these tests never exercise the health machine itself.
const fakeHealth = {
  health: { shouldSuspend: () => false, get: () => ({ consecutiveFailures: 0 }) },
} as unknown as Bootstrap['health']

const ACCESS_FILE = join(ACCESS_STATE_DIR, 'access.json')
function writeAccess(admins: string[]): void {
  writeFileSync(ACCESS_FILE, JSON.stringify({ dmPolicy: 'allowlist', allowFrom: [], admins }, null, 2))
}

// Shared cleanup for ACCESS_STATE_DIR — a single top-level afterAll (not
// nested in either describe below) so it fires once, after every test in
// this file has run, regardless of which describe block runs last.
afterAll(() => { rmSync(ACCESS_STATE_DIR, { recursive: true, force: true }) })

// 「同意 <码>」两头都认:权限卡的放行词(pending-permissions 的 ALLOW_WORDS,码是两位数)和介绍的「同意 <引用>」
// (intro-command:2–8 位十六进制,「07」也算)。规矩(整合者拍板,10-22):**权限卡优先,但只在真的有那张卡时** ——
// 有同码、还在等的卡 ⇒ 权限那边批;没有 ⇒ 落到介绍。理由:权限卡是 blocking,被介绍吃掉,执行者就一直卡着、
// 主人还以为批了;介绍被吃掉,最坏是再说一次。
// 现在这条规矩只靠命令表里 permission-reply 排在 control 前面在撑(pipeline-deps.ts 的 commandRegistry),
// 这里把它钉死:谁把 control 挪到前面,这几条就红。
describe('「同意 <码>」:有那张待批卡 ⇒ 批权限;没有 ⇒ 介绍', () => {
  let stateDir: string
  beforeEach(() => { stateDir = mkdtempSync(join(tmpdir(), 'pipeline-deps-perm-intro-')); writeAccess(['op_chat']) })

  function setup(o: { social: boolean; pendingCode: string | null }) {
    const db = openTestDb()
    const coordinatorDispatch = vi.fn(async (_msg: InboundMsg) => {})
    const sendAssistantText = vi.fn(async (_chatId: string, _text: string) => {})
    const accept = vi.fn(async (_ref: string) => ({ ok: true as const }))
    const social = o.social ? {
      wish: { propose: vi.fn(), send: vi.fn(), cancel: vi.fn(), list: vi.fn(() => []), resolveRef: vi.fn() },
      intro: { request: vi.fn(), accept, decline: vi.fn() },
      penpal: { sendLetter: vi.fn(), resendLetter: vi.fn(), channelStore: {}, letterStore: {}, startVisit: vi.fn(), activeVisit: () => null },
    } as unknown as Bootstrap['social'] : undefined
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
      social,
      penpal: undefined,
      health: fakeHealth,
    } as unknown as Bootstrap
    // 权限这一头:跟 ilink-glue 的 probePermissionReply 同一条判定 —— 带码时只认「这个码对得上一张还在等的、这个对话的卡」
    const approved: string[] = []
    const claims = (text: string, chatId?: string) => {
      const m = /^\s*(?:同意|y|允许)\s+(\d{2})\s*$/.exec(text)
      return !!m && m[1] === o.pendingCode && chatId === 'op_chat'
    }
    const ilink = {
      probePermissionReply: (text: string, chatId?: string) => claims(text, chatId),
      handlePermissionReply: (text: string, chatId?: string) => { if (!claims(text, chatId)) return false; approved.push(text); return true },
    } as unknown as IlinkAdapter
    const chatPrefs: ChatPrefsStore = { get: () => ({}), set: () => ({}), list: () => [] }
    const careLedger: CareLedger = { get: () => ({ noReplyCount: 0 }), claim: vi.fn(), claimHunt: vi.fn(), claimVisit: vi.fn(), claimMemory: vi.fn(), resetNoReply: vi.fn(), unclaim: vi.fn() }
    const { pipelineDeps } = buildPipelineDeps(
      { stateDir, db, ilink, boot, log: () => {}, chatPrefs, careLedger, replySinks: makeReplySinks() },
      { polling: () => null, pipeline: () => null, ingestNudge: () => null },
    )
    return { pipelineDeps, coordinatorDispatch, sendAssistantText, accept, approved }
  }
  const msg = (text: string): InboundMsg => ({ chatId: 'op_chat', userId: 'op_chat', text, msgType: 'text', createTimeMs: Date.now(), accountId: 'acct1' })
  const said = (s: ReturnType<typeof setup>) => s.sendAssistantText.mock.calls.map(c => c[1])

  it('社交开着、有一张码 07 的待批卡 ⇒ 批的是权限,介绍不动', async () => {
    const s = setup({ social: true, pendingCode: '07' })
    await inboundTurn(s.pipelineDeps, msg('同意 07'))
    expect(s.approved).toEqual(['同意 07'])
    expect(s.accept).not.toHaveBeenCalled()
    expect(s.coordinatorDispatch).not.toHaveBeenCalled()
  })
  it('社交开着、没有这张卡 ⇒ 落到介绍(同意 07 号邀约)', async () => {
    const s = setup({ social: true, pendingCode: null })
    await inboundTurn(s.pipelineDeps, msg('同意 07'))
    expect(s.approved).toEqual([])
    expect(s.accept).toHaveBeenCalledWith('07')
  })
  it('社交关着、有这张卡 ⇒ 批权限;不说「社交关着」', async () => {
    const s = setup({ social: false, pendingCode: '07' })
    await inboundTurn(s.pipelineDeps, msg('同意 07'))
    expect(s.approved).toEqual(['同意 07'])
    expect(said(s).join('\n')).not.toMatch(/社交/)
  })
  it('社交关着、没有这张卡 ⇒ 普通对话;也不说「社交关着」(这句只可能是在批权限)', async () => {
    const s = setup({ social: false, pendingCode: null })
    await inboundTurn(s.pipelineDeps, msg('同意 07'))
    expect(s.coordinatorDispatch).toHaveBeenCalledTimes(1)
    expect(said(s).join('\n')).not.toMatch(/社交/)
  })
})

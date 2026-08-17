// Degraded-boot follow-up (item C) — the guard and knowledge-ingest
// subsystems are both wired through late-bound `Ref`s (src/lib/lifecycle.ts)
// that main.ts sets AFTER registerGuard/registerIngest run. If either
// subsystem degrades (SubsystemSupervisor swallows its throw — see
// src/daemon/subsystems.ts) or simply hasn't wired yet, its Ref is never
// `.set()`, and pipeline-deps.ts's two consumer closures fall back:
//   - guard.guardState (pipeline-deps.ts:369):
//       () => refs.guard.current?.current() ?? { reachable: true, ip: null }
//   - activity.recordInbound (pipeline-deps.ts:399):
//       (chatId, when) => { refs.ingestNudge.current?.(); return recordInbound(chatId, when) }
// These fallbacks are what keeps the inbound pipeline alive when guard/
// ingest never wire. This test exercises the REAL closures buildPipelineDeps
// returns (not a reimplementation of the expression) with fresh, deliberately
// unwired Refs.
import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildPipelineDeps } from './pipeline-deps'
import { Ref } from '../../lib/lifecycle'
import { openTestDb } from '../../lib/db'
import { makeReplySinks } from '../reply-sinks'

import type { Bootstrap } from '../bootstrap/index'
import type { IlinkAdapter } from '../ilink-glue'
import type { ChatPrefsStore } from '../chat-prefs'
import type { CareLedger } from '../companion/care-ledger'

// buildPipelineDeps dereferences boot.health.health unconditionally (llmHealth
// mw dep) even though this test never touches the health machine — same
// minimal stand-in used by the other pipeline-deps wiring test files.
const fakeHealth = {
  health: { shouldSuspend: () => false, get: () => ({ consecutiveFailures: 0 }) },
} as unknown as Bootstrap['health']

function setup() {
  const stateDir = mkdtempSync(join(tmpdir(), 'pipeline-deps-degraded-test-'))
  const db = openTestDb()
  const boot = {
    sessionManager: { isInFlight: () => false } as unknown as Bootstrap['sessionManager'],
    sessionStore: {} as Bootstrap['sessionStore'],
    conversationStore: { upsertIdentity: () => {} } as unknown as Bootstrap['conversationStore'],
    registry: { get: () => undefined, list: () => [], getCheapEval: () => null, has: () => false } as unknown as Bootstrap['registry'],
    coordinator: { dispatch: async () => {}, getMode: () => ({ kind: 'solo', provider: 'claude' }), cancel: () => false } as unknown as Bootstrap['coordinator'],
    resolve: () => null,
    formatInbound: (() => {}) as unknown as Bootstrap['formatInbound'],
    sdkOptionsForProject: (() => {}) as unknown as Bootstrap['sdkOptionsForProject'],
    buildInstructions: () => '',
    defaultProviderId: 'claude',
    agentProviderKind: 'claude',
    dispatchDelegate: (() => {}) as unknown as Bootstrap['dispatchDelegate'],
    a2aDeps: undefined,
    a2aServer: null,
    agentConfig: { bot_name: null } as unknown as Bootstrap['agentConfig'],
    sendAssistantText: async () => {},
    social: undefined,
    penpal: undefined,
    health: fakeHealth,
  } as unknown as Bootstrap

  const ilink = {} as unknown as IlinkAdapter
  const chatPrefs: ChatPrefsStore = { get: () => ({}), set: () => ({}), list: () => [] }
  const careLedger: CareLedger = { get: () => ({ noReplyCount: 0 }), claim: () => {}, claimHunt: () => {}, resetNoReply: () => {} } as unknown as CareLedger
  const replySinks = makeReplySinks()

  // The point of this test: guard/pipeline/polling AND ingestNudge Refs are
  // constructed fresh and deliberately never `.set()` — exactly the
  // "subsystem never wired" state a degraded boot leaves behind.
  const { pipelineDeps } = buildPipelineDeps(
    { stateDir, db, ilink, boot, log: () => {}, chatPrefs, careLedger, replySinks },
    { polling: new Ref('polling'), guard: new Ref('guard'), pipeline: new Ref('pipeline'), ingestNudge: new Ref('ingestNudge') },
  )
  return { pipelineDeps, stateDir }
}

describe('pipeline-deps degraded-consumer fallbacks (guard / ingestNudge)', () => {
  it('guardState() falls back to reachable:true, ip:null when the guard Ref was never wired', () => {
    const { stateDir, pipelineDeps } = setup()
    try {
      expect(pipelineDeps.guard.guardState()).toEqual({ reachable: true, ip: null })
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('activity.recordInbound does not throw when the ingestNudge Ref was never wired', async () => {
    const { stateDir, pipelineDeps } = setup()
    try {
      await expect(pipelineDeps.activity.recordInbound('chat1', new Date())).resolves.not.toThrow()
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })
})

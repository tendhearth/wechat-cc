// src/core/agy-agent-provider.test.ts — 全部经注入 spawnFn 的假 agy
import { describe, it, expect } from 'vitest'
import { createAgyAgentProvider } from './agy-agent-provider'
import { TIER_PROFILES } from './user-tier'

function fakeAgy(lines: string[], opts?: { exitCode?: number; stderr?: string; hang?: boolean }) {
  const calls: Array<{ args: string[]; cwd: string }> = []
  let killed = false
  const spawnFn = (args: string[], o: { cwd: string }) => {
    calls.push({ args, cwd: o.cwd })
    return {
      stdout: (async function* () { for (const l of lines) yield l + '\n'; if (opts?.hang) await new Promise(() => {}) })(),
      exited: Promise.resolve(opts?.exitCode ?? 0),
      stderr: async () => opts?.stderr ?? '',
      kill: () => { killed = true },
    }
  }
  return { spawnFn, calls, wasKilled: () => killed }
}

const INIT = JSON.stringify({ event: 'init', conversation_id: 'c1', init: { model: 'm', tools: [], permission_mode: 'request-review' } })
const TEXT_DONE = JSON.stringify({ event: 'step_update', step_update: { conversation_id: 'c1', step_index: 2, state: 'DONE', step_type: 'agent_response', text_delta: 'hi' } })
const RESULT = JSON.stringify({ event: 'result', result: { conversation_id: 'c1', status: 'SUCCESS', response: 'hi', num_turns: 1 } })

// Auth-shaped assistant text — hits AUTH_FAIL_ASSISTANT_TEXT ('Not logged in'),
// used to prove cheapEval's assertNotAuthFailed wiring (Step 3 contract).
const AUTH_TEXT_DONE = JSON.stringify({ event: 'step_update', step_update: { conversation_id: 'c1', step_index: 2, state: 'DONE', step_type: 'agent_response', text_delta: 'Not logged in' } })
const AUTH_RESULT = JSON.stringify({ event: 'result', result: { conversation_id: 'c1', status: 'SUCCESS', response: 'Not logged in', num_turns: 1 } })

const ctx = { tierProfile: TIER_PROFILES.guest, permissionMode: 'strict' as const, chatId: 'chat1' }
const project = { alias: 'p', path: '/tmp' }

async function drain(it: AsyncIterable<{ kind: string }>) { const out = []; for await (const e of it) out.push(e); return out }

describe('createAgyAgentProvider', () => {
  it('happy turn: init+text+result; second dispatch carries --conversation', async () => {
    const { spawnFn, calls } = fakeAgy([INIT, TEXT_DONE, RESULT])
    const provider = createAgyAgentProvider({ bin: 'agy', model: 'm', spawnFn, log: () => {} })
    const s = await provider.spawn(project, ctx)
    const evs = await drain(s.dispatch('你好'))
    expect(evs.map(e => e.kind)).toEqual(['init', 'text', 'result'])
    await drain(s.dispatch('再来'))
    expect(calls[1]!.args).toContain('--conversation')
    expect(calls[1]!.args).toContain('c1')
    expect(calls[0]!.args).not.toContain('--conversation')
  })

  // CONTROLLER RULING 1 (Task 1 spike): first dispatch of a session with no
  // conversationId claims a project binding via --new-project; continued
  // turns rely on the conversation's own binding — no --new-project.
  it('RULING 1: first dispatch adds --new-project; continued dispatch does not', async () => {
    const { spawnFn, calls } = fakeAgy([INIT, TEXT_DONE, RESULT])
    const provider = createAgyAgentProvider({ bin: 'agy', model: 'm', spawnFn, log: () => {} })
    const s = await provider.spawn(project, ctx)
    await drain(s.dispatch('你好'))
    expect(calls[0]!.args).toContain('--new-project')
    await drain(s.dispatch('再来'))
    expect(calls[1]!.args).toContain('--conversation')
    expect(calls[1]!.args).toContain('c1')
    expect(calls[1]!.args).not.toContain('--new-project')
  })

  it('resumeSessionId seeds --conversation on the FIRST dispatch', async () => {
    const { spawnFn, calls } = fakeAgy([INIT, TEXT_DONE, RESULT])
    const provider = createAgyAgentProvider({ bin: 'agy', model: 'm', spawnFn, log: () => {} })
    const s = await provider.spawn(project, { ...ctx, resumeSessionId: 'old-c' })
    await drain(s.dispatch('hi'))
    expect(calls[0]!.args).toContain('old-c')
    // RULING 1: resumeSessionId-seeded first dispatches use --conversation
    // only — the session already has a binding, no --new-project.
    expect(calls[0]!.args).not.toContain('--new-project')
  })

  it('dangerously permissionMode adds --dangerously-skip-permissions; strict does not', async () => {
    const { spawnFn, calls } = fakeAgy([INIT, TEXT_DONE, RESULT])
    const provider = createAgyAgentProvider({ bin: 'agy', model: 'm', spawnFn, log: () => {} })
    const s1 = await provider.spawn(project, { ...ctx, permissionMode: 'dangerously' })
    await drain(s1.dispatch('x'))
    expect(calls[0]!.args).toContain('--dangerously-skip-permissions')
    const s2 = await provider.spawn(project, ctx)
    await drain(s2.dispatch('x'))
    expect(calls[1]!.args).not.toContain('--dangerously-skip-permissions')
  })

  it('nonzero exit without result → error event; auth-shaped stderr classifies auth_failed', async () => {
    const { spawnFn } = fakeAgy([INIT], { exitCode: 1, stderr: 'error getting entitlement: not authenticated' })
    const provider = createAgyAgentProvider({ bin: 'agy', model: 'm', spawnFn, log: () => {} })
    const s = await provider.spawn(project, ctx)
    const evs = await drain(s.dispatch('x'))
    const err = evs.find(e => e.kind === 'error')
    expect(err).toBeTruthy()
    expect((err as { code?: string }).code).toBe('auth_failed')
  })

  it('overlapping dispatch throws; cancel kills the child', async () => {
    const { spawnFn, wasKilled } = fakeAgy([INIT], { hang: true })
    const provider = createAgyAgentProvider({ bin: 'agy', model: 'm', spawnFn, log: () => {} })
    const s = await provider.spawn(project, ctx)
    const it = s.dispatch('long')[Symbol.asyncIterator]()
    await it.next()   // init 出来,turn 在飞
    expect(() => s.dispatch('again')).toThrow()
    await s.cancel!()
    expect(wasKilled()).toBe(true)
    await it.return?.()
  })

  it('ctx.model overrides construction model in --model arg', async () => {
    const { spawnFn, calls } = fakeAgy([INIT, TEXT_DONE, RESULT])
    const provider = createAgyAgentProvider({ bin: 'agy', model: 'default-m', spawnFn, log: () => {} })
    const s = await provider.spawn(project, { ...ctx, model: 'pinned-m' })
    await drain(s.dispatch('x'))
    const i = calls[0]!.args.indexOf('--model')
    expect(calls[0]!.args[i + 1]).toBe('pinned-m')
  })

  it('cheapEval: one-shot with flash-low model, returns response text', async () => {
    const { spawnFn, calls } = fakeAgy([INIT, TEXT_DONE, RESULT])
    const provider = createAgyAgentProvider({ bin: 'agy', model: 'm', spawnFn, log: () => {} })
    const text = await provider.cheapEval!('prompt')
    expect(text).toBe('hi')
    expect(calls[0]!.args).toContain('gemini-3.7-flash-low')
    // CONTROLLER RULING 2: one-shot evals add neither --conversation nor
    // --new-project (no session, tools already auto-denied in print mode).
    expect(calls[0]!.args).not.toContain('--conversation')
    expect(calls[0]!.args).not.toContain('--new-project')
  })

  it('cheapEval: auth-shaped response text throws', async () => {
    const { spawnFn } = fakeAgy([INIT, AUTH_TEXT_DONE, AUTH_RESULT])
    const provider = createAgyAgentProvider({ bin: 'agy', model: 'm', spawnFn, log: () => {} })
    await expect(provider.cheapEval!('prompt')).rejects.toThrow()
  })
})

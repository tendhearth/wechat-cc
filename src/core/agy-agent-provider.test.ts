// src/core/agy-agent-provider.test.ts — 全部经注入 spawnFn 的假 agy
import { describe, it, expect } from 'vitest'
import { createAgyAgentProvider, drainCappedStderr } from './agy-agent-provider'
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

  // MINOR 5: exact args array (not just "doesn't contain the flag") so a
  // future strict-mode flag addition (e.g. --mode plan) fails this test.
  it('strict mode, fresh session: exact args array', async () => {
    const { spawnFn, calls } = fakeAgy([INIT, TEXT_DONE, RESULT])
    const provider = createAgyAgentProvider({ bin: 'agy', model: 'm', spawnFn, log: () => {}, turnTimeoutMs: 600_000 })
    const s = await provider.spawn(project, ctx)
    await drain(s.dispatch('x'))
    expect(calls[0]!.args).toEqual(['-p', 'x', '--output-format', 'stream-json', '--model', 'm', '--print-timeout', '600s', '--new-project'])
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

  // CRITICAL 1 (task review): it.return() called DIRECTLY on the raw
  // iterator — bypassing s.cancel() entirely — must still abort + kill the
  // child promptly, and must leave the session free for the next dispatch().
  it('CRITICAL: it.return() with no explicit cancel() aborts+kills a hung child and frees inFlight', async () => {
    const { spawnFn, wasKilled } = fakeAgy([INIT], { hang: true })
    const provider = createAgyAgentProvider({ bin: 'agy', model: 'm', spawnFn, log: () => {} })
    const s = await provider.spawn(project, ctx)
    const it = s.dispatch('long')[Symbol.asyncIterator]()
    await it.next()
    await it.return?.()
    expect(wasKilled()).toBe(true)
    expect(() => s.dispatch('again')).not.toThrow()
  })

  // CRITICAL 1 (task review): a plain `break` out of a for-await loop is the
  // MOST COMMON way a caller abandons a dispatch — must kill the child too.
  it('CRITICAL: breaking out of a for-await loop kills a hung child', async () => {
    const { spawnFn, wasKilled } = fakeAgy([INIT], { hang: true })
    const provider = createAgyAgentProvider({ bin: 'agy', model: 'm', spawnFn, log: () => {} })
    const s = await provider.spawn(project, ctx)
    for await (const ev of s.dispatch('long')) {
      expect(ev.kind).toBe('init')
      break
    }
    expect(wasKilled()).toBe(true)
  })

  // CRITICAL (task review round 2): a STALE iterator's return() — called
  // AFTER a later turn has already started — must not touch that later
  // turn's child or session state. Reproduction: turn1 fully drains and
  // completes; turn2 starts and is in flight; it1.return() (a straggler
  // reference from turn1) must be a no-op with respect to turn2.
  it('CRITICAL (round 2): a stale iterator return() does not kill a LATER turn or wipe its state', async () => {
    const calls: Array<{ args: string[]; cwd: string }> = []
    let call = 0
    let killed2 = false
    const spawnFn = (args: string[], o: { cwd: string }) => {
      calls.push({ args, cwd: o.cwd })
      call++
      if (call === 1) {
        // turn1: completes normally.
        return {
          stdout: (async function* () { yield INIT + '\n'; yield TEXT_DONE + '\n'; yield RESULT + '\n' })(),
          exited: Promise.resolve(0),
          stderr: async () => '',
          kill: () => {},
        }
      }
      // turn2: this session's SECOND dispatch — no 'init' AgentEvent gets
      // yielded for it (only the session's first dispatch ever emits init),
      // so give it a text_delta line to take before it hangs, so next()
      // has something to resolve with while still leaving it "in flight".
      return {
        stdout: (async function* () { yield INIT + '\n'; yield TEXT_DONE + '\n'; await new Promise(() => {}) })(),
        exited: Promise.resolve(0),
        stderr: async () => '',
        kill: () => { killed2 = true },
      }
    }
    const provider = createAgyAgentProvider({ bin: 'agy', model: 'm', spawnFn, log: () => {} })
    const s = await provider.spawn(project, ctx)

    // turn1: drain manually via next() (not the `drain()` helper) so we
    // retain its own iterator handle for the stale return() call below.
    const evsTurn1: string[] = []
    const iterTurn1 = s.dispatch('one')[Symbol.asyncIterator]()
    for (;;) {
      const step = await iterTurn1.next()
      if (step.done) break
      evsTurn1.push((step.value as { kind: string }).kind)
    }
    expect(evsTurn1).toEqual(['init', 'text', 'result'])

    // turn2: starts on the SAME session, takes one event (text), stays in flight.
    const iterTurn2 = s.dispatch('two')[Symbol.asyncIterator]()
    const step2 = await iterTurn2.next()
    expect((step2.value as { kind: string } | undefined)?.kind).toBe('text')

    // Stale turn1 iterator's return(), called AFTER turn2 has started, must
    // be a complete no-op with respect to turn2.
    await iterTurn1.return?.()
    expect(killed2).toBe(false)
    expect(() => s.dispatch('three')).toThrow() // overlap guard still armed — turn2 still in flight
    await s.cancel!()
    expect(killed2).toBe(true) // cancel() still works on the REAL in-flight turn
    await iterTurn2.return?.()
  })

  // MINOR (task review round 2): throw() on the raw iterator must mirror
  // return()'s abort+kill behavior — otherwise it reintroduces the same
  // orphaned-child leak return() was fixed for, just via a different path.
  it('MINOR (round 2): throw() on the iterator aborts+kills a hung child', async () => {
    const { spawnFn, wasKilled } = fakeAgy([INIT], { hang: true })
    const provider = createAgyAgentProvider({ bin: 'agy', model: 'm', spawnFn, log: () => {} })
    const s = await provider.spawn(project, ctx)
    const it = s.dispatch('long')[Symbol.asyncIterator]()
    await it.next()
    await it.throw?.(new Error('injected')).catch(() => {
      // The generator has no catch around the yield point, so the injected
      // error propagates out of throw() as a rejection — expected; we only
      // care about the side effect (abort+kill) here.
    })
    expect(wasKilled()).toBe(true)
  })

  // MINOR (task review round 2): a dispatch() that's created and then
  // return()ed WITHOUT ever being iterated must have zero side effects on
  // session state — the real next dispatch should still see isFirst/
  // appendInstructions exactly as if the abandoned one never happened.
  it('MINOR (round 2): an abandoned (never-iterated) dispatch has zero side effects', async () => {
    const { spawnFn, calls } = fakeAgy([INIT, TEXT_DONE, RESULT])
    const provider = createAgyAgentProvider({ bin: 'agy', model: 'm', spawnFn, log: () => {} })
    const s = await provider.spawn(project, { ...ctx, appendInstructions: 'SYS' })
    const abandoned = s.dispatch('never used')
    await abandoned[Symbol.asyncIterator]().return?.()
    // The abandoned dispatch never actually spawned (generator body never
    // ran) — confirm the FIRST REAL dispatch still carries the prefix + --new-project.
    await drain(s.dispatch('real'))
    expect(calls.length).toBe(1)
    const i0 = calls[0]!.args.indexOf('-p')
    expect(calls[0]!.args[i0 + 1]).toBe('SYS\n\n---\n\nreal')
    expect(calls[0]!.args).toContain('--new-project')
  })

  it('ctx.model overrides construction model in --model arg', async () => {
    const { spawnFn, calls } = fakeAgy([INIT, TEXT_DONE, RESULT])
    const provider = createAgyAgentProvider({ bin: 'agy', model: 'default-m', spawnFn, log: () => {} })
    const s = await provider.spawn(project, { ...ctx, model: 'pinned-m' })
    await drain(s.dispatch('x'))
    const i = calls[0]!.args.indexOf('--model')
    expect(calls[0]!.args[i + 1]).toBe('pinned-m')
  })

  // IMPORTANT 3 (controller ruling): appendInstructions prefixes the -p text
  // of the session's first dispatch only, codex-style.
  it('RULING 3: appendInstructions prefixes only the first dispatch of a session', async () => {
    const { spawnFn, calls } = fakeAgy([INIT, TEXT_DONE, RESULT])
    const provider = createAgyAgentProvider({ bin: 'agy', model: 'm', spawnFn, log: () => {} })
    const s = await provider.spawn(project, { ...ctx, appendInstructions: 'SYSTEM RULES' })
    await drain(s.dispatch('hello'))
    const i0 = calls[0]!.args.indexOf('-p')
    expect(calls[0]!.args[i0 + 1]).toBe('SYSTEM RULES\n\n---\n\nhello')
    await drain(s.dispatch('again'))
    const i1 = calls[1]!.args.indexOf('-p')
    expect(calls[1]!.args[i1 + 1]).toBe('again')
  })

  // IMPORTANT 3, careful case flagged by the controller: resumeSessionId
  // sessions have no "first fresh turn" (they always send --conversation),
  // but still need the instructions injected exactly once.
  it('RULING 3: resumeSessionId-seeded session still gets appendInstructions once on its first dispatch', async () => {
    const { spawnFn, calls } = fakeAgy([INIT, TEXT_DONE, RESULT])
    const provider = createAgyAgentProvider({ bin: 'agy', model: 'm', spawnFn, log: () => {} })
    const s = await provider.spawn(project, { ...ctx, resumeSessionId: 'old-c', appendInstructions: 'SYS' })
    await drain(s.dispatch('hi'))
    const i0 = calls[0]!.args.indexOf('-p')
    expect(calls[0]!.args[i0 + 1]).toBe('SYS\n\n---\n\nhi')
    expect(calls[0]!.args).not.toContain('--new-project')
    await drain(s.dispatch('again'))
    const i1 = calls[1]!.args.indexOf('-p')
    expect(calls[1]!.args[i1 + 1]).toBe('again')
  })

  // MINOR 7: sessionArgsFor's env has no wire-through in v1 (AgySpawnFn has
  // no env slot) — a non-empty env must be logged loudly, not dropped silently.
  it('sessionArgsFor env is ignored but logged loudly', async () => {
    const { spawnFn } = fakeAgy([INIT, TEXT_DONE, RESULT])
    const logs: Array<{ tag: string; line: string }> = []
    const provider = createAgyAgentProvider({
      bin: 'agy',
      model: 'm',
      spawnFn,
      log: (tag, line) => logs.push({ tag, line }),
      sessionArgsFor: () => ({ args: [], env: { FOO: 'bar' } }),
    })
    const s = await provider.spawn(project, ctx)
    await drain(s.dispatch('x'))
    expect(logs.some(l => l.tag === 'AGY' && l.line.includes('sessionArgsFor.env ignored'))).toBe(true)
  })

  // MINOR 4: a real child's stdout arrives as raw Uint8Array chunks that can
  // split anywhere — including mid multi-byte UTF-8 character and mid NDJSON
  // line — and the final chunk may have no trailing newline at all.
  it('reassembles a line split across Uint8Array chunks mid multi-byte UTF-8 char, no trailing newline', async () => {
    const utf8TextDone = JSON.stringify({ event: 'step_update', step_update: { conversation_id: 'c1', step_index: 2, state: 'DONE', step_type: 'agent_response', text_delta: '你好😀' } })
    const full = [INIT, utf8TextDone, RESULT].join('\n') // deliberately no trailing newline
    const bytes = new TextEncoder().encode(full)
    const chunkSize = 7 // small enough to guarantee splits inside lines AND multi-byte chars
    async function* chunkedStdout(): AsyncGenerator<Uint8Array> {
      for (let i = 0; i < bytes.length; i += chunkSize) {
        yield bytes.slice(i, i + chunkSize)
      }
    }
    const spawnFn = () => ({
      stdout: chunkedStdout(),
      exited: Promise.resolve(0),
      stderr: async () => '',
      kill: () => {},
    })
    const provider = createAgyAgentProvider({ bin: 'agy', model: 'm', spawnFn, log: () => {} })
    const s = await provider.spawn(project, ctx)
    const evs = await drain(s.dispatch('x'))
    expect(evs.map(e => e.kind)).toEqual(['init', 'text', 'result'])
    const textEv = evs.find(e => e.kind === 'text') as { text?: string } | undefined
    expect(textEv?.text).toBe('你好😀')
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

// IMPORTANT 2 (task review): stderr must be drained concurrently, not lazily
// on-demand, or a chatty child deadlocks on a full OS pipe buffer.
describe('drainCappedStderr', () => {
  it('reads concurrently (starts at call time) and caps captured output', async () => {
    let controllerRef!: ReadableStreamDefaultController<Uint8Array>
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controllerRef = controller },
    })
    const resultPromise = drainCappedStderr(stream, 8) // tiny cap for the test
    controllerRef.enqueue(new TextEncoder().encode('0123456789ABCDEF')) // 16 bytes > cap
    controllerRef.close()
    const text = await resultPromise
    expect(text).toBe('01234567')
  })

  it("exit-error message surfaces stderr captured by drainCappedStderr's concurrent reader", async () => {
    let controllerRef!: ReadableStreamDefaultController<Uint8Array>
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controllerRef = controller },
    })
    const stderrPromise = drainCappedStderr(stream, 65536)
    controllerRef.enqueue(new TextEncoder().encode('boom: something broke'))
    controllerRef.close()

    const spawnFn = () => ({
      stdout: (async function* () { yield INIT + '\n' })(),
      exited: Promise.resolve(1),
      stderr: () => stderrPromise,
      kill: () => {},
    })
    const provider = createAgyAgentProvider({ bin: 'agy', model: 'm', spawnFn, log: () => {} })
    const s = await provider.spawn(project, ctx)
    const evs = await drain(s.dispatch('x'))
    const err = evs.find(e => e.kind === 'error') as { message?: string } | undefined
    expect(err?.message).toContain('boom: something broke')
  })
})

/**
 * agy agent provider — drives the Antigravity CLI (`agy`, subscription Gemini
 * via Google AI Pro OAuth, no GEMINI_API_KEY). Closest existing shape is
 * codex: one CLI invocation PER TURN, process exit == turn end. Unlike
 * codex/cursor (persistent SDK thread objects), agy has no SDK — every
 * dispatch spawns a fresh `agy -p <text> --output-format stream-json ...`
 * process and parses its NDJSON stdout via Task 2's makeAgyStreamParser.
 *
 * See docs/superpowers/specs/2026-08-17-agy-provider-design.md (spec) and
 * docs/superpowers/plans/2026-08-17-agy-provider.md (Task 1 spike — the
 * source of the CONTROLLER RULINGS baked into arg assembly below).
 */
import { tmpdir } from 'node:os'
import { assertNotAuthFailed, type AgentEvent, type AgentProject, type AgentProvider, type AgentSession, type CheapEval, type ProviderCapabilities, type SpawnContext } from './agent-provider'
import { makeAgyStreamParser } from './agy-stream'
import { makeTurnEmitter } from './turn-emitter'

/**
 * RFC 05 Phase 2 capability declaration. agy has no per-tool callback (print
 * mode auto-denies/auto-allows) and no SDK sandbox surface we map in v1
 * (`--sandbox` deferred, see spec §7 non-goals). Resume IS real (native
 * `--conversation <id>`); delegation is explicitly out for v1 (spec §0
 * decision 2 — supportsDelegation:false keeps agy off primary_tool/parallel).
 */
export const AGY_CAPABILITIES: ProviderCapabilities = {
  perToolCallback: false,
  // agy-mcp-config.ts pins WECHAT_SESSION_TIER to 'trusted' for its MCP
  // child (one static token, not per-session) — SESSION_IS_ADMIN is always
  // false, so admin-only tools (incl. the social-tools family) never
  // register for agy even when the owner is chatting.
  adminMcpTools: false,
  sandboxLevels: new Set(),
  supportsDelegation: false,
  supportsResume: true,
  defaultPeer: 'claude',
  authFailHint: 'agy 登录态失效，请在电脑上跑一次 `agy` 重新登录后再发消息。',
}

/** Test-time (and default Bun.spawn) seam for the agy child process. */
export interface AgySpawnHandle {
  stdout: AsyncIterable<Uint8Array | string>
  exited: Promise<number>
  stderr(): Promise<string>
  kill(): void
}
export type AgySpawnFn = (args: string[], opts: { cwd: string }) => AgySpawnHandle

export interface AgyAgentProviderOptions {
  /** agy binary path (bootstrap resolves + probes `--version` before registering). */
  bin: string
  /** Default model (agyModel config); per-spawn ctx.model overrides. */
  model: string
  /**
   * spec §3 selected-tier product: per-spawn extra CLI args/env (Task 5
   * supplies the real implementation). v1 stays on tier C (global-only MCP
   * config, no per-session parameters) so this is always `{}` in production
   * today. NOTE: `env` has no wire-through yet — `AgySpawnFn` (this task's
   * frozen contract) only carries `{ cwd }`, so a non-empty `env` is
   * detected and logged loudly rather than silently dropped (see dispatch()).
   */
  sessionArgsFor?: (ctx: SpawnContext) => { args: string[]; env?: Record<string, string> }
  /** Injection seam for tests (fake agy). Default: Bun.spawn wrapper. */
  spawnFn?: AgySpawnFn
  /** → `--print-timeout` (ms, converted to whole seconds). Default 600_000. */
  turnTimeoutMs?: number
  log: (tag: string, line: string) => void
}

const DEFAULT_TURN_TIMEOUT_MS = 600_000
/** spec §2 — cheapEval always uses the cheapest subscription model, regardless of the provider's configured default. */
const CHEAP_EVAL_MODEL = 'gemini-3.7-flash-low'
/** Cap on captured stderr text (see drainCappedStderr's doc comment). */
const STDERR_CAP_BYTES = 64 * 1024

function msToPrintTimeout(ms: number): string {
  return `${Math.max(1, Math.round(ms / 1000))}s`
}

/**
 * Read `stream` to completion CONCURRENTLY (the read loop starts the moment
 * this is called, not lazily when the returned promise is awaited) and cap
 * the captured text at `capBytes`, discarding anything past the cap while
 * STILL draining every subsequent chunk.
 *
 * Load-bearing: agy's stderr is piped (`stderr: 'pipe'`), and a pipe has a
 * finite OS buffer (~64KB on macOS/Linux). If nobody reads it, a child that
 * writes past that buffer blocks on its own `write()` call forever — and
 * since dispatch() only calls `handle.stderr()` AFTER `proc.exited`
 * resolves, a child wedged on a full stderr pipe would never exit, so
 * `exited` never resolves either: total deadlock. (This is the exact hazard
 * `knowledge/embed-runner.ts` sidesteps by using `stderr: 'inherit'` instead
 * of `'pipe'` — we can't do that here because `stderr()` needs to return
 * captured text for the exit-error message, so instead we drain the pipe
 * concurrently ourselves, same effect via a different mechanism.)
 */
export function drainCappedStderr(stream: ReadableStream<Uint8Array>, capBytes: number): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const chunks: Uint8Array[] = []
  let total = 0
  return (async () => {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      if (value.length > 0) {
        if (total < capBytes) {
          const remaining = capBytes - total
          chunks.push(value.length > remaining ? value.slice(0, remaining) : value)
        }
        total += value.length
      }
    }
    let out = ''
    for (const chunk of chunks) out += decoder.decode(chunk, { stream: true })
    out += decoder.decode() // flush any trailing partial multi-byte sequence
    return out
  })()
}

function defaultSpawnFn(bin: string): AgySpawnFn {
  return (args, opts) => {
    const proc = Bun.spawn([bin, ...args], { cwd: opts.cwd, stdout: 'pipe', stderr: 'pipe' })
    // Start draining stderr NOW (concurrently with whatever the caller does
    // with stdout/exited) — see drainCappedStderr's doc comment for why a
    // lazy read-on-demand deadlocks against a chatty child.
    const stderrPromise = drainCappedStderr(proc.stderr as ReadableStream<Uint8Array>, STDERR_CAP_BYTES)
    // This promise is consumed later (only in the exit-error path, via the
    // `stderr` getter below) — attach a no-op catch NOW so a rejection
    // arriving before anyone calls `stderr()` can never surface as an
    // unhandled promise rejection. Doesn't change what `stderr()` itself
    // observes; only marks the promise as "handled" for the runtime.
    stderrPromise.catch(() => {})
    return {
      stdout: proc.stdout as unknown as AsyncIterable<Uint8Array>,
      exited: proc.exited,
      stderr: () => stderrPromise,
      kill: () => {
        try {
          proc.kill()
        } catch {
          // already gone — best effort
        }
      },
    }
  }
}

type LineRaceResult =
  | { tag: 'chunk'; r: IteratorResult<Uint8Array | string> }
  | { tag: 'aborted' }

/**
 * Line-buffer an agy child's stdout into complete NDJSON lines, racing every
 * pending read against `signal`. This is load-bearing for cancellation: a
 * plain `for await` directly over the raw handle would, on external
 * `.return()`, cascade an `IteratorClose` down onto the raw stream's
 * iterator while it's suspended mid-`await` on a chunk that may never
 * arrive (a genuinely wedged or killed child) — per spec, `.return()` on a
 * generator parked mid-await (not mid-yield) only settles once THAT SAME
 * promise settles, so a never-resolving read would hang the caller's
 * `cancel()`/`close()`/`it.return()` forever. Racing against an abort
 * signal instead gives every await here a promise that's guaranteed to
 * settle once the signal fires, independent of whether the child ever
 * produces another byte.
 *
 * The abort-tagged promise (`abortedTagged`) is built ONCE, outside the
 * loop, and reused on every iteration — building a fresh `aborted.then(...)`
 * derivative per line would permanently register a new reaction on the
 * (long-lived, often never-settling-until-cancel) `aborted` promise on
 * every single line of a turn, accumulating unboundedly on a long-running
 * turn with many events.
 */
async function* readLines(stream: AsyncIterable<Uint8Array | string>, signal: AbortSignal): AsyncGenerator<string> {
  const it = stream[Symbol.asyncIterator]()
  const decoder = new TextDecoder()
  let buf = ''
  const aborted: Promise<void> = signal.aborted
    ? Promise.resolve()
    : new Promise(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
  const abortedTagged: Promise<LineRaceResult> = aborted.then((): LineRaceResult => ({ tag: 'aborted' }))

  for (;;) {
    const idx = buf.indexOf('\n')
    if (idx >= 0) {
      yield buf.slice(0, idx)
      buf = buf.slice(idx + 1)
      continue
    }
    if (signal.aborted) return
    const race = await Promise.race<LineRaceResult>([
      it.next().then((r): LineRaceResult => ({ tag: 'chunk', r })),
      abortedTagged,
    ])
    if (race.tag === 'aborted') return
    if (race.r.done) break
    const chunk = race.r.value
    buf += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
  }
  if (buf.length > 0) yield buf
}

/** Sentinel returned by raceAbort when `signal` fires before `promise` settles. */
const ABORTED: unique symbol = Symbol('agy-abort-race')

/**
 * Race `promise` against `signal` firing — resolves with `promise`'s value
 * (or rejects with its rejection) if it settles first, or resolves with the
 * `ABORTED` sentinel if `signal` fires first.
 *
 * Used for the dispatch generator's TAIL awaits (`proc.exited`,
 * `proc.stderr()`) — both run AFTER the stdout loop has already ended
 * (normally or via abort), and neither was previously raced against the
 * abort signal. A slow-dying child can hang either one forever: a
 * SIGTERM-ignoring child never resolves `exited`; a grandchild process
 * (plausible with agy's MCP children) holding the stderr fd open can keep
 * `stderr()`'s drain from ever completing. Without this race, `kill()`
 * firing doesn't help — the awaited promise itself never settles — so
 * `cancel()`/`close()`/`it.return()` would hang right along with it (task
 * review round 3, empirically probed against both cases).
 */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | typeof ABORTED> {
  if (signal.aborted) return Promise.resolve(ABORTED)
  return new Promise<T | typeof ABORTED>((resolve, reject) => {
    const onAbort = (): void => resolve(ABORTED)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(err)
      },
    )
  })
}

/** Base args shared by every invocation (turn dispatch AND one-shot evals). */
function baseArgs(prompt: string, model: string, turnTimeoutMs: number): string[] {
  return ['-p', prompt, '--output-format', 'stream-json', '--model', model, '--print-timeout', msToPrintTimeout(turnTimeoutMs)]
}

/**
 * Shared one-shot body for cheapEval/strongEval: no session, no
 * `--conversation`, no `--new-project` (CONTROLLER RULING 2 — tools are
 * auto-denied in strict print mode anyway, and skipping `--new-project`
 * avoids bloating `~/.gemini/projects.json` with frequent background evals).
 * cwd is `tmpdir()` since these calls never touch the daemon's project tree.
 */
async function oneShotEval(spawnFn: AgySpawnFn, model: string, prompt: string, turnTimeoutMs: number): Promise<string> {
  const proc = spawnFn(baseArgs(prompt, model, turnTimeoutMs), { cwd: tmpdir() })
  const parser = makeAgyStreamParser()
  const texts: string[] = []
  let sawResult = false
  let errMsg: string | undefined
  const neverAborted = new AbortController().signal // one-shots aren't cancellable in v1
  for await (const line of readLines(proc.stdout, neverAborted)) {
    for (const ev of parser.feed(line)) {
      if (ev.kind === 'text') texts.push(ev.text)
      else if (ev.kind === 'result') sawResult = true
      else if (ev.kind === 'error') {
        sawResult = true
        errMsg = ev.message
      }
    }
  }
  for (const ev of parser.flush()) {
    if (ev.kind === 'text') texts.push(ev.text)
  }
  const code = await proc.exited
  if (errMsg) throw new Error(errMsg)
  if (code !== 0 && !sawResult) {
    const stderrText = await proc.stderr()
    throw new Error(`agy exited ${code}: ${stderrText.slice(0, 300)}`)
  }
  return texts.join('')
}

export function createAgyAgentProvider(opts: AgyAgentProviderOptions): AgentProvider {
  const log = opts.log
  const spawnFn = opts.spawnFn ?? defaultSpawnFn(opts.bin)
  const turnTimeoutMs = opts.turnTimeoutMs && opts.turnTimeoutMs > 0 ? opts.turnTimeoutMs : DEFAULT_TURN_TIMEOUT_MS

  return {
    async spawn(project: AgentProject, ctx: SpawnContext): Promise<AgentSession> {
      // resumeSessionId-seeded spawns already have a handle — their first
      // dispatch uses `--conversation`, never `--new-project` (RULING 1).
      let conversationId: string | null = ctx.resumeSessionId ?? null
      let firstDispatch = true
      let inFlight = false
      let closed = false
      let currentProc: AgySpawnHandle | null = null
      let currentAbort: AbortController | null = null
      // CONTROLLER RULING 3: appendInstructions rides the -p text of the
      // FIRST dispatch of this SESSION OBJECT — codex's `instructionsInjected`
      // pattern (codex-agent-provider.ts), deliberately independent of
      // `isFirst`/conversationId: a resumeSessionId-seeded spawn has no
      // "first fresh turn" (it always sends --conversation) but still needs
      // the instructions exactly once.
      const appendInstructions = ctx.appendInstructions
      let instructionsInjected = !appendInstructions

      if (ctx.resumeSessionId) {
        log('SESSION_RESUME', `alias=${project.alias} conversation_id=${ctx.resumeSessionId} provider=agy`)
      }

      return {
        dispatch(text: string): AsyncIterable<AgentEvent> {
          if (closed) {
            return { async *[Symbol.asyncIterator]() {} }
          }
          if (inFlight) {
            throw new Error(`agy provider: previous dispatch still in flight (alias=${project.alias})`)
          }
          inFlight = true

          // Hoisted into dispatch()'s own SYNCHRONOUS scope (not inside the
          // generator body below). Two things this buys:
          //  1. cancel()/close() called before the very first next() (the
          //     generator body hasn't executed yet at that point) still see
          //     a live controller instead of racing currentAbort===null and
          //     silently doing nothing.
          //  2. The returned iterator's own return()/throw() path — a bare
          //     `for await` `break`, or `it.return()` called directly,
          //     WITHOUT ever going through s.cancel() — can abort + kill
          //     BEFORE delegating to the generator's own unwind (see the
          //     wrapper below), so a hung child is actually killed instead
          //     of leaking as an orphaned process.
          //
          // `myProc` is THIS TURN's own spawn handle (set below, once the
          // generator body actually spawns it) — deliberately separate from
          // the shared `currentProc`. A stale iterator's return()/throw(),
          // called after a NEWER turn has already started, must kill only
          // ITS OWN (long-finished or still-running) child, never reach for
          // whatever `currentProc` happens to point at by then (task review
          // round 2, CRITICAL: an unguarded `currentProc?.kill()` in the
          // wrapper let a stale it1.return() kill turn 2's child and wipe
          // turn 2's inFlight/currentAbort/currentProc, breaking the
          // overlap guard and disarming cancel()).
          const abort = new AbortController()
          currentAbort = abort
          let myProc: AgySpawnHandle | null = null

          const inner = (async function* dispatchGenerator(): AsyncGenerator<AgentEvent> {
            const em = makeTurnEmitter()
            const parser = makeAgyStreamParser()
            let sawResult = false
            let initYielded = false
            try {
              // isFirst / appendInstructions-prefix consumption / arg
              // assembly deliberately live HERE, inside the generator body,
              // not in dispatch()'s synchronous scope above (task review
              // round 2, MINOR: a dispatch() that's created and then
              // return()ed/thrown WITHOUT ever being iterated must have ZERO
              // side effects on session state — codex consumes its
              // equivalent prefix inside the generator for the same reason,
              // see codex-agent-provider.ts). Only once the generator body
              // actually starts running (the caller pulled at least one
              // event) do isFirst and instructionsInjected actually flip,
              // so an abandoned dispatch leaves the NEXT real dispatch's
              // --new-project / prefix-once behavior untouched.
              const isFirst = firstDispatch
              firstDispatch = false
              const model = ctx.model ?? opts.model
              let dispatchedText = text
              if (!instructionsInjected && appendInstructions) {
                dispatchedText = `${appendInstructions}\n\n---\n\n${text}`
                instructionsInjected = true
              }
              const args = baseArgs(dispatchedText, model, turnTimeoutMs)
              // CONTROLLER RULING 1: agy's tool execution follows its
              // internal project binding, not process cwd — the FIRST
              // dispatch of a brand-new conversation must claim one via
              // --new-project, or tools silently execute in agy's own state
              // dir instead of project.path. Any dispatch that already has
              // a conversationId (continued turns, or a resumeSessionId-
              // seeded first dispatch) relies on that conversation's own
              // binding instead.
              if (conversationId) {
                args.push('--conversation', conversationId)
              } else if (isFirst) {
                args.push('--new-project')
              }
              if (ctx.permissionMode === 'dangerously') args.push('--dangerously-skip-permissions')
              const extra = opts.sessionArgsFor?.(ctx)
              if (extra?.args && extra.args.length > 0) args.push(...extra.args)
              if (extra?.env && Object.keys(extra.env).length > 0) {
                // Loud, not silent — AgySpawnFn (this task's frozen spawn-
                // seam contract) has no env slot, so a future
                // sessionArgsFor that starts returning a non-empty env
                // (tier A/B in spec §3) would otherwise be silently
                // dropped with no signal anything's wrong.
                log('AGY', 'sessionArgsFor.env ignored — spawn seam carries cwd only')
              }

              const proc = spawnFn(args, { cwd: project.path })
              myProc = proc
              currentProc = proc
              try {
                for await (const line of readLines(proc.stdout, abort.signal)) {
                  for (const ev of parser.feed(line)) {
                    if (ev.kind === 'init') {
                      conversationId = ev.conversationId
                      if (isFirst && !initYielded) {
                        initYielded = true
                        yield em.init(conversationId)
                      }
                      continue
                    }
                    if (ev.kind === 'text') {
                      yield em.text(ev.text)
                      continue
                    }
                    if (ev.kind === 'tool_call') {
                      yield em.toolCall(ev.tool, ev.server)
                      continue
                    }
                    if (ev.kind === 'result') {
                      sawResult = true
                      if (ev.conversationId) conversationId = ev.conversationId
                      yield em.finish({ sessionId: conversationId ?? '', numTurns: ev.numTurns })
                      continue
                    }
                    // ev.kind === 'error'
                    sawResult = true
                    yield em.errorText(ev.message)
                  }
                }
                if (abort.signal.aborted) return // cancelled — no further events
                for (const ev of parser.flush()) {
                  if (ev.kind === 'text') yield em.text(ev.text)
                }
                // Both tail awaits below are raced against abort.signal
                // (task review round 3) — a slow-dying child can otherwise
                // hang either one forever even after kill() fires, which
                // hangs cancel()/close()/it.return() right along with it.
                // On an abort win, treat this exactly like the cancellation
                // check above: already killed, emit nothing further.
                const codeResult = await raceAbort(proc.exited, abort.signal)
                if (codeResult === ABORTED) return
                const code = codeResult
                if (code !== 0 && !sawResult) {
                  // .catch(() => '') so a REJECTING stderr drain degrades to
                  // an empty excerpt in the error message instead of
                  // throwing out of dispatch.
                  const stderrResult = await raceAbort(proc.stderr().catch(() => ''), abort.signal)
                  if (stderrResult === ABORTED) return
                  yield em.error(new Error(`agy exited ${code}: ${stderrResult.slice(0, 300)}`))
                }
              } finally {
                currentProc = null
              }
            } finally {
              inFlight = false
              currentAbort = null
            }
          })()

          // Wrap `inner` so the ITERATOR PROTOCOL's own return()/throw() —
          // reached via a bare `for await` `break`, or a direct
          // `it.return()`/`it.throw()` call, entirely bypassing s.cancel()
          // — also aborts + kills BEFORE delegating to the generator's
          // natural unwind. Relying solely on the generator's own finally
          // blocks (as a prior version of this file did) never touches
          // abort/kill on that path: the child was left running as an
          // orphan even though the JS-level iteration itself terminated
          // cleanly.
          //
          // Both handlers kill `myProc` (THIS turn's own handle), never the
          // shared `currentProc`, and only reset the SHARED session state
          // (`currentAbort`/`currentProc`/`inFlight`) when `currentAbort`
          // still === `abort` — i.e. this iterator is still the CURRENT
          // in-flight turn, not a stale reference to one that already
          // finished (naturally or otherwise) and whose slot a newer turn
          // has since taken over. Without that identity check, a stale
          // `it1.return()` arriving after turn 2 has already started would
          // kill turn 2's child and wipe turn 2's session state out from
          // under it (task review round 2, CRITICAL regression).
          return {
            [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
              return {
                next: (): Promise<IteratorResult<AgentEvent>> => inner.next(),
                return: async (value?: AgentEvent): Promise<IteratorResult<AgentEvent>> => {
                  abort.abort()
                  myProc?.kill()
                  try {
                    return await inner.return(value)
                  } finally {
                    if (currentAbort === abort) {
                      // Defensive: covers the case where the generator body
                      // never actually started (return() called before the
                      // very first next()) — its own finally blocks never
                      // ran, so nothing else would free the session.
                      currentAbort = null
                      currentProc = null
                      inFlight = false
                    }
                  }
                },
                throw: async (e?: unknown): Promise<IteratorResult<AgentEvent>> => {
                  abort.abort()
                  myProc?.kill()
                  try {
                    return await inner.throw(e)
                  } finally {
                    if (currentAbort === abort) {
                      currentAbort = null
                      currentProc = null
                      inFlight = false
                    }
                  }
                },
              }
            },
          }
        },
        async cancel(): Promise<void> {
          currentAbort?.abort()
          currentProc?.kill()
        },
        async close(): Promise<void> {
          closed = true
          currentAbort?.abort()
          currentProc?.kill()
        },
      }
    },
    /** 真机实测(2026-09-01,gemini-3.7-flash-low,每次一个 CLI 冷启动):
     *  单次 10.3–14.3s,并发两闸门墙钟 12.66s。30s 是留了一倍余量的「慢到
     *  这个程度还算正常」,不是保证。见 AgentProvider.cheapEvalBudgetMs。 */
    cheapEvalBudgetMs: 30_000,
    async cheapEval(prompt: string): Promise<string> {
      const text = await oneShotEval(spawnFn, CHEAP_EVAL_MODEL, prompt, turnTimeoutMs)
      assertNotAuthFailed(text, log, 'agy cheapEval')
      return text
    },
    async strongEval(prompt: string): Promise<string> {
      const text = await oneShotEval(spawnFn, opts.model, prompt, turnTimeoutMs)
      assertNotAuthFailed(text, log, 'agy strongEval')
      return text
    },
  } satisfies AgentProvider & { cheapEval: CheapEval; strongEval: CheapEval }
}

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
   * frozen contract) only carries `{ cwd }`, so a future non-empty `env`
   * needs the spawn seam extended alongside whatever task actually needs it.
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

function msToPrintTimeout(ms: number): string {
  return `${Math.max(1, Math.round(ms / 1000))}s`
}

function defaultSpawnFn(bin: string): AgySpawnFn {
  return (args, opts) => {
    const proc = Bun.spawn([bin, ...args], { cwd: opts.cwd, stdout: 'pipe', stderr: 'pipe' })
    return {
      stdout: proc.stdout as unknown as AsyncIterable<Uint8Array>,
      exited: proc.exited,
      stderr: async () => new Response(proc.stderr).text(),
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
 * pending read against `signal`. This is load-bearing for cancel(): a plain
 * `for await` directly over the raw handle would, on external `.return()`,
 * cascade an `IteratorClose` down onto the raw stream's iterator while it's
 * suspended mid-`await` on a chunk that may never arrive (a genuinely wedged
 * or killed child) — per spec, `.return()` on a generator parked mid-await
 * (not mid-yield) only settles once THAT SAME promise settles, so a
 * never-resolving read would hang the caller's `cancel()`/`close()` forever.
 * Racing against an abort signal instead gives every await here a promise
 * that's guaranteed to settle once `cancel()` fires, independent of whether
 * the child ever produces another byte.
 */
async function* readLines(stream: AsyncIterable<Uint8Array | string>, signal: AbortSignal): AsyncGenerator<string> {
  const it = stream[Symbol.asyncIterator]()
  const decoder = new TextDecoder()
  let buf = ''
  const aborted: Promise<void> = signal.aborted
    ? Promise.resolve()
    : new Promise(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))

  for (;;) {
    const idx = buf.indexOf('\n')
    if (idx >= 0) {
      yield buf.slice(0, idx)
      buf = buf.slice(idx + 1)
      continue
    }
    if (signal.aborted) return
    const race = await Promise.race<LineRaceResult>([
      it.next().then(r => ({ tag: 'chunk', r })),
      aborted.then((): LineRaceResult => ({ tag: 'aborted' })),
    ])
    if (race.tag === 'aborted') return
    if (race.r.done) break
    const chunk = race.r.value
    buf += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
  }
  if (buf.length > 0) yield buf
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
          const isFirst = firstDispatch
          firstDispatch = false

          const model = ctx.model ?? opts.model
          const args = baseArgs(text, model, turnTimeoutMs)
          // CONTROLLER RULING 1: agy's tool execution follows its internal
          // project binding, not process cwd — the FIRST dispatch of a
          // brand-new conversation must claim one via --new-project, or
          // tools silently execute in agy's own state dir instead of
          // project.path. Any dispatch that already has a conversationId
          // (continued turns, or a resumeSessionId-seeded first dispatch)
          // relies on that conversation's own binding instead.
          if (conversationId) {
            args.push('--conversation', conversationId)
          } else if (isFirst) {
            args.push('--new-project')
          }
          if (ctx.permissionMode === 'dangerously') args.push('--dangerously-skip-permissions')
          const extra = opts.sessionArgsFor?.(ctx)
          if (extra?.args && extra.args.length > 0) args.push(...extra.args)

          return (async function* dispatchGenerator(): AsyncGenerator<AgentEvent> {
            const abort = new AbortController()
            currentAbort = abort
            const em = makeTurnEmitter()
            const parser = makeAgyStreamParser()
            let sawResult = false
            let initYielded = false
            try {
              const proc = spawnFn(args, { cwd: project.path })
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
                const code = await proc.exited
                if (code !== 0 && !sawResult) {
                  const stderrText = await proc.stderr()
                  yield em.error(new Error(`agy exited ${code}: ${stderrText.slice(0, 300)}`))
                }
              } finally {
                currentProc = null
              }
            } finally {
              inFlight = false
              currentAbort = null
            }
          })()
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

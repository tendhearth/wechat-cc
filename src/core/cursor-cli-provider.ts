/**
 * cursor-agent CLI provider — drives the Cursor CLI (`cursor-agent`,
 * subscription auth via `cursor-agent login`, NO CURSOR_API_KEY). This is the
 * "大部分 cursor 用户用订阅" path (owner 2026-08-25); the @cursor/sdk cloud-API
 * provider (cursor-agent-provider.ts) remains the fallback when only an API
 * key is available.
 *
 * Structure is a deliberate adaptation of agy-agent-provider.ts — the same
 * one-CLI-invocation-per-turn model with the same hardened iterator/abort
 * machinery (see that file's extensive comments for WHY each piece exists;
 * they are not repeated here). Differences:
 *   - args: `-p … --output-format stream-json --model … --trust`
 *     (`--trust` is REQUIRED for headless runs — without it cursor-agent
 *     stops at an interactive Workspace Trust prompt, live-spiked)
 *   - resume: native `--resume <sessionId>` (session_id from the stream)
 *   - no --new-project / --print-timeout equivalents (cwd IS the workspace;
 *     the daemon's own turn watchdog bounds runaway turns)
 *   - stream shape is claude-code-flavored → cursor-cli-stream.ts
 */
import { tmpdir } from 'node:os'
import { assertNotAuthFailed, type AgentEvent, type AgentProject, type AgentProvider, type AgentSession, type CheapEval, type ProviderCapabilities, type SpawnContext } from './agent-provider'
import { makeCursorStreamParser } from './cursor-cli-stream'
import { makeTurnEmitter } from './turn-emitter'
import { drainCappedStderr } from './agy-agent-provider'

export const CURSOR_CLI_CAPABILITIES: ProviderCapabilities = {
  perToolCallback: false,
  sandboxLevels: new Set(),
  supportsDelegation: false,
  supportsResume: true,
  defaultPeer: 'claude',
  authFailHint: 'cursor 登录态失效,请在电脑上跑一次 `cursor-agent login` 重新登录后再发消息。',
}

export interface CursorSpawnHandle {
  stdout: AsyncIterable<Uint8Array | string>
  exited: Promise<number>
  stderr(): Promise<string>
  kill(): void
}
export type CursorSpawnFn = (args: string[], opts: { cwd: string }) => CursorSpawnHandle

export interface CursorCliProviderOptions {
  /** cursor-agent binary path (bootstrap resolves + probes --version). */
  bin: string
  /** Default model (cursorModel config, default 'auto'); ctx.model overrides. */
  model: string
  /** Injection seam for tests (fake cursor-agent). Default: Bun.spawn wrapper. */
  spawnFn?: CursorSpawnFn
  log: (tag: string, line: string) => void
}

const STDERR_CAP_BYTES = 64 * 1024

function defaultSpawnFn(bin: string): CursorSpawnFn {
  return (args, opts) => {
    const proc = Bun.spawn([bin, ...args], { cwd: opts.cwd, stdout: 'pipe', stderr: 'pipe' })
    const stderrPromise = drainCappedStderr(proc.stderr as ReadableStream<Uint8Array>, STDERR_CAP_BYTES)
    stderrPromise.catch(() => {})
    return {
      stdout: proc.stdout as unknown as AsyncIterable<Uint8Array>,
      exited: proc.exited,
      stderr: () => stderrPromise,
      kill: () => { try { proc.kill() } catch { /* already gone */ } },
    }
  }
}

type LineRaceResult =
  | { tag: 'chunk'; r: IteratorResult<Uint8Array | string> }
  | { tag: 'aborted' }

// Same abort-race line reader as agy-agent-provider's readLines — see that
// file for the full rationale (a bare `for await` hangs cancel() forever on
// a wedged child).
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

const ABORTED: unique symbol = Symbol('cursor-abort-race')

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | typeof ABORTED> {
  if (signal.aborted) return Promise.resolve(ABORTED)
  return new Promise<T | typeof ABORTED>((resolve, reject) => {
    const onAbort = (): void => resolve(ABORTED)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value) },
      (err: unknown) => { signal.removeEventListener('abort', onAbort); reject(err) },
    )
  })
}

/** Base args shared by turn dispatch AND one-shot evals. `--trust` is the
 *  headless requirement (see file header). */
function baseArgs(prompt: string, model: string): string[] {
  return ['-p', prompt, '--output-format', 'stream-json', '--model', model, '--trust']
}

async function oneShotEval(spawnFn: CursorSpawnFn, model: string, prompt: string): Promise<string> {
  const proc = spawnFn(baseArgs(prompt, model), { cwd: tmpdir() })
  const parser = makeCursorStreamParser()
  const texts: string[] = []
  let sawResult = false
  let errMsg: string | undefined
  const neverAborted = new AbortController().signal
  for await (const line of readLines(proc.stdout, neverAborted)) {
    for (const ev of parser.feed(line)) {
      if (ev.kind === 'text') texts.push(ev.text)
      else if (ev.kind === 'result') sawResult = true
      else if (ev.kind === 'error') { sawResult = true; errMsg = ev.message }
    }
  }
  const code = await proc.exited
  if (errMsg) throw new Error(errMsg)
  if (code !== 0 && !sawResult) {
    const stderrText = await proc.stderr()
    throw new Error(`cursor-agent exited ${code}: ${stderrText.slice(0, 300)}`)
  }
  return texts.join('')
}

export function createCursorCliProvider(opts: CursorCliProviderOptions): AgentProvider {
  const log = opts.log
  const spawnFn = opts.spawnFn ?? defaultSpawnFn(opts.bin)

  return {
    async spawn(project: AgentProject, ctx: SpawnContext): Promise<AgentSession> {
      let sessionId: string | null = ctx.resumeSessionId ?? null
      let inFlight = false
      let closed = false
      let currentProc: CursorSpawnHandle | null = null
      let currentAbort: AbortController | null = null
      const appendInstructions = ctx.appendInstructions
      let instructionsInjected = !appendInstructions
      let firstDispatch = true

      if (ctx.resumeSessionId) {
        log('SESSION_RESUME', `alias=${project.alias} session_id=${ctx.resumeSessionId} provider=cursor`)
      }

      return {
        dispatch(text: string): AsyncIterable<AgentEvent> {
          if (closed) {
            return { async *[Symbol.asyncIterator]() {} }
          }
          if (inFlight) {
            throw new Error(`cursor provider: previous dispatch still in flight (alias=${project.alias})`)
          }
          inFlight = true

          const abort = new AbortController()
          currentAbort = abort
          let myProc: CursorSpawnHandle | null = null

          const inner = (async function* dispatchGenerator(): AsyncGenerator<AgentEvent> {
            const em = makeTurnEmitter()
            const parser = makeCursorStreamParser()
            let sawResult = false
            let initYielded = false
            try {
              const isFirst = firstDispatch
              firstDispatch = false
              const model = ctx.model ?? opts.model
              let dispatchedText = text
              if (!instructionsInjected && appendInstructions) {
                dispatchedText = `${appendInstructions}\n\n---\n\n${text}`
                instructionsInjected = true
              }
              const args = baseArgs(dispatchedText, model)
              if (sessionId) args.push('--resume', sessionId)
              if (ctx.permissionMode === 'dangerously') args.push('--yolo')

              const proc = spawnFn(args, { cwd: project.path })
              myProc = proc
              currentProc = proc
              try {
                for await (const line of readLines(proc.stdout, abort.signal)) {
                  for (const ev of parser.feed(line)) {
                    if (ev.kind === 'init') {
                      sessionId = ev.sessionId
                      if (isFirst && !initYielded) {
                        initYielded = true
                        yield em.init(sessionId)
                      }
                      continue
                    }
                    if (ev.kind === 'text') { yield em.text(ev.text); continue }
                    if (ev.kind === 'tool_call') { yield em.toolCall(ev.tool); continue }
                    if (ev.kind === 'result') {
                      sawResult = true
                      if (ev.sessionId) sessionId = ev.sessionId
                      yield em.finish({ sessionId: sessionId ?? '', numTurns: 1 })
                      continue
                    }
                    sawResult = true
                    yield em.errorText(ev.message)
                  }
                }
                if (abort.signal.aborted) return
                const codeResult = await raceAbort(proc.exited, abort.signal)
                if (codeResult === ABORTED) return
                const code = codeResult
                if (code !== 0 && !sawResult) {
                  const stderrResult = await raceAbort(proc.stderr().catch(() => ''), abort.signal)
                  if (stderrResult === ABORTED) return
                  yield em.error(new Error(`cursor-agent exited ${code}: ${stderrResult.slice(0, 300)}`))
                }
              } finally {
                currentProc = null
              }
            } finally {
              inFlight = false
              currentAbort = null
            }
          })()

          // Same iterator-protocol wrapper as agy (stale-iterator identity
          // check included) — see agy-agent-provider.ts for the incident
          // history behind every line.
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
                    if (currentAbort === abort) { currentAbort = null; currentProc = null; inFlight = false }
                  }
                },
                throw: async (e?: unknown): Promise<IteratorResult<AgentEvent>> => {
                  abort.abort()
                  myProc?.kill()
                  try {
                    return await inner.throw(e)
                  } finally {
                    if (currentAbort === abort) { currentAbort = null; currentProc = null; inFlight = false }
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
    async cheapEval(prompt: string): Promise<string> {
      const text = await oneShotEval(spawnFn, opts.model, prompt)
      assertNotAuthFailed(text, log, 'cursor cheapEval')
      return text
    },
    async strongEval(prompt: string): Promise<string> {
      const text = await oneShotEval(spawnFn, opts.model, prompt)
      assertNotAuthFailed(text, log, 'cursor strongEval')
      return text
    },
  } satisfies AgentProvider & { cheapEval: CheapEval; strongEval: CheapEval }
}

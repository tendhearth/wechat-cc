/**
 * Persistent embed-subprocess runner — Knowledge Kernel Task 6' (Option C
 * pivot). Embed stays Python but as a DUMB subprocess (text in, vectors
 * out) spawned ONCE per indexing run — never a plugin that calls back into
 * the daemon. See docs/superpowers/plans/2026-07-12-knowledge-kernel-
 * phase01.md's "PIVOT" section.
 *
 * Protocol: newline-delimited JSON over the child's stdin/stdout.
 *   -> stdin:  {"texts": [...]}\n     (one request line per embed() call)
 *   <- stdout: {"vectors": [[...]]}\n (one response line, one vector per
 *              input text, same order)
 * The daemon side never batches multiple embed() calls onto the pipe
 * concurrently: an async queue (`queue`, a promise chain) serializes
 * embed() calls one-at-a-time so a second caller's request line is never
 * written until the first caller has already read its full response line
 * — otherwise two requests's response lines could arrive in either order
 * and there would be no way to tell which response belongs to which
 * request.
 *
 * `model_id` is passed to the child via argv (`--model-id <id>`) at spawn
 * time — a one-time handshake via the command line rather than a stdin
 * line, so the JSONL request/response framing stays uniform (every line on
 * the wire after spawn is exactly one embed request or response).
 *
 * Robustness (folded from T6' review):
 *   - Per-request TIMEOUT (`requestTimeoutMs`, default 120s). If the child
 *     doesn't finish a response line within the window, that embed() call
 *     rejects AND the runner is marked `broken`: the child is force-killed
 *     and every subsequent embed() call rejects immediately without
 *     touching stdin/stdout again. This is deliberate, not merely
 *     conservative — a timed-out request's `readLine()` may still be
 *     pending against the (now desynchronized) stream when the next
 *     request would otherwise fire, so reusing the pipe past a timeout
 *     risks handing one call's response to a different call. The indexer
 *     (indexer.ts) already treats a rejected embed() as "abort this run,
 *     retry next tick, cursor not advanced" — killing the child here is
 *     what makes that retry actually get a fresh subprocess instead of
 *     hanging forever on the same wedged one.
 *   - Response length guard: `vectors.length` must equal the request's
 *     `texts.length`. A mismatch rejects rather than silently indexing the
 *     wrong text/vector pairing (provenance would otherwise be wrong for
 *     every row after the first short response in a batch).
 */

/** Minimal shape the runner needs from a spawned child — matches enough of
 *  Bun.spawn's Subprocess (stdin: FileSink has write/end; stdout: pipe is a
 *  ReadableStream<Uint8Array>) that the real spawn path and a test's fake
 *  child satisfy the same interface. */
export interface EmbedRunnerChild {
  stdin: { write(chunk: string | Uint8Array): void; end(): void }
  stdout: ReadableStream<Uint8Array>
  exited: Promise<number>
  kill(): void
}

/** Default per-request timeout (ms). fastembed ONNX inference on a
 *  personal-scale batch should never legitimately take this long — a delay
 *  past this signals a wedged/dead child, not a slow model. */
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000

export interface MakeEmbedRunnerOpts {
  pythonBin: string
  scriptPath: string
  model_id: string
  spawnFn?: (cmd: string[], opts: { env: Record<string, string | undefined> }) => EmbedRunnerChild
  /** Per-request timeout (ms) — see the module docstring's "Robustness"
   *  section. Default 120_000. */
  requestTimeoutMs?: number
  /**
   * Environment for the spawned child (T7' review Finding 1). Defaults to
   * `process.env` when omitted. The daemon's caller (bootstrap/index.ts)
   * MUST override `WXVAULT_STATE_DIR` here — without it, the child (a
   * fastembed model-manager under the hood, same code wxsearch/wxmedia use)
   * falls back to resolving its state dir relative to its OWN script path,
   * which is read-only inside a packaged app and re-downloads the model on
   * every single run instead of reusing the cache wxvault/wxsearch already
   * populated at `<stateDir>/plugin-data/wxvault`. This mirrors the exact
   * env the plugin registry sets for wxsearch/wxmedia's own manifests
   * (`${dataDir}/../wxvault`, see packages/wxsearch/wechat-cc.plugin.json).
   */
  env?: Record<string, string | undefined>
}

export interface EmbedRunner {
  embed(texts: string[]): Promise<number[][]>
  close(): Promise<void>
}

function defaultSpawn(cmd: string[], opts: { env: Record<string, string | undefined> }): EmbedRunnerChild {
  const proc = Bun.spawn(cmd, { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit', env: opts.env })
  return {
    // Bun's FileSink (stdin: 'pipe') exposes write()/end() — structurally
    // compatible with EmbedRunnerChild['stdin'] without a class dependency.
    stdin: proc.stdin as unknown as EmbedRunnerChild['stdin'],
    stdout: proc.stdout as ReadableStream<Uint8Array>,
    exited: proc.exited,
    kill: () => {
      proc.kill()
    },
  }
}

export function makeEmbedRunner(opts: MakeEmbedRunnerOpts): EmbedRunner {
  const spawnFn = opts.spawnFn ?? defaultSpawn
  const env = opts.env ?? process.env
  const child = spawnFn([opts.pythonBin, opts.scriptPath, '--model-id', opts.model_id], { env })
  const requestTimeoutMs = opts.requestTimeoutMs && opts.requestTimeoutMs > 0
    ? opts.requestTimeoutMs
    : DEFAULT_REQUEST_TIMEOUT_MS

  const decoder = new TextDecoder()
  const reader = child.stdout.getReader()
  let buf = ''
  let closed = false
  // Set once a request times out (or the child otherwise proves unusable
  // mid-request) — see the module docstring's "Robustness" section for why
  // the runner never attempts to reuse the pipe past this point instead of
  // just failing the one call.
  let broken = false

  /** Reads (and buffers) from stdout until a full newline-terminated line
   *  is available, then returns it (without the trailing newline). */
  async function readLine(): Promise<string> {
    for (;;) {
      const idx = buf.indexOf('\n')
      if (idx >= 0) {
        const line = buf.slice(0, idx)
        buf = buf.slice(idx + 1)
        return line
      }
      const { value, done } = await reader.read()
      if (done) {
        throw new Error('embed subprocess closed stdout before sending a response')
      }
      buf += decoder.decode(value, { stream: true })
    }
  }

  // A simple async mutex via promise chaining: each embed() call's actual
  // work is scheduled to run only after the previous call's work has
  // settled, so writes/reads on the single stdin/stdout pipe never
  // interleave. Chaining through `.catch` keeps the queue alive even if one
  // call rejects — a failed embed() must not permanently wedge the runner.
  let queue: Promise<unknown> = Promise.resolve()

  function embed(texts: string[]): Promise<number[][]> {
    const run = queue.then(async () => {
      if (closed) throw new Error('embed runner is closed')
      if (broken) throw new Error('embed runner is broken (a prior request timed out or the child died) — retry with a fresh runner')
      child.stdin.write(JSON.stringify({ texts }) + '\n')

      // Race the response against a per-request timeout. The `readPromise`
      // gets a no-op `.catch` so that if it LOSES the race (timeout fires
      // first) and later rejects on its own — e.g. "closed stdout" once the
      // killed child actually exits — that rejection doesn't surface as an
      // unhandled promise rejection; nothing else is listening to it once
      // the race has already settled via the timeout branch.
      const readPromise = readLine()
      readPromise.catch(() => {})
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          broken = true
          try {
            child.kill()
          } catch {
            // best effort — the child may already be gone
          }
          reject(new Error(`embed subprocess did not respond within ${requestTimeoutMs}ms — killed, runner marked broken`))
        }, requestTimeoutMs)
      })

      let line: string
      try {
        line = await Promise.race([readPromise, timeout])
      } finally {
        clearTimeout(timer)
      }

      const parsed = JSON.parse(line) as { vectors: number[][] }
      if (parsed.vectors.length !== texts.length) {
        throw new Error(
          `embed subprocess returned ${parsed.vectors.length} vector(s) for ${texts.length} text(s) — refusing to index a mismatched batch`,
        )
      }
      return parsed.vectors
    })
    queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  async function close(): Promise<void> {
    closed = true
    // Wait for any in-flight embed() to finish (success or failure) before
    // tearing down, so close() never truncates a response the caller is
    // still awaiting.
    await queue
    try {
      child.stdin.end()
    } catch {
      // best effort — the child may already be gone
    }
    try {
      await reader.cancel()
    } catch {
      // best effort
    }
    await child.exited
  }

  return { embed, close }
}

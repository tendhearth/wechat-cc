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

export interface MakeEmbedRunnerOpts {
  pythonBin: string
  scriptPath: string
  model_id: string
  spawnFn?: (cmd: string[]) => EmbedRunnerChild
}

export interface EmbedRunner {
  embed(texts: string[]): Promise<number[][]>
  close(): Promise<void>
}

function defaultSpawn(cmd: string[]): EmbedRunnerChild {
  const proc = Bun.spawn(cmd, { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' })
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
  const child = spawnFn([opts.pythonBin, opts.scriptPath, '--model-id', opts.model_id])

  const decoder = new TextDecoder()
  const reader = child.stdout.getReader()
  let buf = ''
  let closed = false

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
      child.stdin.write(JSON.stringify({ texts }) + '\n')
      const line = await readLine()
      const parsed = JSON.parse(line) as { vectors: number[][] }
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

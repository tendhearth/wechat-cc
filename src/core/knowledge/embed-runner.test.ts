// src/core/knowledge/embed-runner.test.ts
//
// Knowledge Kernel Task 6' — makeEmbedRunner spawns the Python embed
// subprocess ONCE (persistent) and speaks newline-delimited JSON over its
// stdin/stdout: one request line `{"texts":[...]}\n` in, one response line
// `{"vectors":[[...]]}\n` out, one request in flight at a time. This test
// injects a fake `spawnFn` (a pair of streams that echoes deterministic
// vectors) — no real Python/model involved.
import { describe, it, expect, afterEach } from 'vitest'
import { makeEmbedRunner, type EmbedRunnerChild } from './embed-runner'

/** A fake child process: `stdin.write` parses each newline-delimited
 *  request, and enqueues a matching response line onto `stdout` — with a
 *  configurable per-request-index async delay so tests can prove
 *  request/response framing survives overlapping embed() calls (no
 *  cross-talk on the pipe). `delays[i]` is the delay (ms) for the i-th
 *  request line this child receives; missing entries default to 0. */
function makeFakeChild(opts: { delays?: number[]; mismatch?: boolean } = {}): EmbedRunnerChild & { requestsSeen: string[][] } {
  const delays = opts.delays ?? []
  const enc = new TextEncoder()
  const dec = new TextDecoder()
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const stdout = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
    },
  })

  let buf = ''
  const requestsSeen: string[][] = []
  let exitedResolve!: (code: number) => void
  const exited = new Promise<number>(resolve => {
    exitedResolve = resolve
  })
  let ended = false

  function handleLine(line: string) {
    if (!line.trim()) return
    const req = JSON.parse(line) as { texts: string[] }
    const reqIndex = requestsSeen.length
    requestsSeen.push(req.texts)
    const respond = () => {
      // one fixed vector per input text, deterministic on text length —
      // `mismatch` drops the last one to simulate a subprocess bug that
      // returns fewer vectors than requested texts.
      let vectors = req.texts.map(t => [t.length, 1, 2])
      if (opts.mismatch && vectors.length > 0) vectors = vectors.slice(0, -1)
      controller.enqueue(enc.encode(JSON.stringify({ vectors }) + '\n'))
    }
    const delayMs = delays[reqIndex] ?? 0
    if (delayMs > 0) {
      setTimeout(respond, delayMs)
    } else {
      respond()
    }
  }

  return {
    stdin: {
      write(chunk: string | Uint8Array) {
        buf += typeof chunk === 'string' ? chunk : dec.decode(chunk as Uint8Array)
        let idx: number
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx)
          buf = buf.slice(idx + 1)
          handleLine(line)
        }
      },
      end() {
        ended = true
        // Mirrors a real subprocess: closing stdin causes it to exit soon
        // after (asynchronously, never synchronously with end()).
        setTimeout(() => exitedResolve(0), 0)
      },
    },
    stdout,
    exited,
    kill() {
      exitedResolve(1)
    },
    requestsSeen,
    // test-only escape hatch so `close()` can be asserted deterministically
    get _ended() {
      return ended
    },
  } as EmbedRunnerChild & { requestsSeen: string[][]; _ended: boolean }
}

/** A fake child that records requests but NEVER writes a response line —
 *  models a wedged/dead subprocess for the timeout test. `kill()` resolves
 *  `exited` (mirrors a real child actually dying once signaled) so
 *  `runner.close()` in `afterEach` doesn't hang the test suite itself. */
function makeHangingChild(): EmbedRunnerChild & { requestsSeen: string[][] } {
  const dec = new TextDecoder()
  let buf = ''
  const requestsSeen: string[][] = []
  const stdout = new ReadableStream<Uint8Array>({
    start() {
      // never enqueue anything — the "subprocess" never responds
    },
  })
  let exitedResolve!: (code: number) => void
  const exited = new Promise<number>(resolve => {
    exitedResolve = resolve
  })

  return {
    stdin: {
      write(chunk: string | Uint8Array) {
        buf += typeof chunk === 'string' ? chunk : dec.decode(chunk as Uint8Array)
        let idx: number
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx)
          buf = buf.slice(idx + 1)
          if (line.trim()) requestsSeen.push((JSON.parse(line) as { texts: string[] }).texts)
        }
      },
      end() {
        // no-op — a genuinely wedged child doesn't react to stdin closing either
      },
    },
    stdout,
    exited,
    kill() {
      exitedResolve(1)
    },
    requestsSeen,
  }
}

describe('makeEmbedRunner', () => {
  let runner: ReturnType<typeof makeEmbedRunner> | undefined

  afterEach(async () => {
    await runner?.close()
    runner = undefined
  })

  it('embeds a batch of texts via the newline-delimited JSON protocol', async () => {
    const child = makeFakeChild()
    runner = makeEmbedRunner({
      pythonBin: 'python3',
      scriptPath: '/fake/embed_subprocess.py',
      model_id: 'test-model',
      spawnFn: () => child,
    })

    const vectors = await runner.embed(['a', 'bb'])
    expect(vectors).toEqual([
      [1, 1, 2],
      [2, 1, 2],
    ])
    expect(child.requestsSeen).toEqual([['a', 'bb']])
  })

  it('frames two sequential embed calls correctly (no cross-talk)', async () => {
    const child = makeFakeChild()
    runner = makeEmbedRunner({
      pythonBin: 'python3',
      scriptPath: '/fake/embed_subprocess.py',
      model_id: 'test-model',
      spawnFn: () => child,
    })

    const first = await runner.embed(['x'])
    const second = await runner.embed(['yy', 'zzz'])

    expect(first).toEqual([[1, 1, 2]])
    expect(second).toEqual([
      [2, 1, 2],
      [3, 1, 2],
    ])
    expect(child.requestsSeen).toEqual([['x'], ['yy', 'zzz']])
  })

  it('serializes overlapping embed() calls so responses never cross-talk', async () => {
    // The FIRST request's response is deliberately delayed 30ms while the
    // SECOND (once sent) responds instantly. If the runner fired both
    // requests before reading either response, the second (faster) response
    // would arrive on stdout first and a non-serialized reader would hand it
    // to the FIRST call's awaiter by mistake — swapping the results. With
    // proper serialization, embed('aaaa') fully completes (including
    // reading its response) before embed('b')'s request is even written, so
    // results can never swap regardless of relative response speed.
    const child = makeFakeChild({ delays: [30, 0] })
    runner = makeEmbedRunner({
      pythonBin: 'python3',
      scriptPath: '/fake/embed_subprocess.py',
      model_id: 'test-model',
      spawnFn: () => child,
    })

    const p1 = runner.embed(['aaaa']) // len 4, response delayed 30ms
    const p2 = runner.embed(['b']) // len 1, fired immediately after, responds instantly

    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1).toEqual([[4, 1, 2]])
    expect(r2).toEqual([[1, 1, 2]])
    expect(child.requestsSeen).toEqual([['aaaa'], ['b']])
  })

  it('close() ends stdin and awaits process exit', async () => {
    const child = makeFakeChild()
    const r = makeEmbedRunner({
      pythonBin: 'python3',
      scriptPath: '/fake/embed_subprocess.py',
      model_id: 'test-model',
      spawnFn: () => child,
    })
    await r.close()
    expect((child as unknown as { _ended: boolean })._ended).toBe(true)
    runner = undefined
  })

  // T7' robustness folded in from the T6' review — see embed-runner.ts's
  // module docstring "Robustness" section.
  it('rejects embed() and kills the child when it does not respond within the timeout', async () => {
    const child = makeHangingChild()
    runner = makeEmbedRunner({
      pythonBin: 'python3',
      scriptPath: '/fake/embed_subprocess.py',
      model_id: 'test-model',
      spawnFn: () => child,
      requestTimeoutMs: 20,
    })

    await expect(runner.embed(['x'])).rejects.toThrow(/did not respond/i)
    // The child was killed as part of the timeout, not left running.
    expect(await child.exited).toBe(1)
  }, 5000)

  it('marks the runner broken after a timeout — subsequent embed() calls reject immediately', async () => {
    const child = makeHangingChild()
    runner = makeEmbedRunner({
      pythonBin: 'python3',
      scriptPath: '/fake/embed_subprocess.py',
      model_id: 'test-model',
      spawnFn: () => child,
      requestTimeoutMs: 20,
    })

    await expect(runner.embed(['x'])).rejects.toThrow(/did not respond/i)
    // A second call must NOT attempt to write to the (now desynchronized)
    // pipe again — it rejects synchronously with the "broken" reason.
    await expect(runner.embed(['y'])).rejects.toThrow(/broken/i)
    expect(child.requestsSeen).toEqual([['x']])
  }, 5000)

  it('rejects embed() when the subprocess returns fewer vectors than requested texts', async () => {
    const child = makeFakeChild({ mismatch: true })
    runner = makeEmbedRunner({
      pythonBin: 'python3',
      scriptPath: '/fake/embed_subprocess.py',
      model_id: 'test-model',
      spawnFn: () => child,
    })

    await expect(runner.embed(['a', 'b', 'c'])).rejects.toThrow(/vector/i)
  })
})

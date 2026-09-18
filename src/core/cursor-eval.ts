/**
 * Cursor 的一次性评估(cheapEval / strongEval)仍走 print 模式:无工具、无会话、
 * 一进程一答,比起 ACP 的 initialize/session/prompt 三步更省。对话与工作台都走
 * ACP(acp-cursor-chat.ts / acp-workbench-provider.ts)。
 *
 * 这里的机制是从退休的 print-mode 对话 provider 原样搬来的一次性评估路径 ——
 * 同一套 `-p … --output-format stream-json --model … --trust` 调用 +
 * cursor-cli-stream.ts 解析器,只是不再喂完整对话轮次。
 */
import { tmpdir } from 'node:os'
import { makeCursorStreamParser } from './cursor-cli-stream'
import { drainCappedStderr } from './agy-agent-provider'
import { spawn } from '../lib/runtime/process'

export interface CursorSpawnHandle {
  stdout: AsyncIterable<Uint8Array | string>
  exited: Promise<number>
  stderr(): Promise<string>
  kill(): void
}
export type CursorSpawnFn = (args: string[], opts: { cwd: string }) => CursorSpawnHandle

const STDERR_CAP_BYTES = 64 * 1024

export function defaultCursorSpawnFn(bin: string): CursorSpawnFn {
  return (args, opts) => {
    const proc = spawn([bin, ...args], { cwd: opts.cwd, stdout: 'pipe', stderr: 'pipe' })
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
// a wedged child). The eval path never aborts (neverAborted signal below),
// but the reader is shared shape so a future cancel-aware caller can reuse it.
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

/** Base args shared by turn dispatch AND one-shot evals. `--trust` is the
 *  headless requirement — without it cursor-agent stops at an interactive
 *  Workspace Trust prompt (live-spiked). */
/** 生产 spawn 用的参数;导出给 external-cli-contract.live.test 用同一份。 */
export function cursorBaseArgs(prompt: string, model: string): string[] {
  return ['-p', prompt, '--output-format', 'stream-json', '--model', model, '--trust']
}

export async function cursorOneShotEval(spawnFn: CursorSpawnFn, model: string, prompt: string): Promise<string> {
  const proc = spawnFn(cursorBaseArgs(prompt, model), { cwd: tmpdir() })
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

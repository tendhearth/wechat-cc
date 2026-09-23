import { describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import { cursorBaseArgs, cursorOneShotEval, defaultCursorSpawnFn, type CursorSpawnFn } from './cursor-eval'

function fakeCursor(lines: string[], opts?: { exitCode?: number; stderr?: string }) {
  const calls: Array<{ args: string[]; cwd: string }> = []
  const spawnFn: CursorSpawnFn = (args, o) => { calls.push({ args, cwd: o.cwd }); return { stdout: (async function* () { for (const l of lines) yield l + '\n' })(), exited: Promise.resolve(opts?.exitCode ?? 0), stderr: async () => opts?.stderr ?? '', kill: () => {} } }
  return { spawnFn, calls }
}
const TEXT = '{"type":"assistant","message":{"content":[{"type":"text","text":"收到"}]},"session_id":"s1"}'
const RESULT = '{"type":"result","subtype":"success","is_error":false,"result":"收到","session_id":"s1"}'

describe('cursor one-shot eval (print mode)', () => {
  it('runs -p in the temp dir with --trust and the model, and joins the assistant text', async () => {
    const f = fakeCursor([TEXT, RESULT])
    await expect(cursorOneShotEval(f.spawnFn, 'auto', 'hi')).resolves.toBe('收到')
    expect(f.calls[0]!.args).toEqual(cursorBaseArgs('hi', 'auto')); expect(f.calls[0]!.cwd).toBe(tmpdir())
    expect(cursorBaseArgs('hi', 'auto')).toEqual(['-p', 'hi', '--output-format', 'stream-json', '--model', 'auto', '--trust'])
  })
  it('surfaces a non-zero exit with stderr and a result error', async () => {
    await expect(cursorOneShotEval(fakeCursor([], { exitCode: 2, stderr: 'boom' }).spawnFn, 'auto', 'x')).rejects.toThrow('cursor-agent exited 2: boom')
    await expect(cursorOneShotEval(fakeCursor(['{"type":"result","subtype":"error","is_error":true,"result":"bad"}']).spawnFn, 'auto', 'x')).rejects.toThrow('cursor-agent result error: bad')
  })

  // injectable-default-seams.test.ts requires every `?? defaultX` boundary
  // seam to be driven by a real test, not just injected past. No `evalSpawn`
  // here on purpose (acp-cursor-chat.ts's `options.evalSpawn ?? defaultCursorSpawnFn(...)`)
  // — this exercises the module's actual `defaultCursorSpawnFn`, i.e. a real
  // subprocess spawn (`src/lib/runtime/process.ts`'s `spawn`, Bun's own
  // Subprocess API on Bun / node:child_process on Node — see that module's
  // header). `true` stands in for `cursor-agent`, resolved off PATH: it
  // exits 0 immediately with no stdout, so the parser sees no NDJSON lines
  // (no result/error) — the point isn't a realistic transcript, it's
  // proving the real spawn→read→exit wiring runs without throwing.
  // Windows has no `true` on PATH by default — gate to non-Windows, same
  // class as providers.test.ts's makeFakeAgyBin / bootstrap.test.ts's
  // cursor-agent-CLI-branch test.
  it.runIf(process.platform !== 'win32')('defaultCursorSpawnFn (no injected spawnFn): real spawn boundary runs cleanly', async () => {
    const text = await cursorOneShotEval(defaultCursorSpawnFn('true'), 'auto', 'x')
    expect(text).toBe('') // no NDJSON emitted by `true` → no text, no throw
  })
})

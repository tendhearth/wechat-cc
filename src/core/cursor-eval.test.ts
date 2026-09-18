import { describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import { cursorBaseArgs, cursorOneShotEval, type CursorSpawnFn } from './cursor-eval'

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
})

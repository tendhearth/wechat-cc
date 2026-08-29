// cursor-cli-provider tests — all via the injected spawnFn (fake cursor-agent).
import { describe, it, expect } from 'vitest'
import { tmpdir } from 'node:os'
import { CURSOR_CLI_CAPABILITIES, createCursorCliProvider } from './cursor-cli-provider'
import { TIER_PROFILES } from './user-tier'

function fakeCursor(lines: string[], opts?: { exitCode?: number; stderr?: string; hang?: boolean }) {
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

const INIT = '{"type":"system","subtype":"init","session_id":"s1","model":"Auto"}'
const TEXT = '{"type":"assistant","message":{"content":[{"type":"text","text":"收到"}]},"session_id":"s1"}'
const RESULT = '{"type":"result","subtype":"success","is_error":false,"result":"收到","session_id":"s1"}'
const AUTH_TEXT = '{"type":"assistant","message":{"content":[{"type":"text","text":"Not logged in"}]}}'

const ctx = { tierProfile: TIER_PROFILES.guest, permissionMode: 'strict' as const, chatId: 'chat1' }
// NOT '/tmp': on Linux `tmpdir()` IS '/tmp', so a '/tmp' fixture path made
// the "one-shots don't run in the project dir" assertion vacuously false —
// dev CI's ubuntu job was red on exactly this for weeks while macOS
// (/var/folders/…) stayed green. See memory: macos-only green blind spot.
const project = { alias: 'p', path: '/srv/fake-project' }

async function drain(it: AsyncIterable<{ kind: string }>) { const out = []; for await (const e of it) out.push(e); return out }

describe('createCursorCliProvider', () => {
  it('happy turn: init+text+result; second dispatch carries --resume s1; --trust always present', async () => {
    const { spawnFn, calls } = fakeCursor([INIT, TEXT, RESULT])
    const provider = createCursorCliProvider({ bin: 'cursor-agent', model: 'auto', spawnFn, log: () => {} })
    const s = await provider.spawn(project, ctx)
    const evs = await drain(s.dispatch('你好'))
    expect(evs.map(e => e.kind)).toEqual(['init', 'text', 'result'])
    expect(calls[0]!.args).toContain('--trust')
    expect(calls[0]!.args).not.toContain('--resume')
    await drain(s.dispatch('再来'))
    expect(calls[1]!.args).toContain('--resume')
    expect(calls[1]!.args).toContain('s1')
  })

  it('resumeSessionId-seeded spawn resumes on its FIRST dispatch', async () => {
    const { spawnFn, calls } = fakeCursor([INIT, TEXT, RESULT])
    const provider = createCursorCliProvider({ bin: 'cursor-agent', model: 'auto', spawnFn, log: () => {} })
    const s = await provider.spawn(project, { ...ctx, resumeSessionId: 'old-77' })
    await drain(s.dispatch('继续'))
    const i = calls[0]!.args.indexOf('--resume')
    expect(i).toBeGreaterThan(-1)
    expect(calls[0]!.args[i + 1]).toBe('old-77')
  })

  it('appendInstructions ride the FIRST -p text only', async () => {
    const { spawnFn, calls } = fakeCursor([INIT, TEXT, RESULT])
    const provider = createCursorCliProvider({ bin: 'cursor-agent', model: 'auto', spawnFn, log: () => {} })
    const s = await provider.spawn(project, { ...ctx, appendInstructions: '系统指示' })
    await drain(s.dispatch('你好'))
    expect(calls[0]!.args[1]).toContain('系统指示')
    expect(calls[0]!.args[1]).toContain('你好')
    await drain(s.dispatch('再来'))
    expect(calls[1]!.args[1]).toBe('再来')
  })

  it('dangerously mode adds --yolo; strict does not', async () => {
    const a = fakeCursor([INIT, TEXT, RESULT])
    const p1 = createCursorCliProvider({ bin: 'cursor-agent', model: 'auto', spawnFn: a.spawnFn, log: () => {} })
    const s1 = await p1.spawn(project, { ...ctx, permissionMode: 'dangerously' as const })
    await drain(s1.dispatch('x'))
    expect(a.calls[0]!.args).toContain('--yolo')
    const b = fakeCursor([INIT, TEXT, RESULT])
    const p2 = createCursorCliProvider({ bin: 'cursor-agent', model: 'auto', spawnFn: b.spawnFn, log: () => {} })
    const s2 = await p2.spawn(project, ctx)
    await drain(s2.dispatch('x'))
    expect(b.calls[0]!.args).not.toContain('--yolo')
  })

  it('nonzero exit without a result surfaces an error event with stderr excerpt', async () => {
    const { spawnFn } = fakeCursor([INIT], { exitCode: 3, stderr: 'boom' })
    const provider = createCursorCliProvider({ bin: 'cursor-agent', model: 'auto', spawnFn, log: () => {} })
    const s = await provider.spawn(project, ctx)
    const evs = await drain(s.dispatch('x')) as Array<{ kind: string; message?: string }>
    expect(evs.at(-1)!.kind).toBe('error')
    expect(String((evs.at(-1) as { error?: unknown }).error ?? evs.at(-1)!.message)).toContain('boom')
  })

  it('cancel() kills a hung child and the dispatch loop ends', async () => {
    const { spawnFn, wasKilled } = fakeCursor([INIT, TEXT], { hang: true })
    const provider = createCursorCliProvider({ bin: 'cursor-agent', model: 'auto', spawnFn, log: () => {} })
    const s = await provider.spawn(project, ctx)
    const it = s.dispatch('x')[Symbol.asyncIterator]!()
    await it.next() // init
    await it.next() // text
    const pending = it.next()
    await s.cancel!()
    const r = await pending
    expect(r.done).toBe(true)
    expect(wasKilled()).toBe(true)
  })

  it('cheapEval returns joined text; auth-shaped text throws auth_failed', async () => {
    const ok = fakeCursor([INIT, TEXT, RESULT])
    const p1 = createCursorCliProvider({ bin: 'cursor-agent', model: 'auto', spawnFn: ok.spawnFn, log: () => {} })
    await expect((p1.cheapEval!)('q')).resolves.toBe('收到')
    expect(ok.calls[0]!.cwd).toBe(tmpdir())           // one-shots run in tmpdir…
    expect(ok.calls[0]!.cwd).not.toBe(project.path)   // …never in the project dir
    const bad = fakeCursor([INIT, AUTH_TEXT, RESULT])
    const p2 = createCursorCliProvider({ bin: 'cursor-agent', model: 'auto', spawnFn: bad.spawnFn, log: () => {} })
    await expect((p2.cheapEval!)('q')).rejects.toThrow(/auth_failed/)
  })

  it('capabilities: resume on, delegation off, subscription auth hint', () => {
    expect(CURSOR_CLI_CAPABILITIES.supportsResume).toBe(true)
    expect(CURSOR_CLI_CAPABILITIES.supportsDelegation).toBe(false)
    expect(CURSOR_CLI_CAPABILITIES.authFailHint).toContain('cursor-agent login')
  })
})

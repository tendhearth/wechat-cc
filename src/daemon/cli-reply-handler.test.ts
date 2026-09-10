import { describe, it, expect, vi } from 'vitest'
import { makeCliReplyHandler, readTail, defaultRunner, RESUME_TIMEOUT_MS, type Runner } from './cli-reply-handler'
import type { CliSessionInfo } from '../core/cli-events'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sess = (over: Partial<CliSessionInfo> = {}): CliSessionInfo => ({
  session_id: 'a1b2c3-full', source: 'claude', cwd: '/w/p', transcript_path: '/t.jsonl', machine: 'here', lastSeenAt: 1, ...over,
})

function harness(opts: { sessions?: CliSessionInfo[]; run?: Runner; owner?: boolean; transcript?: string; pageUrl?: string | null } = {}) {
  const sent: string[] = []
  const sessions = opts.sessions ?? [sess()]
  const busy: string[] = []
  const h = makeCliReplyHandler({
    hub: { lookup: (p) => sessions.find(s => s.session_id.startsWith(p)) ?? null, sessions: () => sessions },
    isOwner: () => opts.owner ?? true,
    sendMessage: async (_c, t) => { sent.push(t) },
    sharePage: async () => opts.pageUrl === undefined ? 'https://x/docs/p' : opts.pageUrl,
    run: opts.run ?? (async () => ({ code: 0, stdout: '改好了', stderr: '', timedOut: false })),
    holdBusy: (l) => { busy.push(`+${l}`); return () => busy.push(`-${l}`) },
    log: () => {},
    dangerously: true,
    localMachine: 'here',
    readFile: () => opts.transcript ?? JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '最后一句' }] } }),
  })
  return { h, sent, busy }
}

const tick = () => new Promise(r => setTimeout(r, 0))

describe('cli-reply-handler', () => {
  it('不是这两种句式 / 不是主人 → false,不回话', async () => {
    const a = harness()
    expect(await a.h.handle('随便聊聊', 'c')).toBe(false)
    const b = harness({ owner: false })
    expect(await b.h.handle('看 a1b2c3', 'c')).toBe(false)
    expect(b.sent).toEqual([])
  })

  it('看 码:渲染尾巴 → share_page → 回链接;没有页面就内联', async () => {
    const a = harness()
    expect(await a.h.handle('看 a1b2', 'c')).toBe(true)
    expect(a.sent[0]).toBe('claude · 会话 a1b2c3 最近的对话:https://x/docs/p')
    const b = harness({ pageUrl: null })
    await b.h.handle('看 a1b2c3', 'c')
    expect(b.sent[0]).toContain('最后一句')
  })

  it('码不认识 → 列最近的;那边的会话 → 说明暂不支持;没记录路径 → 说明', async () => {
    const a = harness({ sessions: [sess({ session_id: 'zzzzzz', source: 'codex' })] })
    await a.h.handle('看 a1b2c3', 'c')
    expect(a.sent[0]).toContain('没见过会话码「a1b2c3」')
    expect(a.sent[0]).toContain('zzzzzz(codex)')
    const b = harness({ sessions: [sess({ machine: 'win-test' })] })
    await b.h.handle('@a1b2c3 继续', 'c')
    expect(b.sent[0]).toContain('那边(win-test)')
    expect(b.sent[0]).toContain('接不上')
    const c = harness({ sessions: [sess({ transcript_path: undefined })] })
    await c.h.handle('看 a1b2c3', 'c')
    expect(c.sent[0]).toContain('没报过记录路径')
  })

  it('@码 文本:先回「接着跑」,起 resume 进程(带 dangerously 旗),结果回来;busy 有始有终', async () => {
    const calls: { cmd: string; args: string[]; cwd: string; timeoutMs: number }[] = []
    const run: Runner = async (cmd, args, cwd, timeoutMs) => { calls.push({ cmd, args, cwd, timeoutMs }); return { code: 0, stdout: '**改好了**\n- 一', stderr: '', timedOut: false } }
    const a = harness({ run })
    expect(await a.h.handle('@a1b2c3 改成 X', 'c')).toBe(true)
    expect(a.sent[0]).toContain('接着跑')
    await tick(); await tick()
    expect(calls[0]).toEqual({ cmd: 'claude', args: ['-p', '--resume', 'a1b2c3-full', '--dangerously-skip-permissions', '改成 X'], cwd: '/w/p', timeoutMs: RESUME_TIMEOUT_MS })
    expect(a.sent[1]).toBe('🔔 claude · 会话 a1b2c3 回来了\n改好了\n· 一')
    expect(a.busy).toEqual(['+cli-resume:a1b2c3', '-cli-resume:a1b2c3'])
  })

  it('跑失败 / 超时 / 超长输出各有说法', async () => {
    const fail = harness({ run: async () => ({ code: 1, stdout: '', stderr: 'boom', timedOut: false }) })
    await fail.h.handle('@a1b2c3 x', 'c'); await tick(); await tick()
    expect(fail.sent[1]).toContain('没跑起来(exit 1):boom')
    const slow = harness({ run: async () => ({ code: null, stdout: '一半', stderr: '', timedOut: true }) })
    await slow.h.handle('@a1b2c3 x', 'c'); await tick(); await tick()
    expect(slow.sent[1]).toContain('还没完,先停了')
    expect(slow.sent[1]).toContain('一半')
    const long = harness({ run: async () => ({ code: 0, stdout: 'x'.repeat(3000), stderr: '', timedOut: false }) })
    await long.h.handle('@a1b2c3 x', 'c'); await tick(); await tick()
    expect(long.sent[1]).toContain('全文:https://x/docs/p')
  })

  it('readTail 只读文件尾巴,丢掉被截断的第一行', () => {
    const d = mkdtempSync(join(tmpdir(), 'tail-'))
    try {
      const p = join(d, 't.jsonl')
      writeFileSync(p, 'line1\nline2\nline3\n')
      expect(readTail(p, 1000)).toBe('line1\nline2\nline3\n')
      expect(readTail(p, 9)).toBe('line3\n')
    } finally { rmSync(d, { recursive: true, force: true }) }
  })
})

describe('defaultRunner(真起进程)', () => {
  it('收 stdout / exit code;到时限就掐掉并标 timedOut;命令不存在 → code null 带错误', async () => {
    const ok = await defaultRunner('sh', ['-c', 'echo hi; exit 3'], process.cwd(), 5000)
    expect(ok).toMatchObject({ code: 3, stdout: 'hi\n', timedOut: false })
    const slow = await defaultRunner('sh', ['-c', 'echo start; sleep 5'], process.cwd(), 300)
    expect(slow.timedOut).toBe(true)
    expect(slow.stdout).toContain('start')
    const missing = await defaultRunner('definitely-not-a-command-xyz', [], process.cwd(), 1000)
    expect(missing.code).toBeNull()
    expect(missing.stderr).toMatch(/ENOENT|not found/)
  })
})

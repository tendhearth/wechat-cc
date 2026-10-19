import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findLiveWindow, liveSessionIds, pickLiveWindow, relayCommand, relayMessage, relayToWindow, transcriptStartCwd, RELAY_SENDER_NAME } from './claude-live-window'

const alive = (pids: number[]) => (pid: number) => pids.includes(pid)

describe('开着的 Claude 窗口(~/.claude/sessions 登记)', () => {
  it('sessionId 对得上、进程活着、名字唯一 ⇒ 是它', () => {
    const entries = [
      { pid: 1, sessionId: 'S1', name: 'wechat-cc-fd', kind: 'interactive', status: 'busy' },
      { pid: 2, sessionId: 'S2', name: 'leni-0f', kind: 'interactive' },
    ]
    expect(pickLiveWindow(entries, 'S1', alive([1, 2]))).toEqual({ pid: 1, name: 'wechat-cc-fd', kind: 'interactive', status: 'busy' })
    expect(pickLiveWindow(entries, 'S1', alive([2]))).toBeNull()        // 窗口关了(登记还在)
    expect(pickLiveWindow(entries, 'S9', alive([1, 2]))).toBeNull()
  })
  it('重名(SendMessage 按名字投,可能送错)/ 没名字 ⇒ 不送;死掉的同名不算重名', () => {
    const dup = [{ pid: 1, sessionId: 'S1', name: 'x' }, { pid: 2, sessionId: 'S2', name: 'x' }]
    expect(pickLiveWindow(dup, 'S1', alive([1, 2]))).toBeNull()
    expect(pickLiveWindow(dup, 'S1', alive([1]))).toMatchObject({ name: 'x' })
    expect(pickLiveWindow([{ pid: 1, sessionId: 'S1', name: ' ' }], 'S1', alive([1]))).toBeNull()
    expect(pickLiveWindow([{ pid: 'nope', sessionId: 'S1', name: 'a' }], 'S1', () => true)).toBeNull()
  })
  it('读目录:只认 <pid>.json,坏文件跳过;目录不在 ⇒ null / 空', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-sessions-'))
    try {
      writeFileSync(join(dir, '11.json'), JSON.stringify({ pid: 11, sessionId: 'A', name: 'a' }))
      writeFileSync(join(dir, '12.json'), '{broken')
      writeFileSync(join(dir, '13.key'), 'secret')
      writeFileSync(join(dir, '14.json'), JSON.stringify({ pid: 14, sessionId: 'B', name: 'b' }))
      expect(findLiveWindow('A', { dir, alive: alive([11]) })).toMatchObject({ pid: 11, name: 'a' })
      expect([...liveSessionIds({ dir, alive: alive([11, 14]) })].sort()).toEqual(['A', 'B'])
      expect(findLiveWindow('A', { dir: join(dir, 'nope'), alive: () => true })).toBeNull()
      expect(liveSessionIds({ dir: join(dir, 'nope') }).size).toBe(0)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('送进窗口', () => {
  it('发信进程只有 SendMessage 一个工具;免审姿态跟 daemon 走;原话在 -- 之后', () => {
    const strict = relayCommand('wechat-cc-fd', '--help 跑一下', false).args
    expect(strict.slice(strict.indexOf('--tools'), strict.indexOf('--tools') + 2)).toEqual(['--tools', 'SendMessage'])
    expect(strict).not.toContain('bypassPermissions')
    expect(strict).toContain(RELAY_SENDER_NAME)
    expect(strict.at(-2)).toBe('--')
    expect(strict.at(-1)).toContain(JSON.stringify('wechat-cc-fd'))
    expect(strict.at(-1)).toContain(relayMessage('--help 跑一下'))
    const bypass = relayCommand('w', 'x', true).args
    expect(bypass).toContain('bypassPermissions')
    expect(bypass.slice(bypass.indexOf('--tools'), bypass.indexOf('--tools') + 2)).toEqual(['--tools', 'SendMessage'])
  })
  it('回 RELAY_SENT 才算送到;否则带上原因;超时', async () => {
    const w = { pid: 1, name: 'w', kind: 'interactive' }
    const run = (stdout: string, extra: Partial<{ code: number; timedOut: boolean; stderr: string }> = {}) =>
      async () => ({ code: 0, stdout, stderr: '', timedOut: false, ...extra })
    expect(await relayToWindow(w, 'x', { run: run('RELAY_SENT\n'), cwd: '/', dangerously: false })).toEqual({ ok: true })
    expect(await relayToWindow(w, 'x', { run: run('RELAY_FAILED no session named w'), cwd: '/', dangerously: false })).toEqual({ ok: false, error: 'RELAY_FAILED no session named w' })
    expect(await relayToWindow(w, 'x', { run: run('', { timedOut: true }), cwd: '/', dangerously: false })).toEqual({ ok: false, error: '送进窗口超时' })
    expect(await relayToWindow(w, 'x', { run: run('', { code: 1 }), cwd: '/', dangerously: false })).toEqual({ ok: false, error: 'exit 1' })
  })
})

describe('不开着时 resume 的文件夹', () => {
  it('取记录里第一个 cwd(会话起点),不是最近 hook 报的', () => {
    const head = [
      '{"type":"summary"}',
      JSON.stringify({ type: 'user', cwd: '/w/wechat-cc', message: {} }),
      JSON.stringify({ type: 'user', cwd: '/w/wechat-cc/.claude/worktrees/x', message: {} }),
    ].join('\n')
    expect(transcriptStartCwd(head)).toBe('/w/wechat-cc')
    expect(transcriptStartCwd('{"cwd": "/a"')).toBeNull()   // 截断
    expect(transcriptStartCwd('')).toBeNull()
  })
})

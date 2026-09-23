import { describe, it, expect, vi } from 'vitest'
import { notifyDesktop, escapeAppleScript, escapePowerShell } from './desktop-notify'

describe('desktop-notify', () => {
  it('macOS 走 osascript,引号与反斜杠转义', async () => {
    const exec = vi.fn(async () => {})
    expect(await notifyDesktop('wechat-cc', 'he said "hi" \\ bye', 'darwin', exec)).toBe(true)
    expect(exec).toHaveBeenCalledWith('osascript', ['-e', 'display notification "he said \\"hi\\" \\\\ bye" with title "wechat-cc"'])
  })
  it('linux notify-send;win powershell 气泡;别的平台 false;命令失败 false', async () => {
    const exec = vi.fn(async () => {})
    expect(await notifyDesktop('t', 'b', 'linux', exec)).toBe(true)
    expect(exec).toHaveBeenLastCalledWith('notify-send', ['t', 'b'])
    expect(await notifyDesktop("it's", 'b', 'win32', exec)).toBe(true)
    expect((exec.mock.lastCall as unknown[])[0]).toBe('powershell')
    expect(escapePowerShell("it's")).toBe("it''s")
    expect(escapeAppleScript('a"b')).toBe('a\\"b')
    expect(await notifyDesktop('t', 'b', 'freebsd', exec)).toBe(false)
    expect(await notifyDesktop('t', 'b', 'darwin', async () => { throw new Error('x') })).toBe(false)
  })
})

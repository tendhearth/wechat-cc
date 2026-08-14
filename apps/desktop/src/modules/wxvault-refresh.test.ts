import { afterEach, describe, expect, it, vi } from 'vitest'
import { __resetWxvaultRefreshForTests, refreshWxvaultOnAppStart } from './wxvault-refresh.js'

afterEach(() => __resetWxvaultRefreshForTests())

describe('refreshWxvaultOnAppStart', () => {
  it('re-decrypts an enabled and ready wxvault archive', async () => {
    const invoke = vi.fn(async (cmd: string) => cmd === 'wechat_cli_json'
      ? [{ name: 'wxvault', enabled: true, ready: true }]
      : 'ok')

    await expect(refreshWxvaultOnAppStart({ invoke })).resolves.toEqual({ refreshed: true })
    expect(invoke).toHaveBeenNthCalledWith(1, 'wechat_cli_json', { args: ['plugin', 'list', '--json'] })
    expect(invoke).toHaveBeenNthCalledWith(2, 'wechat_cli_text', { args: ['plugin', 'setup', 'wxvault'] })
  })

  it.each([
    [[], 'not-installed'],
    [[{ name: 'wxvault', enabled: false, ready: true }], 'disabled'],
    [[{ name: 'wxvault', enabled: true, ready: false }], 'not-ready'],
  ])('does not start first-time setup for %j', async (rows, reason) => {
    const invoke = vi.fn(async () => rows)
    await expect(refreshWxvaultOnAppStart({ invoke })).resolves.toEqual({ refreshed: false, reason })
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('coalesces duplicate startup calls', async () => {
    let release = () => {}
    const setupDone = new Promise<void>(resolve => { release = resolve })
    const invoke = vi.fn(async (cmd: string) => {
      if (cmd === 'wechat_cli_json') return [{ name: 'wxvault', enabled: true, ready: true }]
      await setupDone
      return 'ok'
    })
    const deps = { invoke }
    const first = refreshWxvaultOnAppStart(deps)
    const second = refreshWxvaultOnAppStart(deps)
    expect(second).toBe(first)
    release()
    await first
    expect(invoke).toHaveBeenCalledTimes(2)
  })
})

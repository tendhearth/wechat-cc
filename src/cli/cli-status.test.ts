import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// We test the module-level logic by mocking node:fs so no real files are needed.
vi.mock('node:fs')

import * as fs from 'node:fs'
import { runStatus } from './cli-status.ts'

function captureLog(fn: () => Promise<void>): Promise<string[]> {
  return new Promise<string[]>((resolve) => {
    const out: string[] = []
    const origLog = console.log
    console.log = (m: unknown) => { out.push(String(m ?? '')) }
    fn().finally(() => {
      console.log = origLog
      resolve(out)
    })
  })
}

describe('runStatus("status")', () => {
  beforeEach(() => vi.resetAllMocks())
  afterEach(() => vi.restoreAllMocks())

  it('prints "no daemon running" when pid file is absent', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false)
    const out = await captureLog(() => runStatus('status'))
    expect(out.some(l => l.includes('no daemon running'))).toBe(true)
  })

  it('prints "running" when pid file exists and process is alive', async () => {
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      const s = String(p)
      return s.endsWith('server.pid') || s.includes('accounts')
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
      if (String(p).endsWith('server.pid')) return String(process.pid)
      return '[]'
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(fs.readdirSync).mockReturnValue([] as any)

    // 不注入 ⇒ 走真的 defaultProviderProbes:读 internal-api-info.json(这里读出 '[]' ⇒ 没有端口)⇒ 不知道。
    const out = await captureLog(() => runStatus('status'))
    expect(out.some(l => l.includes('running') && l.includes(String(process.pid)))).toBe(true)
    expect(out.some(l => l.startsWith('providers:') && l.includes('不知道'))).toBe(true)
  })

  it('running daemon with a provider whose boot probe failed ⇒ prints "探测失败,重试中" (2026-10-04)', async () => {
    vi.mocked(fs.existsSync).mockImplementation((p) => String(p).endsWith('server.pid'))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(fs.readFileSync).mockImplementation((p: any) => String(p).endsWith('server.pid') ? String(process.pid) : '[]')
    const out = await captureLog(() => runStatus('status', {
      providerProbes: async () => [{ id: 'agy', state: 'retrying', attempts: 3, last_error: '超时 — 5012ms 内没退出', first_failed_at: '2026-10-04T03:14:38.250Z', next_attempt_at: '2026-10-04T03:14:58.000Z', registered_at: null }],
    }))
    expect(out.some(l => l.includes('agy 探测失败,重试中') && l.includes('已重探 3 次'))).toBe(true)
  })

  it('handles stale pid file gracefully (no crash)', async () => {
    vi.mocked(fs.existsSync).mockImplementation((p) => String(p).endsWith('server.pid'))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(fs.readFileSync).mockReturnValue('99999999' as any)
    const out = await captureLog(() => runStatus('status'))
    // Should print something (either "stale" or "no daemon running")
    expect(out.length).toBeGreaterThan(0)
  })
})

describe('runStatus("list")', () => {
  beforeEach(() => vi.resetAllMocks())

  it('prints "no bound accounts" when accounts dir is absent', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false)
    const out = await captureLog(() => runStatus('list'))
    expect(out.some(l => l.toLowerCase().includes('no bound accounts'))).toBe(true)
  })

  it('lists accounts when they exist', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(fs.readdirSync).mockReturnValue(['acc-abc123'] as any)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(fs.readFileSync).mockReturnValue(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      JSON.stringify({ botId: 'bot1', userId: 'user1', baseUrl: 'https://example.com' }) as any
    )

    const out = await captureLog(() => runStatus('list'))
    expect(out.some(l => l.includes('acc-abc123'))).toBe(true)
    expect(out.some(l => l.includes('bot1'))).toBe(true)
  })
})

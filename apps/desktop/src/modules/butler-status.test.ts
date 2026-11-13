// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { butlerSummary, mountButlerStatus } from './butler-status.js'
const view = (extra = {}) => ({ target: { provider: 'fake', model: 'synthetic' }, profile: null, attempt: null, suspectedChanged: false, periodicProbe: false, ...extra })
const quote = { requests: 8, maxRequests: 16, inputTokens: 12000, outputTokens: 1000, windowKnown: false, targetKey: 'synthetic-quote' }
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }

describe('local butler status', () => {
  it('keeps measurement failures separate from memory weakness', () => {
    expect(butlerSummary(view({ attempt: { status: 'failed' } })).memory).toBe('还没体检')
    expect(butlerSummary(view({ profile: { memory: 'weak', tools: 'flaky', testedAt: '2026-11-12T00:00:00Z', short: true } })).note).toBe('CC 会更常跟你确认。')
  })
  it('shows the cost before spending; starts only after a separate click and permits cancellation', async () => {
    const host = document.createElement('section')
    let status = view()
    const call = vi.fn(async (_method: string, path: string, _body?: Record<string, unknown>) => {
      if (path.endsWith('/estimate')) return quote
      if (path.endsWith('/run')) status = view({ attempt: { status: 'running' } })
      if (path.endsWith('/cancel')) status = view({ attempt: { status: 'cancelled' } })
      return status
    })
    const ui = mountButlerStatus({ host, call }); await ui.refresh()
    expect(call.mock.calls.map(c => c[1])).toEqual(['/v1/checkup'])
    host.querySelector<HTMLButtonElement>('[data-checkup="prepare"]')!.click(); await flush()
    expect(host.querySelector('[data-checkup="estimate"]')!.textContent).toContain('12000')
    expect(host.textContent).toContain('窗口未知')
    expect(call.mock.calls.some(c => c[1].endsWith('/run'))).toBe(false)
    host.querySelector<HTMLButtonElement>('[data-checkup="start"]')!.click(); await flush()
    expect(host.textContent).toContain('正在体检')
    expect(call).toHaveBeenCalledWith('POST', '/v1/checkup/run', { full: false, expectedTargetKey: 'synthetic-quote' })
    host.querySelector<HTMLButtonElement>('[data-checkup="cancel"]')!.click(); await flush()
    expect(host.textContent).toContain('已取消')
    ui.destroy()
  })
  it('periodic checks stay off until selected', async () => {
    const host = document.createElement('section'), call = vi.fn(async () => view())
    const ui = mountButlerStatus({ host, call }); await ui.refresh()
    const toggle = host.querySelector<HTMLInputElement>('[data-checkup="periodic"]')!
    expect(toggle.checked).toBe(false); expect(call).toHaveBeenCalledTimes(1)
    toggle.checked = true; toggle.dispatchEvent(new Event('change', { bubbles: true })); await flush()
    expect(call).toHaveBeenLastCalledWith('POST', '/v1/checkup/settings', { periodicProbe: true })
    ui.destroy()
  })
  it('drops the cost confirmation when the current model changes', async () => {
    const host = document.createElement('section')
    let status = view()
    const call = vi.fn(async (_method: string, path: string) => path.endsWith('/estimate') ? quote : status)
    const ui = mountButlerStatus({ host, call }); await ui.refresh()
    host.querySelector<HTMLButtonElement>('[data-checkup="prepare"]')!.click(); await flush()
    expect(host.querySelector('[data-checkup="start"]')).not.toBeNull()
    status = { ...status, target: { provider: 'fake', model: 'changed' } }
    await ui.refresh()
    expect(host.querySelector('[data-checkup="start"]')).toBeNull()
    expect(call.mock.calls.some(c => c[1].endsWith('/run'))).toBe(false)
    ui.destroy()
  })
  it('labels retained results as last known after a read failure', async () => {
    const host = document.createElement('section')
    const status = view({ profile: { memory: 'weak', tools: 'flaky', testedAt: '2026-11-12T00:00:00Z', short: true } })
    const call = vi.fn().mockResolvedValueOnce(status).mockRejectedValueOnce(new Error('offline'))
    const ui = mountButlerStatus({ host, call }); await ui.refresh(); await ui.refresh()
    expect(host.textContent).toContain('上次所知')
    expect(host.textContent).toContain('CC 会更常跟你确认。')
    expect(host.querySelector<HTMLButtonElement>('[data-checkup="prepare"]')!.disabled).toBe(true)
    ui.destroy()
  })

  it('keeps the reason for a rejected stale estimate after refreshing the current model', async () => {
    const host = document.createElement('section')
    const call = vi.fn(async (_method: string, path: string) => {
      if (path.endsWith('/estimate')) return quote
      if (path.endsWith('/run')) throw new Error('checkup_target_changed')
      return view()
    })
    const ui = mountButlerStatus({ host, call }); await ui.refresh()
    host.querySelector<HTMLButtonElement>('[data-checkup="prepare"]')!.click(); await flush()
    host.querySelector<HTMLButtonElement>('[data-checkup="start"]')!.click(); await flush(); await ui.refresh()
    expect(host.textContent).toContain('CC 用的模型或连接变了，请重新确认体检用量。')
    expect(host.querySelector('[data-checkup="start"]')).toBeNull()
    ui.destroy()
  })

})

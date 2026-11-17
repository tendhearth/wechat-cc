import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Window } from 'happy-dom'
import * as setup from './cli-setup.js'

let win: Window
const providers = (installed = false) => [{ id: 'grok', label: 'Grok · 账号连接', installed, canInstall: true, canLogin: installed, website: 'https://x.ai/build', free: true, commands: ['official install', 'dedicated home login'] }]
function deps(allowed = true, installed = false) {
  return { invoke: vi.fn(async () => ({})), invokeWorkbenchApi: vi.fn(async (_method?: string, path?: string): Promise<any> => path?.startsWith('/v1/llm/health') ? ({ ok: true, registered: ['grok'], results: [{ provider: 'grok', ok: true, source: 'login_receipt' }] }) : ({ ok: true, allowed, blockedReason: allowed ? '' : '网络保护没开,先打开 bx 再装', providers: providers(installed) })),
    invokeApi: vi.fn(async () => ({ ok: true, registered: ['grok'], results: [{ provider: 'grok', ok: true, source: 'local_login' }] })) }
}
beforeEach(() => {
  vi.useFakeTimers()
  win = new Window()
  vi.stubGlobal('document', win.document)
  win.document.body.innerHTML = '<div id="brain-health"><div id="brain-setup"></div></div>'
})
afterEach(() => { setup.closeCliSetup(); vi.useRealTimers(); vi.unstubAllGlobals(); win.close() })

it('loads names/commands from daemon and disables network actions when bx is unsafe', async () => {
  const d = deps(false)
  await setup.openCliSetup(d, 'grok')
  const box = document.getElementById('brain-setup')!
  expect(box.textContent).toContain('Grok · 账号连接')
  expect(box.textContent).toContain('免费可用')
  expect(box.textContent).toContain('额度有限')
  expect(box.textContent).toContain('网络保护没开,先打开 bx 再装')
  expect(box.querySelector<HTMLButtonElement>('[data-cli-action]')!.disabled).toBe(true)
  await setup.startCliSetup(d, 'grok', 'install')
  expect(d.invoke).not.toHaveBeenCalled()
})
it('only sends provider/action to native, then detects successful connection automatically', async () => {
  const d = deps(true, true)
  await setup.openCliSetup(d, 'grok')
  expect(document.getElementById('brain-setup')!.textContent).toContain('登录')
  await setup.startCliSetup(d, 'grok', 'login')
  expect(d.invoke).toHaveBeenCalledWith('open_cli_setup', { provider: 'grok', action: 'login' })
  await vi.advanceTimersByTimeAsync(10_000)
  expect(d.invokeApi).toHaveBeenCalledWith('GET', '/v1/llm/health?fresh=1&provider=grok', undefined, expect.anything())
  expect(document.getElementById('brain-setup')!.textContent).toContain('已接入')
  const calls = d.invokeWorkbenchApi.mock.calls.length
  await vi.advanceTimersByTimeAsync(60_000)
  expect(d.invokeWorkbenchApi.mock.calls.length).toBe(calls)
})
it('stops at timeout with recheck and does not claim success from installation alone', async () => {
  const d = deps()
  await setup.openCliSetup(d, 'grok')
  await setup.startCliSetup(d, 'grok', 'install')
  await vi.advanceTimersByTimeAsync(300_000)
  expect(document.getElementById('brain-setup')!.textContent).toContain('重新检测')
  expect(document.getElementById('brain-setup')!.textContent).not.toContain('已接入')
  const calls = d.invokeWorkbenchApi.mock.calls.length
  await vi.advanceTimersByTimeAsync(60_000)
  expect(d.invokeWorkbenchApi.mock.calls.length).toBe(calls)
})
it('closing or switching a card cancels pending polling and late responses', async () => {
  const d = deps(true, true)
  await setup.openCliSetup(d, 'grok')
  await setup.startCliSetup(d, 'grok', 'login')
  setup.closeCliSetup()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(d.invokeWorkbenchApi).toHaveBeenCalledTimes(2)
})
it('does not offer an agy installer and keeps copy commands secondary', async () => {
  const d = deps()
  d.invokeWorkbenchApi.mockResolvedValue({ ok: true, allowed: true, blockedReason: '', providers: [{ id: 'agy', label: 'Gemini · 账号连接', installed: false, canInstall: false, canLogin: false, website: 'https://antigravity.google/', free: false, commands: [] }] })
  await setup.openCliSetup(d, 'agy')
  expect(document.getElementById('brain-setup')!.textContent).toContain('打开官网')
  expect(document.querySelector('[data-cli-action]')).toBeNull()
  expect(document.getElementById('brain-setup')!.textContent).not.toContain('免费可用')
})
it('retains timeout/recheck after the normal guard tick refreshes the card', async () => {
  const d = deps()
  await setup.openCliSetup(d, 'grok')
  await setup.startCliSetup(d, 'grok', 'install')
  await vi.advanceTimersByTimeAsync(300_000)
  await setup.refreshCliSetupGuard(d)
  expect(document.getElementById('brain-setup')!.textContent).toContain('重新检测')
})
it('keeps the setup card during the normal cached health tick on a new machine', async () => {
  const dashboard = await import('./dashboard.js')
  dashboard.__resetDashboardState()
  const d = deps()
  d.invokeApi.mockResolvedValue({ ok: true, registered: [], results: [] })
  await dashboard.openBrainSetup(d, 'grok')
  await dashboard.loadBrainHealth(d, false)
  expect(document.getElementById('brain-setup')!.textContent).toContain('安装并登录')
})

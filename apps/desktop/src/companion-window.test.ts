// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

const invoke = vi.fn(async (..._args: unknown[]) => {})
const manifest = JSON.parse(readFileSync('apps/desktop/src/assets/pet/cc-v1/manifest.json', 'utf8'))

const html = readFileSync('apps/desktop/src/companion-window.html', 'utf8')
async function mount(native: boolean) {
  ;(window as any).__TAURI__ = native ? { core: { invoke } } : undefined
  document.body.innerHTML = html.slice(html.indexOf('<main'), html.indexOf('</main>') + 7)
  await import('./companion-window.js')
  return document.querySelector<HTMLButtonElement>('.pet-settings #pet-reset-position')
}
beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers(); invoke.mockReset(); localStorage.clear()
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
  // Keep the actual controller, IPC, pet and pollers; replace browser/native boundaries only.
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => manifest })))
})
afterEach(() => {
  delete (window as any).__TAURI__; document.body.replaceChildren()
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks()
})

describe('companion placement recovery control', () => {
  it('provides one settings action that targets the trusted native companion', async () => {
    const button = await mount(true)
    expect(button?.textContent).toBe('回到屏幕边缘')
    button!.click(); await Promise.resolve()
    expect(invoke).toHaveBeenCalledWith('reset_companion_position', {})
    expect(invoke).toHaveBeenCalledTimes(1)
  })
  it('browser preview explains the native requirement without pretending movement succeeded', async () => {
    const button = await mount(false)
    expect(button).not.toBeNull()
    button!.click(); await Promise.resolve()
    expect(invoke).not.toHaveBeenCalled()
    expect(document.getElementById('pet-hint')!.textContent).toContain('桌面应用')
  })
  it('keeps failed native reset visible and allows another attempt', async () => {
    invoke.mockRejectedValueOnce(new Error('monitor unavailable'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const button = await mount(true)
    expect(button).not.toBeNull()
    button!.click()
    await vi.waitFor(() => {
      expect(document.getElementById('pet-hint')!.textContent).toContain('请再试一次')
      expect(button!.disabled).toBe(false)
    })
    button!.click()
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2))
  })
})

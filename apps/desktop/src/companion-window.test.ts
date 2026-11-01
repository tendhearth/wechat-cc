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
  it('an auxiliary virtual click activates the semantic character button once', async () => {
    await mount(true)
    document.getElementById('pet-stage')!.click()
    await vi.waitFor(() => expect(invoke.mock.calls.filter(([cmd]) => cmd === 'show_main_window')).toEqual([['show_main_window', { page: 'converse' }]]))
  })
  it('a browser click after an observed mouse release does not duplicate activation, or activate after drag', async () => {
    invoke.mockImplementation(async (cmd: unknown) => cmd === 'start_companion_drag' ? { x: 1000, y: 500 } as any : undefined)
    await mount(true)
    const stage = document.getElementById('pet-stage')!
    stage.dispatchEvent(new MouseEvent('mousedown', { button: 0, buttons: 1, screenX: 100, screenY: 100 }))
    window.dispatchEvent(new MouseEvent('mouseup', { button: 0, screenX: 100, screenY: 100 }))
    stage.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))
    await vi.waitFor(() => expect(invoke.mock.calls.filter(([cmd]) => cmd === 'show_main_window')).toHaveLength(1))
    stage.dispatchEvent(new MouseEvent('mousedown', { button: 0, buttons: 1, screenX: 100, screenY: 100 }))
    window.dispatchEvent(new MouseEvent('mousemove', { buttons: 1, screenX: 120, screenY: 100 }))
    window.dispatchEvent(new MouseEvent('mouseup', { button: 0, screenX: 120, screenY: 100 }))
    stage.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))
    await vi.waitFor(() => expect(invoke.mock.calls.filter(([cmd]) => cmd === 'finish_companion_drag')).toHaveLength(1))
    expect(invoke.mock.calls.filter(([cmd]) => cmd === 'show_main_window')).toHaveLength(1)
  })

  it('coalesces a semantic key action and its accompanying virtual click while opening',async()=>{
    await mount(true)
    const stage=document.getElementById('pet-stage')!
    stage.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))
    stage.click()
    await vi.waitFor(()=>expect(invoke.mock.calls.filter(([cmd])=>cmd==='show_main_window')).toHaveLength(1))
  })
  it('a stationary character click opens the existing conversation without moving the window', async () => {
    invoke.mockImplementation(async (command: unknown) => command === 'start_companion_drag' ? { x: 1000, y: 500 } as any : undefined)
    await mount(true)
    const stage = document.getElementById('pet-stage')!
    expect(stage.getAttribute('role')).toBe('button')
    expect(stage.tabIndex).toBe(0)
    stage.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, buttons: 1, screenX: 100, screenY: 100 }))
    window.dispatchEvent(new MouseEvent('mouseup', { button: 0, buttons: 0, screenX: 100, screenY: 100 }))
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('show_main_window', { page: 'converse' }))
    expect(invoke.mock.calls.some(([command]) => command === 'move_companion_window')).toBe(false)
    expect(invoke.mock.calls.filter(([command]) => command === 'show_main_window')).toHaveLength(1)
  })
  it.each(['Enter', ' '])('the focused character activates on %s without repeat or modified-key activation', async key => {
    await mount(true)
    const stage = document.getElementById('pet-stage')!
    stage.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, repeat: true }))
    stage.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ctrlKey: true }))
    expect(invoke).not.toHaveBeenCalled()
    stage.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('show_main_window', { page: 'converse' }))
    expect(invoke.mock.calls.filter(([command]) => command === 'show_main_window')).toHaveLength(1)
  })
  it('dragging and losing focus cannot accidentally open a conversation', async () => {
    invoke.mockImplementation(async (command: unknown) => command === 'start_companion_drag' ? { x: 1000, y: 500 } as any : undefined)
    await mount(true)
    const stage = document.getElementById('pet-stage')!
    stage.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, buttons: 1, screenX: 100, screenY: 100 }))
    window.dispatchEvent(new MouseEvent('mousemove', { buttons: 1, screenX: 120, screenY: 100 }))
    window.dispatchEvent(new MouseEvent('mouseup', { button: 0, buttons: 0, screenX: 120, screenY: 100 }))
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('move_companion_window', { x: 1020, y: 500 }))
    stage.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, buttons: 1, screenX: 100, screenY: 100 }))
    window.dispatchEvent(new Event('blur'))
    window.dispatchEvent(new MouseEvent('mouseup', { button: 0, buttons: 0, screenX: 100, screenY: 100 }))
    await Promise.resolve()
    expect(invoke.mock.calls.some(([command]) => command === 'show_main_window')).toBe(false)
  })
  it('routes stage movement to native positions and commits the released endpoint', async () => {
    let position = { x: 1000, y: 500 }
    const saved: unknown[] = []
    invoke.mockImplementation(async (command: unknown, args: any) => {
      if (command === 'start_companion_drag') return { ...position } as any
      if (command === 'move_companion_window') position = { ...args }
      if (command === 'finish_companion_drag') saved.push({ ...position })
    })
    await mount(true)
    const stage = document.getElementById('pet-stage')!
    stage.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, buttons: 1, screenX: 100, screenY: 100 }))
    window.dispatchEvent(new MouseEvent('mousemove', { buttons: 1, screenX: 20, screenY: 60 }))
    window.dispatchEvent(new MouseEvent('mouseup', { button: 0, buttons: 0, screenX: 20, screenY: 60 }))
    await vi.waitFor(() => expect(position).toEqual({ x: 920, y: 460 }))
    await vi.waitFor(() => expect(saved).toEqual([{ x: 920, y: 460 }]))
    window.dispatchEvent(new MouseEvent('mousemove', { buttons: 0, screenX: 900, screenY: 900 }))
    expect(position).toEqual({ x: 920, y: 460 })
  })
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

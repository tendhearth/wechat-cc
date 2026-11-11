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
  delete (window as any).__pet; window.history.replaceState({}, '', '/')
  delete (window as any).__TAURI__; document.body.replaceChildren()
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks()
})

describe('companion placement recovery control', () => {
  it('R2: a false server approval result keeps the pet card visible for retry', async () => {
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    const item = { hash: 'approval-one', prompt: 'python3 check.py', since: '2026-11-09T00:00:00Z', expires_at: '2099-01-01T00:00:00Z' }
    const presence = { cursor: 1, presence: { presence: 'online', activity: { kind: 'idle' }, news: { unread: 0 } }, pet: { owner_last_contact_at: null, turn: { phase: 'permission', since: null }, last_done_at: null, pending_permissions: [{ ...item, prompt: '有操作需要批准' }] } }
    invoke.mockImplementation(async (cmd: unknown, args: any) => {
      if (cmd === 'wechat_cli_json') return { ok: true, baseUrl: 'http://127.0.0.1:19999', token: 'test-only' } as any
      if (cmd === 'daemon_request' && args.path.includes('permissions/pending')) return { items: [item] } as any
      if (cmd === 'pet_permission_resolve') return false as any
    })
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('subscribe')) return url.includes('since=1') ? new Promise(() => {}) : { ok: true, json: async () => presence }
      return { ok: true, json: async () => manifest }
    }))
    await mount(true); await vi.advanceTimersByTimeAsync(0)
    const allow = document.querySelector<HTMLButtonElement>('.pet-card-allow')!
    expect(allow).not.toBeNull()
    expect(document.querySelector('.pet-card-allow-task')).toBeNull()
    allow.click(); await vi.advanceTimersByTimeAsync(0)
    expect(invoke.mock.calls.filter(([cmd]) => cmd === 'pet_permission_resolve')).toHaveLength(1)
    expect(document.getElementById('pet-card')!.hidden).toBe(false)
    expect(document.querySelector('.pet-card-title')!.textContent).toContain('没送出去')
    expect(allow.disabled).toBe(false)
    window.dispatchEvent(new Event('pagehide'))
  })
  it.each(['reduced', 'quiet', 'drag'])('stops the activity reader immediately during %s and baselines on return', async mode => {
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    const presence = { cursor: 1, presence: { presence: 'online', activity: { kind: 'idle' }, news: { unread: 0 } }, pet: { owner_last_contact_at: null, turn: { phase: 'idle', since: null }, last_done_at: null, pending_permissions: [] } }
    invoke.mockImplementation(async (cmd: unknown, args: any) => {
      if (cmd === 'wechat_cli_json') return { ok: true, baseUrl: 'http://127.0.0.1:19999', token: 'test-only' } as any
      if (cmd === 'daemon_request') {
        if (args.path.includes('subscribe')) return args.path.includes('since=1') ? new Promise(() => {}) : presence as any
        return { cursor: 1, running: { turnId: 't' }, events: args.path.includes('since=0') ? [{ id: 'x', turnId: 't', kind: 'agent_message', text: 'history' }] : [] } as any
      }
      if (cmd === 'start_companion_drag') return { x: 100, y: 100 } as any
    })
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('subscribe')) {
        if (url.includes('since=1')) return new Promise(() => {}) // unchanged presence long poll
        return { ok: true, json: async () => presence }
      }
      return { ok: true, json: async () => manifest }
    }))
    await mount(true); await vi.advanceTimersByTimeAsync(2100)
    const reads = () => invoke.mock.calls.filter(([cmd, args]) => cmd === 'daemon_request' && (args as any).path.includes('/events'))
    expect(reads().length, JSON.stringify(invoke.mock.calls)).toBeGreaterThan(1)
    const stage = document.getElementById('pet-stage')!, reduced = document.getElementById('pet-reduced-motion') as HTMLInputElement
    if (mode === 'reduced') { reduced.checked = true; reduced.dispatchEvent(new Event('change')) }
    if (mode === 'quiet') document.getElementById('pet-quiet')!.click()
    if (mode === 'drag') {
      stage.dispatchEvent(new MouseEvent('mousedown', { button: 0, buttons: 1, screenX: 100, screenY: 100 }))
      window.dispatchEvent(new MouseEvent('mousemove', { buttons: 1, screenX: 120, screenY: 100 }))
    }
    const count = reads().length
    await vi.advanceTimersByTimeAsync(5000)
    expect(reads()).toHaveLength(count); expect(stage.dataset.ccPhase).toBe('idle')
    if (mode === 'reduced') { reduced.checked = false; reduced.dispatchEvent(new Event('change')) }
    if (mode === 'quiet') document.getElementById('pet-quiet')!.click()
    if (mode === 'drag') window.dispatchEvent(new MouseEvent('mouseup', { button: 0, screenX: 120, screenY: 100 }))
    await vi.advanceTimersByTimeAsync(0)
    expect(reads()).toHaveLength(count + 1)
    expect((reads().at(-1)![1] as any).path).toContain('since=0')
    expect(stage.dataset.ccPhase).toBe('thinking')
    window.dispatchEvent(new Event('pagehide'))
  })
  it.each([true,false])('keeps planted-foot artwork in place and retains native travel only for fallback (authored:%s)',async authored=>{
    const kit=structuredClone(manifest)
    if(!authored)for(const form of ['lit','unlit'])delete kit.forms[form].states['life-walk']
    vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>kit})))
    vi.spyOn(Math,'random').mockReturnValue(.999)
    invoke.mockImplementation(async(cmd:unknown)=>cmd==='companion_motion_context'?{token:1,minOffset:-48,maxOffset:48} as any:undefined)
    window.history.replaceState({},'','/?lab')
    await mount(true) // Start hidden so production pollers remain stopped.
    vi.spyOn(document,'hidden','get').mockReturnValue(false)
    const pet=(window as any).__pet
    pet.setPaused(false);pet.setForm('lit');pet.machine.notifyAnimationEnded();pet.setLifeAvailable(true)
    await vi.advanceTimersByTimeAsync(40_500)
    expect(document.getElementById('pet-body')!.dataset.petAction).toBe('walk')
    expect(document.getElementById('pet-body')!.dataset.petPerformance).toBe(String(authored))
    const movement=invoke.mock.calls.filter(([command])=>command==='companion_motion_context'||command==='step_companion_motion')
    if(authored)expect(movement).toEqual([])
    else expect(movement.some(([command])=>command==='step_companion_motion')).toBe(true)
    pet.destroy();await vi.advanceTimersByTimeAsync(0)
  })
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
    button!.click()
    await vi.waitFor(()=>expect(invoke).toHaveBeenCalledWith('reset_companion_position', {}))
    expect(invoke.mock.calls).toEqual([['stop_companion_motion',{}],['reset_companion_position',{}]])
  })
  it('browser preview explains the native requirement without pretending movement succeeded', async () => {
    const button = await mount(false)
    expect(button).not.toBeNull()
    button!.click()
    await vi.waitFor(()=>expect(document.getElementById('pet-hint')!.textContent).toContain('桌面应用'))
    expect(invoke).not.toHaveBeenCalled()
    expect(document.getElementById('pet-hint')!.textContent).toContain('桌面应用')
  })
  it('keeps failed native reset visible and allows another attempt', async () => {
    let failReset=true
    invoke.mockImplementation(async(command:unknown)=>{if(command==='reset_companion_position'&&failReset){failReset=false;throw new Error('monitor unavailable')}})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const button = await mount(true)
    expect(button).not.toBeNull()
    button!.click()
    await vi.waitFor(() => {
      expect(document.getElementById('pet-hint')!.textContent).toContain('请再试一次')
      expect(button!.disabled).toBe(false)
    })
    button!.click()
    await vi.waitFor(() => expect(invoke.mock.calls.filter(([command])=>command==='reset_companion_position')).toHaveLength(2))
    expect(invoke.mock.calls).toEqual([['stop_companion_motion',{}],['reset_companion_position',{}],['stop_companion_motion',{}],['reset_companion_position',{}]])
  })
})

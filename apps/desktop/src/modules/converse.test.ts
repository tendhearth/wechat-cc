import { beforeEach, afterEach, expect, it, vi } from 'vitest'

class El {
  dataset: Record<string, string> = {}
  value = ''; innerHTML = ''; textContent = ''; hidden = false; disabled = false
  scrollTop = 0; scrollHeight = 0
  classList = { toggle: vi.fn() }
  handlers: Record<string, Function> = {}
  setAttribute() {}
  toggleAttribute(name: string, value: boolean) { if (name === 'disabled') this.disabled = value }
  addEventListener(name: string, fn: Function) { this.handlers[name] = fn }
  focus() {}
  querySelector(selector: string) { return els[selector.slice(1)] }
}
let els: Record<string, El>
let recorder: { mimeType: string; addEventListener: Function; start: Function; stop: Function }
let stopTrack: ReturnType<typeof vi.fn>
let invoke: ReturnType<typeof vi.fn<(cmd: string, args: Record<string, unknown>) => Promise<string>>>
const settle = async () => { for (let i = 0; i < 15; i++) await Promise.resolve() }

beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers()
  els = Object.fromEntries(['root', 'scroll', 'input', 'send', 'voice-toggle', 'mic', 'cancel-recording', 'recording', 'recording-label', 'recording-time', 'recording-hint'].map(id => [`converse-${id}`, new El()]))
  vi.stubGlobal('window', {})
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {} })
  vi.stubGlobal('document', { getElementById: (id: string) => els[id] })
  vi.stubGlobal('HTMLElement', El)
  vi.stubGlobal('requestAnimationFrame', (fn: Function) => fn())
  vi.stubGlobal('FileReader', class {
    result = 'data:audio/webm;base64,YQ=='
    onloadend: Function = () => {}
    readAsDataURL() { this.onloadend() }
  })
  const handlers: Record<string, Function> = {}
  recorder = {
    mimeType: 'audio/webm',
    addEventListener: (name: string, fn: Function) => { handlers[name] = fn },
    start() {},
    stop() { handlers.dataavailable!({ data: new Blob(['audio']) }); handlers.stop!() },
  }
  stopTrack = vi.fn()
  invoke = vi.fn(async (cmd: string) => cmd === 'agent_transcribe' ? '识别的文字' : '回复')
  const { initConversePage } = await import('./converse.js')
  initConversePage({ invoke, media: { getUserMedia: async () => ({ getTracks: () => [{ stop: stopTrack }] }) as any, makeRecorder: () => recorder as any } })
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

it('uses frozen CC and labelled SVG controls in a single composer', () => {
  expect(els['converse-scroll']!.innerHTML).toContain('canonical/lit/front.png')
  expect(els['converse-root']!.innerHTML).toContain('朗读回复')
  expect(els['converse-root']!.innerHTML).toContain('<svg')
  expect(els['converse-root']!.innerHTML).not.toContain('🎤')
})

it('recording transcribes to an editable draft, preserving existing text without sending', async () => {
  els['converse-input']!.value = '原有草稿'
  els['converse-mic']!.handlers.click!()
  await settle()
  vi.advanceTimersByTime(12000)
  expect(els['converse-recording-time']!.textContent).toBe('00:12')
  expect(els['converse-input']!.hidden).toBe(true)
  els['converse-mic']!.handlers.click!()
  await settle()
  expect(stopTrack).toHaveBeenCalledOnce()
  expect(els['converse-input']!.value).toBe('原有草稿\n识别的文字')
  expect(els['converse-input']!.hidden).toBe(false)
  expect(invoke).toHaveBeenCalledWith('agent_transcribe', expect.anything())
  expect(invoke).not.toHaveBeenCalledWith('agent_converse', expect.anything())
  expect(vi.getTimerCount()).toBe(0)
})

it('cancelling discards audio, stops tracks and keeps the draft', async () => {
  els['converse-input']!.value = '保留我'
  els['converse-mic']!.handlers.click!()
  await settle()
  els['converse-cancel-recording']!.handlers.click!()
  await settle()
  expect(invoke).not.toHaveBeenCalled()
  expect(stopTrack).toHaveBeenCalledOnce()
  expect(els['converse-input']!.value).toBe('保留我')
  expect(els['converse-recording']!.hidden).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})

import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import {Window} from 'happy-dom'

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
type EntryResult = import('../../../../src/core/workbench/service').EntryResult
const accepted = {receipt:{requestId:'request',taskId:'aabbccdd',matterId:'aabbccdd',runId:'run',acceptedAt:1},task:{id:'aabbccdd'}} as EntryResult
let onDelegate: ReturnType<typeof vi.fn<(draft: {text:string;visibleMessages?:{role:'user'|'cc';text:string}[]}) => Promise<EntryResult|null>>>
const settle = async () => { for (let i = 0; i < 15; i++) await Promise.resolve() }

beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers()
  els = Object.fromEntries(['root', 'scroll', 'input', 'send', 'delegate', 'voice-toggle', 'mic', 'cancel-recording', 'recording', 'recording-label', 'recording-time', 'recording-hint'].map(id => [`converse-${id}`, new El()]))
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
  onDelegate = vi.fn(async () => accepted)
  const { initConversePage } = await import('./converse.js')
  initConversePage({ invoke, onDelegate, media: { getUserMedia: async () => ({ getTracks: () => [{ stop: stopTrack }] }) as any, makeRecorder: () => recorder as any } })
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

it('offers only visible public messages and clears its unchanged source draft after acceptance', async () => {
  els['converse-input']!.value = '私人聊天内容'
  els['converse-send']!.handlers.click!()
  await settle()
  let finish!: (result: EntryResult|null) => void
  onDelegate.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  els['converse-input']!.value = '  整理本项目的说明  '
  els['converse-delegate']!.handlers.click?.()
  await settle()
  expect(onDelegate).toHaveBeenCalledExactlyOnceWith({text:'  整理本项目的说明  ',visibleMessages:[{role:'user',text:'私人聊天内容'},{role:'cc',text:'回复'}]})
  expect(els['converse-input']!.value).toBe('  整理本项目的说明  ')
  expect(els['converse-delegate']!.disabled).toBe(true)
  els['converse-delegate']!.handlers.click?.()
  els['converse-send']!.handlers.click!()
  finish(accepted)
  await settle()
  expect(onDelegate).toHaveBeenCalledOnce()
  expect(invoke.mock.calls.filter(([cmd]) => cmd === 'agent_converse')).toHaveLength(1)
  expect(els['converse-input']!.value).toBe('')
  expect(els['converse-scroll']!.innerHTML).toContain('私人聊天内容')
})

it('renders both sides as Markdown while preserving original user source and discussion payload', async () => {
  const userText = '**原样要求**\n\n    保留缩进'
  const replyText = '## 完成\n\n**已整理**\n\n- 一项\n- 另一项\n\n```js\nconst value = 1\n```\n\n| 项目 | 状态 |\n| --- | --- |\n| 文档 | 好了 |'
  invoke.mockResolvedValue(replyText)
  els['converse-input']!.value = userText
  els['converse-send']!.handlers.click!()
  await settle()
  const html = els['converse-scroll']!.innerHTML
  const document=new Window().document;document.body.innerHTML=html
  const user=document.querySelector('.converse-msg-user')!
  expect(user.querySelector('.cc-readable-markdown strong')?.textContent).toBe('原样要求')
  const source=user.querySelector('details')!;source.open=true
  expect(source.querySelector('pre code')?.textContent).toBe(userText)
  expect(invoke).toHaveBeenCalledWith('agent_converse',{text:userText})
  expect(html).toContain('cc-readable-markdown wb-markdown')
  expect(html).toContain('<h2>完成</h2>')
  expect(html).toContain('<strong>已整理</strong>')
  expect(html).toContain('<ul>')
  expect(html).toContain('<pre><code class="language-js">const value = 1')
  expect(html).toContain('<table>')
  els['converse-input']!.value = '按这段讨论继续'
  els['converse-delegate']!.handlers.click!()
  await settle()
  expect(onDelegate).toHaveBeenCalledWith({text:'按这段讨论继续',visibleMessages:[{role:'user',text:userText},{role:'cc',text:replyText}]})
})

it('keeps unsafe assistant content inert and leaves error and system lines as plain text', async () => {
  invoke.mockResolvedValue('<script>alert(1)</script>\n\n[坏链接](javascript:alert(1))\n\n![外部图片](https://example.test/image.png)\n\n[本地文档](/Users/private/doc.md)')
  els['converse-input']!.value = '检查这段回复'
  els['converse-send']!.handlers.click!()
  await settle()
  const html = els['converse-scroll']!.innerHTML
  expect(html).toContain('&lt;script&gt;')
  expect(html).not.toContain('<script>')
  expect(html).not.toContain('href="javascript:')
  expect(html).not.toContain('https://example.test/image.png')
  expect(html).not.toContain('/Users/private/doc.md')
  invoke.mockRejectedValue(Error('**原样错误** <script>'))
  els['converse-input']!.value = '再次检查'
  els['converse-send']!.handlers.click!()
  await settle()
  expect(els['converse-scroll']!.innerHTML).toContain('<div class="converse-error-line">**原样错误** &lt;script&gt;</div>')
})

it.each(['cancel', 'failure'])('keeps the chat draft when delegation ends with %s', async result => {
  onDelegate.mockImplementation(async () => { if (result === 'failure') throw new Error('offline'); return null })
  els['converse-input']!.value = '不能丢的要求'
  els['converse-delegate']!.handlers.click?.()
  await settle()
  expect(onDelegate).toHaveBeenCalledOnce()
  expect(els['converse-input']!.value).toBe('不能丢的要求')
  expect(els['converse-input']!.disabled).toBe(false)
  expect(els['converse-delegate']!.disabled).toBe(false)
  if (result === 'failure') expect(els['converse-scroll']!.innerHTML).toContain('暂时无法交给 CC 做')
  expect(invoke).not.toHaveBeenCalled()
})

it('does not hand off an empty draft or a draft during recording or sending', async () => {
  els['converse-delegate']!.handlers.click?.()
  expect(els['converse-delegate']!.disabled).toBe(true)
  els['converse-input']!.value = '先保留'
  els['converse-input']!.handlers.input?.()
  expect(els['converse-delegate']!.disabled).toBe(false)
  els['converse-mic']!.handlers.click!()
  expect(els['converse-delegate']!.disabled).toBe(true)
  els['converse-delegate']!.handlers.click?.()
  await settle()
  els['converse-delegate']!.handlers.click?.()
  els['converse-cancel-recording']!.handlers.click!()
  await settle()
  let finish!: (text: string) => void
  invoke.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  els['converse-send']!.handlers.click!()
  expect(els['converse-delegate']!.disabled).toBe(true)
  els['converse-delegate']!.handlers.click?.()
  finish('回复')
  await settle()
  expect(onDelegate).not.toHaveBeenCalled()
})

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

it('enables delegation after voice transcription fills an initially empty draft', async () => {
  els['converse-mic']!.handlers.click!()
  await settle()
  els['converse-mic']!.handlers.click!()
  await settle()
  expect(els['converse-input']!.value).toBe('识别的文字')
  expect(els['converse-delegate']!.disabled).toBe(false)
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

it('loads the shared owner-chat stream on first open so WeChat / phone turns show on the desktop', async () => {
  vi.resetModules()
  els['converse-root'] = new El()
  const invokeWorkbenchApi = vi.fn(async () => ({ events: [
    { kind: 'user', text: '在吗', createdAt: 1 }, { kind: 'text', text: '在呢', createdAt: 2 }, { kind: 'system', text: '忽略', createdAt: 3 },
  ] }))
  const { initConversePage } = await import('./converse.js')
  initConversePage({ invoke, invokeWorkbenchApi })
  await settle()
  expect(invokeWorkbenchApi).toHaveBeenCalledWith('GET', '/v1/matter/owner-chat')
  const html = els['converse-scroll']!.innerHTML
  expect(html).toContain('在吗'); expect(html).toContain('在呢'); expect(html).not.toContain('忽略')
  expect(html.indexOf('在吗')).toBeLessThan(html.indexOf('在呢'))
})

it('keeps the empty state when the registry is unavailable', async () => {
  vi.resetModules()
  els['converse-root'] = new El()
  const { initConversePage } = await import('./converse.js')
  initConversePage({ invoke, invokeWorkbenchApi: vi.fn(async () => { throw new Error('offline') }) })
  await settle()
  expect(els['converse-scroll']!.innerHTML).toContain('canonical/lit/front.png')
})

it('keeps a newer source draft when an older preview receives its acceptance', async () => {
  let finish!: (result: EntryResult|null) => void
  onDelegate.mockImplementation(() => new Promise(resolve => {finish = resolve}))
  els['converse-input']!.value = '第一份要求'
  els['converse-delegate']!.handlers.click!(); await settle()
  els['converse-input']!.value = '再补一份要求'
  finish(accepted); await settle()
  expect(els['converse-input']!.value).toBe('再补一份要求')
})

it('excludes errors and system notices from the visible discussion candidates', async () => {
  invoke.mockRejectedValueOnce(new Error('private diagnostic'))
  els['converse-input']!.value = '已发送的公开要求'
  els['converse-send']!.handlers.click!(); await settle()
  onDelegate.mockRejectedValueOnce(new Error('offline'))
  els['converse-input']!.value = '这次交办'
  els['converse-delegate']!.handlers.click!(); await settle()
  els['converse-delegate']!.handlers.click!(); await settle()
  expect(onDelegate.mock.calls[1]?.[0]).toEqual({text:'这次交办',visibleMessages:[{role:'user',text:'已发送的公开要求'}]})
  expect(els['converse-scroll']!.innerHTML).toContain('暂时无法交给 CC 做')
})

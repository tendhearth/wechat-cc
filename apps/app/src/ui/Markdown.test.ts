// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react'
import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearDrafts } from '../state/drafts'
import { useChat } from '../state/useChat'
import { palette } from './tokens'
import { Markdown, MessageText } from './Markdown'

const render = createRequire(import.meta.url)('react-dom/server').renderToStaticMarkup as (node: ReturnType<typeof createElement>) => string
type Root = { render(node: ReactNode): void; unmount(): void }
const createRoot = createRequire(import.meta.url)('react-dom/client').createRoot as (container: Element) => Root
const roots: Root[] = []
const native = vi.hoisted(() => ({ lang: 'zh-Hans' as 'zh-Hans' | 'en', presses: [] as (() => void)[], textStyles: [] as Record<string, unknown>[], texts: [] as { value: unknown; selectable: boolean; id?: string }[], scrolls: [] as Record<string, unknown>[], formatChecks: [] as string[], openURL: vi.fn(async () => {}) }))
const upstream = vi.hoisted(() => ({ page: undefined as any, refresh: vi.fn(async () => {}), chatSay: vi.fn(async (text: string, requestId: string) => ({ text, requestId, status: 'replied', since: 1 })) }))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

// 保留真实 Txt / 字体选取 / Markdown 组件,仅把原生宿主控件换成可在 node 读取的树。
vi.mock('react-native', async () => {
  const { createElement } = await import('react')
  const flatten = (style: unknown): Record<string, unknown> => Object.assign({}, ...(Array.isArray(style) ? style : [style]))
  const View = ({ children }: any) => createElement('div', null, children)
  const Text = ({ children, onPress, style, accessibilityRole, testID, selectable }: any) => {
    native.textStyles.push(flatten(style))
    native.texts.push({ value: children, selectable, id: testID })
    if (onPress) native.presses.push(onPress)
    return createElement('span', { 'data-role': accessibilityRole, 'data-testid': testID, onClick: onPress }, children)
  }
  const Pressable = ({ children, onPress, testID, accessibilityRole, accessibilityLabel, accessibilityState }: any) =>
    createElement('button', { onClick: onPress, role: accessibilityRole, 'data-testid': testID, 'aria-label': accessibilityLabel, 'aria-expanded': accessibilityState?.expanded }, children)
  const ScrollView = ({ children, horizontal, nestedScrollEnabled, style }: any) => {
    native.scrolls.push({ horizontal, nestedScrollEnabled, style: flatten(style) })
    return createElement('div', { 'data-horizontal': horizontal ? 'yes' : undefined }, children)
  }
  return { Text, View, Pressable, ScrollView, Linking: { openURL: native.openURL }, Platform: { select: (options: any) => options.ios ?? options.default } }
})
vi.mock('../i18n/useLang', () => ({ useLang: () => native.lang }))
vi.mock('@wechat-cc/markdown', async importOriginal => {
  const actual = await importOriginal<typeof import('@wechat-cc/markdown')>()
  return { ...actual, hasMarkdownFormatting: (text: string) => { native.formatChecks.push(text); return actual.hasMarkdownFormatting(text) } }
})
vi.mock('../state/BackendProvider', () => ({ useBackendCtx: () => ({ backend: { chatSay: upstream.chatSay } }) }))
vi.mock('../state/hooks', () => ({
  useQuery: () => ({ data: upstream.page, refresh: upstream.refresh }),
  useTopic: () => undefined,
  useSubmit: () => async (_key: string, run: () => Promise<void>) => { await run(); return 'ok' },
}))

beforeEach(() => {
  native.lang = 'zh-Hans'
  native.presses.length = 0; native.textStyles.length = 0; native.texts.length = 0; native.scrolls.length = 0; native.formatChecks.length = 0
  native.openURL.mockClear()
  upstream.chatSay.mockClear(); upstream.page = undefined
  clearDrafts()
})
afterEach(async () => {
  await act(() => { for (const root of roots.splice(0)) root.unmount() })
  document.body.innerHTML = ''
})
async function mount(node: ReactNode) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container); roots.push(root)
  await act(() => root.render(node))
  return { container, root }
}

describe('native Markdown reader', () => {
  it('renders the screenshot-style reply with readable emphasis, headings, lists and link labels', () => {
    const html = render(createElement(Markdown, { text: '## 已有会话\n\n**可以继续。** 查看 [现有功能说明](/Users/owner/docs/cc-workbench.md:13)。\n\n1. 选择会话\n2. 加入任务列表\n\n> 原程序关闭后接着做' }))
    expect(html).toContain('已有会话')
    expect(html).toContain('可以继续。')
    expect(html).toContain('现有功能说明')
    expect(html).toContain('1.')
    expect(html).toContain('2.')
    expect(html).not.toMatch(/\*\*|##|\/Users\/owner|\[现有功能说明\]/)
    expect(native.textStyles).toContainEqual(expect.objectContaining({ fontSize: 20, fontFamily: 'NotoSerifSC-Regular' }))
    expect(native.textStyles).toContainEqual(expect.objectContaining({ color: palette.ink, backgroundColor: palette.hair }))
    expect(native.textStyles.every(s => s.fontFamily !== undefined)).toBe(true)
    expect(native.presses).toHaveLength(0)
  })

  it('opens only approved absolute HTTP/S links, never local files or app/script links', () => {
    const html = render(createElement(Markdown, { text: '[官网](https://example.com/docs) [HTTP](http://example.org/) [本地](/Users/owner/a.md) [应用](codex://task/1) [脚本](javascript:evil) [协议相对](//evil.example) [相对](./a.md)' }))
    expect(html.match(/data-role="link"/g)).toHaveLength(2)
    expect(native.presses).toHaveLength(2)
    for (const press of native.presses) press()
    expect(native.openURL.mock.calls).toEqual([['https://example.com/docs'], ['http://example.org/']])
    expect(html).toContain('本地')
    expect(html).toContain('应用')
    expect(html).not.toMatch(/\/Users\/owner|codex:\/\/|javascript:evil|evil.example|\.\/a.md/)
  })

  it('keeps raw HTML inert and images as alt text, with no remote fetch or native action', () => {
    const html = render(createElement(Markdown, { text: '<script>alert("x")</script>\n\n![示意图](https://example.com/track.png)\n\n<img src="https://example.com/other.png" onerror="evil()">' }))
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('示意图')
    expect(html).not.toContain('<img')
    expect(native.presses).toHaveLength(0)
    expect(native.openURL).not.toHaveBeenCalled()
  })

  it('renders formatted user input with the same safe reading format as assistant messages', () => {
    const text = '**这是原文** [资料](/Users/owner/a.md)\n<script>never()</script>'
    const html = render(createElement(MessageText, { role: 'user', text }))
    expect(html).toContain('这是原文')
    expect(html).toContain('资料')
    expect(html).not.toMatch(/\*\*|\/Users\/owner\/a.md/)
    expect(html).toContain('&lt;script&gt;never()&lt;/script&gt;')
    expect(html).toContain('查看原文')
    expect(html).not.toContain('message-source-text')
    expect(native.textStyles).toContainEqual(expect.objectContaining({ color: palette.ink, backgroundColor: palette.hair }))
    expect(native.presses).toHaveLength(0)
    expect(native.scrolls).toHaveLength(0)
  })

  it('opens and closes the exact selectable original, preserving leading lines, CRLF and literal syntax', async () => {
    const text = '\r\n\r\n**重点**\r\n[原位置](/Users/owner/a.md)\r\n  literal &amp;\r\n\r\n- 第一项\r\n- 第二项\r\n'
    const { container, root } = await mount(createElement(MessageText, { role: 'user', text, userAlign: 'right' }))
    const toggle = container.querySelector<HTMLButtonElement>('[data-testid="message-source-toggle"]')!
    expect(toggle.getAttribute('role')).toBe('button')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(container.textContent).toContain('重点')
    expect(container.textContent).not.toContain('**重点**')
    expect(container.textContent!.match(/•/g)).toHaveLength(2)
    expect(native.textStyles.some(s => s.textAlign === 'right')).toBe(false)
    await act(() => toggle.click())
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(toggle.getAttribute('aria-label')).toBe('收起原文')
    expect(container.querySelector('[data-testid="message-source-text"]')!.textContent).toBe(text)
    expect(native.texts).toContainEqual({ value: text, selectable: true, id: 'message-source-text' })
    await act(() => toggle.click())
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('[data-testid="message-source-text"]')).toBeNull()
    await act(() => root.render(createElement(MessageText, { role: 'user', text, userAlign: 'right' })))
    expect(native.formatChecks).toEqual([text])
  })

  it('leaves ordinary user text literal with no source button, and detects formatting only when text changes', async () => {
    const text = '\r\n普通文字\r\n保留换行  '
    const { container, root } = await mount(createElement(MessageText, { role: 'user', text }))
    expect(container.textContent).toBe(text)
    expect(container.querySelector('button')).toBeNull()
    await act(() => root.render(createElement(MessageText, { role: 'user', text })))
    expect(native.formatChecks).toEqual([text])
    const changed = '**新的重点**'
    await act(() => root.render(createElement(MessageText, { role: 'user', text: changed })))
    expect(native.formatChecks).toEqual([text, changed])
    expect(container.querySelector('button')!.getAttribute('aria-expanded')).toBe('false')
  })

  it('provides English source controls and accessible user links, closing an old source when the message changes', async () => {
    native.lang = 'en'
    const { container, root } = await mount(createElement(MessageText, { role: 'user', text: '**Read** [docs](https://example.com/docs)' }))
    const toggle = container.querySelector<HTMLButtonElement>('button')!
    expect(toggle.getAttribute('aria-label')).toBe('View original')
    await act(() => container.querySelector<HTMLElement>('[data-role="link"]')!.click())
    expect(native.openURL).toHaveBeenCalledWith('https://example.com/docs')
    await act(() => toggle.click())
    expect(toggle.getAttribute('aria-label')).toBe('Hide original')
    await act(() => root.render(createElement(MessageText, { role: 'user', text: '**Different**' })))
    expect(container.querySelector('[data-testid="message-source-text"]')).toBeNull()
    expect(container.querySelector('button')!.getAttribute('aria-expanded')).toBe('false')
  })

  it('copies the stored original and keeps retry/send upstream payloads unchanged by reading format', async () => {
    const text = '\r\n**重点**\r\n[材料](/Users/owner/source.md)\r\n'
    const record = Object.freeze({ id: 'message-1', role: 'me', kind: 'text', text, at: 1, source: 'phone', truncated: false })
    upstream.page = Object.freeze({ matterId: 'c', title: 'CC', messages: Object.freeze([record]), pending: null, failed: null, hasMore: false, nextBefore: null })
    let chat!: ReturnType<typeof useChat>
    function Flow() {
      chat = useChat()
      return createElement(MessageText, { role: 'user', text: chat.bubbles[0]!.text })
    }
    const { container } = await mount(createElement(Flow))
    await act(() => container.querySelector<HTMLButtonElement>('button')!.click())
    const copyable = container.querySelector('[data-testid="message-source-text"]')!.textContent
    expect(copyable).toBe(record.text)
    await act(async () => { expect(await chat.retry('original-retry', record.text)).toBe('ok') })
    expect(upstream.chatSay).toHaveBeenLastCalledWith(record.text, 'original-retry')
    await act(async () => { expect(await chat.send(record.text)).toBe('ok') })
    expect(upstream.chatSay).toHaveBeenLastCalledWith(record.text.trim(), expect.any(String))
    expect(record.text).toBe(text)
    expect(upstream.page.messages[0]).toBe(record)
  })

  it('decodes prose entities but keeps code literal and scrolls long code and tables locally', () => {
    const html = render(createElement(MessageText, { role: 'assistant', text: '正文 &amp; &#x4e2d;，`a &amp; b`\n\n```ts\nconst x = "&amp;"; ' + 'long_'.repeat(70) + '\n```\n\n|执行者|状态|\n|---|---|\n|Claude|可继续|\n|Codex|正在运行|\n' }))
    expect(html).toContain('正文 &amp; 中')
    expect(html).toContain('a &amp;amp; b')
    expect(html).toContain('&quot;&amp;amp;&quot;')
    expect(html).toContain('执行者')
    expect(html).toContain('Claude')
    expect(html).not.toContain('```')
    expect(native.scrolls).toHaveLength(2)
    expect(native.scrolls.every(s => s.horizontal === true && (s.style as any).maxWidth === '100%')).toBe(true)
    expect(native.scrolls[0]!.nestedScrollEnabled).toBe(true)
    expect(native.textStyles).toContainEqual(expect.objectContaining({ fontFamily: 'Menlo' }))
  })

  it('keeps task-list state and nested list indentation readable', () => {
    const html = render(createElement(Markdown, { text: '- [x] 已完成\n- [ ] 等确认\n  - 子步骤\n' }))
    expect(html.match(/☑/g)).toHaveLength(1)
    expect(html.match(/☐/g)).toHaveLength(1)
    expect(html).toContain('已完成')
    expect(html).toContain('等确认')
    expect(html).toContain('子步骤')
    expect(html).not.toMatch(/\[x\]|\[ \]/)
  })

  it('renders loose task-list state once when its checkbox token sits inside a paragraph', () => {
    const html = render(createElement(Markdown, { text: '- [x] **done**\n\n  extra\n\n- [ ] pending' }))
    expect(html.match(/☑/g)).toHaveLength(1)
    expect(html.match(/☐/g)).toHaveLength(1)
    expect(html).toContain('done')
    expect(html).toContain('extra')
    expect(html).toContain('pending')
    expect(html).not.toMatch(/\[x\]|\[ \]|\*\*done\*\*/)
    expect(native.textStyles).toContainEqual(expect.objectContaining({ color: palette.ink, backgroundColor: palette.hair }))
  })
})

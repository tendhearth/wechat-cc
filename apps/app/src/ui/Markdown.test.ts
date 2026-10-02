import { createElement } from 'react'
import { createRequire } from 'node:module'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { palette } from './tokens'
import { Markdown, MessageText } from './Markdown'

const render = createRequire(import.meta.url)('react-dom/server').renderToStaticMarkup as (node: ReturnType<typeof createElement>) => string
const native = vi.hoisted(() => ({ presses: [] as (() => void)[], textStyles: [] as Record<string, unknown>[], scrolls: [] as Record<string, unknown>[], openURL: vi.fn(async () => {}) }))

// 保留真实 Txt / 字体选取 / Markdown 组件,仅把原生宿主控件换成可在 node 读取的树。
vi.mock('react-native', async () => {
  const { createElement } = await import('react')
  const flatten = (style: unknown): Record<string, unknown> => Object.assign({}, ...(Array.isArray(style) ? style : [style]))
  const View = ({ children }: any) => createElement('div', null, children)
  const Text = ({ children, onPress, style, accessibilityRole }: any) => {
    native.textStyles.push(flatten(style))
    if (onPress) native.presses.push(onPress)
    return createElement('span', { 'data-role': accessibilityRole }, children)
  }
  const ScrollView = ({ children, horizontal, nestedScrollEnabled, style }: any) => {
    native.scrolls.push({ horizontal, nestedScrollEnabled, style: flatten(style) })
    return createElement('div', { 'data-horizontal': horizontal ? 'yes' : undefined }, children)
  }
  return { Text, View, ScrollView, Linking: { openURL: native.openURL }, Platform: { select: (options: any) => options.ios ?? options.default } }
})
vi.mock('../i18n/useLang', () => ({ useLang: () => 'zh-Hans' }))

beforeEach(() => {
  native.presses.length = 0; native.textStyles.length = 0; native.scrolls.length = 0
  native.openURL.mockClear()
})

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
    expect(native.textStyles).toContainEqual(expect.objectContaining({ color: palette.accent, backgroundColor: palette.rail }))
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

  it('preserves user input literally, including Markdown, file paths and HTML', () => {
    const text = '**这是原文** [资料](/Users/owner/a.md)\n<script>never()</script>'
    const html = render(createElement(MessageText, { role: 'user', text }))
    expect(html).toContain('**这是原文** [资料](/Users/owner/a.md)')
    expect(html).toContain('&lt;script&gt;never()&lt;/script&gt;')
    expect(native.presses).toHaveLength(0)
    expect(native.scrolls).toHaveLength(0)
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
    expect(native.textStyles).toContainEqual(expect.objectContaining({ color: palette.accent, backgroundColor: palette.rail }))
  })
})

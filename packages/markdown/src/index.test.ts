import { describe, expect, it } from 'vitest'
import { decodeMarkdownEntities, hasMarkdownFormatting, markdownPlainText, parseMarkdown, renderMarkdown, safeMarkdownUrl } from './index'

describe('transcript Markdown across reading surfaces', () => {
  it('offers source inspection for formatted messages and leaves plain messages uncluttered', () => {
    for (const source of ['**用户原文**', '# 标题', '- 一项', '`a * b`', '[资料](/Users/owner/a.md)', '  **嵌套重点**', '\\*字面星号']) expect(hasMarkdownFormatting(source)).toBe(true)
    for (const source of ['', '你好', '第一行\n\n  原始缩进', '计算 a * b', '<script>literal()</script>']) expect(hasMarkdownFormatting(source)).toBe(false)
  })

  it('renders prose, lists, tables and literal code without changing source text', () => {
    const source = '**可以继续**\n\n- 第一项\n- 第二项\n\n```ts\n  const value = "**literal**"\n```\n\n| 名称 | 结果 |\n| --- | --- |\n| 原会话 | 已保留 |'
    const html = renderMarkdown(source)
    expect(html).toContain('<strong>可以继续</strong>')
    expect(html).toContain('<ul>')
    expect(html).toContain('<table>')
    expect(html).toContain('  const value = &quot;**literal**&quot;')
    expect(parseMarkdown(source).map(token => token.type)).toEqual(['paragraph', 'space', 'list', 'space', 'code', 'space', 'table'])
    expect(source).toContain('**可以继续**')
  })

  it('escapes HTML, does not load images, and permits only absolute web links', () => {
    const html = renderMarkdown('<script>alert(1)</script>\n\n![图片](https://example.com/tracker.png)\n\n[本地说明](/Users/example/docs.md:13) [应用](codex://threads/1) [代码](javascript:alert%281%29) [网页](https://example.com/guide?q=1&x=2)')
    expect(html).not.toMatch(/<(?:script|img)\b/)
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('/Users/example/')
    expect(html).not.toMatch(/href="(?:codex|javascript|file|data):/)
    expect(html).toContain('href="https://example.com/guide?q=1&amp;x=2"')
    expect(html).toContain('rel="noopener noreferrer"')
    expect(html).toContain('本地说明')
  })

  it.each(['/relative', '//example.com', 'file:///tmp/a', 'data:text/html,hello', 'mailto:a@example.com', 'javascript:alert(1)', 'codex://threads/1', 'http:example.com', 'https://exa\nmple.com', 'https://example.com\\path'])('does not activate %s', href => {
    expect(safeMarkdownUrl(href)).toBeNull()
  })

  it('extracts readable summaries, including reference links, without stripping code punctuation', () => {
    expect(markdownPlainText('## **可以**\n\n[现有功能][docs]\n\n- `**literal**`\n- 完成 &amp; 保留\n\n[docs]: /Users/example/docs.md')).toBe('可以\n\n现有功能\n\n**literal**\n完成 & 保留')
    expect(markdownPlainText('![示意图](https://example.com/image.png)')).toBe('示意图')
    expect(markdownPlainText('')).toBe('')
  })

  it('decodes valid prose entities and leaves invalid Unicode references intact', () => {
    expect(decodeMarkdownEntities('&amp; &#x4e2d; &#65; &quot;')).toBe('& 中 A "')
    expect(decodeMarkdownEntities('&#0; &#xD800; &#x110000;')).toBe('&#0; &#xD800; &#x110000;')
  })
})

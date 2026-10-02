import { Marked, type RendererObject, type Token, type Tokens } from 'marked'

export type { Token, Tokens } from 'marked'

export function escapeMarkdownHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

/** A transcript is untrusted. File paths and app links remain readable labels. */
export function safeMarkdownUrl(href: string): string | null {
  if (!/^https?:\/\//i.test(href) || /[\u0000-\u0020\u007f\\]/.test(href)) return null
  try {
    const url = new URL(href)
    const protocol = url.protocol.toLowerCase()
    return url.hostname && (protocol === 'http:' || protocol === 'https:') ? url.href : null
  } catch { return null }
}

const renderer: RendererObject = {
  html({ text }) { return escapeMarkdownHtml(text) },
  link({ href, title, tokens }) {
    const label = this.parser.parseInline(tokens)
    const url = safeMarkdownUrl(href)
    if (!url) return label
    return `<a href="${escapeMarkdownHtml(url)}"${title ? ` title="${escapeMarkdownHtml(title)}"` : ''} target="_blank" rel="noopener noreferrer">${label}</a>`
  },
  image({ text }) { return `<span class="wb-markdown-image">${escapeMarkdownHtml(text || '图片')}</span>` },
}

const markdown = new Marked({ gfm: true, breaks: true, renderer })

export function renderMarkdown(value: string): string {
  return markdown.parse(String(value ?? ''), { async: false })
}

/** Native clients render these tokens with native views, never a WebView. */
export function parseMarkdown(value: string): Token[] {
  return markdown.lexer(String(value ?? ''))
}

/** Decode prose entities; code remains literal. No DOM or platform APIs. */
export function decodeMarkdownEntities(value: string): string {
  return value.replace(/&(#(?:x[0-9a-f]+|\d+)|amp|lt|gt|quot|apos|nbsp);/gi, (match, name: string) => {
    if (name[0] !== '#') return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' } as Record<string, string>)[name.toLowerCase()] ?? match
    const hex = name[1]?.toLowerCase() === 'x'
    const code = Number.parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10)
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : match
  })
}

function readableTokens(tokens: Token[]): string {
  return tokens.map(token => {
    const prose = token as { tokens?: Token[]; text?: string; raw: string }
    switch (token.type) {
      case 'space': case 'br': return '\n'
      case 'def': case 'hr': return ''
      case 'code': return String(token.text) + '\n\n'
      case 'codespan': return String(token.text)
      case 'list': return token.items.map((item: Tokens.ListItem) => readableTokens(item.tokens).trim()).join('\n') + '\n\n'
      case 'table': return [token.header, ...token.rows].map((row: { tokens: Token[] }[]) => row.map(cell => readableTokens(cell.tokens)).join('\t')).join('\n') + '\n\n'
      case 'paragraph': case 'heading': case 'blockquote': return readableTokens(token.tokens ?? []).trimEnd() + '\n\n'
      case 'checkbox': return token.checked ? '☑ ' : '☐ '
      case 'image': return token.tokens?.length ? readableTokens(token.tokens) : decodeMarkdownEntities(token.text || '图片')
      default: return prose.tokens ? readableTokens(prose.tokens) : decodeMarkdownEntities(String(prose.text ?? prose.raw ?? ''))
    }
  }).join('')
}

/** For compact summaries: keep words and code, omit formatting and destinations. */
export function markdownPlainText(value: string): string {
  return readableTokens(parseMarkdown(value)).replace(/\n{3,}/g, '\n\n').trim()
}

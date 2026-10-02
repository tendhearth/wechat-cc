// @ts-check
import { Marked } from '../vendor/marked.js'

/** @param {unknown} value */
export function escapeWorkbenchHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)
}

/** @type {import('marked').RendererObject} */
const workbenchRenderer = {
  html({ text }) { return escapeWorkbenchHtml(text) },
  link({ href, title, tokens }) {
    const label = this.parser.parseInline(tokens)
    try {
      const url = new URL(href)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return label
      return `<a href="${escapeWorkbenchHtml(url.href)}"${title ? ` title="${escapeWorkbenchHtml(title)}"` : ''} target="_blank" rel="noopener noreferrer">${label}</a>`
    } catch { return label }
  },
  image({ text }) { return `<span class="wb-markdown-image">${escapeWorkbenchHtml(text || '图片')}</span>` },
}

const workbenchMarkdown = new Marked({ gfm: true, breaks: true, renderer: workbenchRenderer })

/** @param {string} value */
export function renderWorkbenchMarkdown(value) {
  return /** @type {string} */ (workbenchMarkdown.parse(String(value ?? '')))
}

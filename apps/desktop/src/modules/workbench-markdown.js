// @ts-check
// Parsing is shared with the native app and phone page; desktop reading controls live here.
import { escapeMarkdownHtml, renderMarkdown, renderReadingMarkdown, hasMarkdownFormatting } from '../vendor/markdown.js'
export {
  escapeMarkdownHtml as escapeWorkbenchHtml,
  renderReadingMarkdown as renderWorkbenchMarkdown,
  markdownPlainText,
  hasMarkdownFormatting,
} from '../vendor/markdown.js'

/** Render a sent user message without changing the original text.
 * @param {string} value @param {string} key */
export function renderWorkbenchUserText(value, key) {
  const text=String(value??''),source=escapeMarkdownHtml(text).replace(/\r/g,'&#13;')
  if(!hasMarkdownFormatting(text))return `<div class="cc-user-reading"><div class="cc-user-plain">${source}</div></div>`
  const id='cc-user-source-'+Array.from(String(key)).map(c=>c.codePointAt(0)?.toString(16)).join('-')
  return `<div class="cc-user-reading"><div class="cc-readable-markdown wb-markdown">${renderMarkdown(text)}</div><details id="${id}" class="cc-message-source" data-user-source><summary>查看原文</summary><pre><code>${source}</code></pre></details></div>`
}

/** @typedef {{querySelectorAll?:(selector:string)=>ArrayLike<{id:string,toggleAttribute:(name:string,force?:boolean)=>boolean}>}} SourceRoot */
/** @param {SourceRoot|null} root @returns {Set<string>} */
export function captureUserSources(root) {
  return new Set(Array.from(root?.querySelectorAll?.('[data-user-source][open]')??[]).map(node=>node.id))
}

/** @param {SourceRoot|null} root @param {Set<string>} open */
export function restoreUserSources(root,open) {
  for(const node of Array.from(root?.querySelectorAll?.('[data-user-source]')??[]))node.toggleAttribute('open',open.has(node.id))
}

/** Markdown files get readable content and exact source; plain formats never acquire Markdown semantics.
 * @param {string} name @param {string} mime @param {string} text */
export function renderReadingFile(name,mime,text) {
  // An initial comment prevents HTML pre parsing from discarding a real leading LF.
  const source=`<pre>${text.startsWith('\n')?'<!---->':''}${escapeMarkdownHtml(text).replace(/\r/g,'&#13;')}</pre>`
  return mime.split(';')[0]==='text/markdown'||/\.(md|markdown)$/i.test(name)
    ? `<article class="wb-document cc-readable-markdown wb-markdown">${renderReadingMarkdown(text)}</article><details id="wb-artifact-source" class="wb-disclosure"><summary>查看原文</summary>${source}</details>` : source
}

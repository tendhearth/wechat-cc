import { renderMarkdown, markdownPlainText, hasMarkdownFormatting } from './index'

declare global {
  var CCM: { renderMarkdown: typeof renderMarkdown; markdownPlainText: typeof markdownPlainText; hasMarkdownFormatting: typeof hasMarkdownFormatting }
}

globalThis.CCM = { renderMarkdown, markdownPlainText, hasMarkdownFormatting }

import { renderMarkdown, markdownPlainText } from './index'

declare global {
  var CCM: { renderMarkdown: typeof renderMarkdown; markdownPlainText: typeof markdownPlainText }
}

globalThis.CCM = { renderMarkdown, markdownPlainText }

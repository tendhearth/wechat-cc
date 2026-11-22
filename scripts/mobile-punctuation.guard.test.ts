import { readFileSync, readdirSync } from 'node:fs'
import { relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const root = fileURLToPath(new URL('../', import.meta.url))
const mobile = new URL('../apps/mobile/src/', import.meta.url)
const phone = new URL('../src/features/phone/', import.meta.url)
const sources = [
  ...readdirSync(mobile)
    .filter(name => /\.(?:js|css|html)$/.test(name) && !name.endsWith('-generated.js'))
    .map(name => new URL(name, mobile)),
  ...['mobile-page.ts', 'mobile-page-template.ts', 'settings-panel-html.ts'].map(name => new URL(name, phone)),
]
const halfwidth = /(?<=\p{Script=Han})[,:;()?!]|[,:;()?!](?=\p{Script=Han})/u

function punctuationIssues(source: string) {
  // Mark literal commands, API paths and code explicitly with <code> or <kbd>.
  // Keep their contents on one line so diagnostics retain the source line number.
  const withoutBlockComments = source.replace(/^[ \t]*\/\*(?:(?!\*\/)[\s\S])*\*\/(?=[ \t]*$)/gm,
    comment => comment.replace(/[^\n]/g, ''))
  return withoutBlockComments.split('\n').flatMap((line, index) => {
    if (/^\s*(?:\/\/|\/\*|\*(?:\s|\/|$)|<!--)/.test(line)) return []
    const copy = line
      .replace(/\s{2,}\/\/ .*$/, '')
      .replace(/<(code|kbd)(?:\s[^>]*)?>[^<]*<\/\1>/gi, ' ')
    const found = halfwidth.exec(copy)
    return found ? [`${index + 1}: ${copy.slice(Math.max(0, found.index - 12), found.index + 13)}`] : []
  })
}

it('uses fullwidth punctuation next to Chinese on mobile web', () => {
  const issues = sources.flatMap(file => punctuationIssues(readFileSync(file, 'utf8'))
    .map(issue => `${relative(root, fileURLToPath(file))}:${issue}`))
  expect(issues).toEqual([])
})

it('checks Chinese copy around explicitly marked code', () => {
  expect(punctuationIssues('用 <code>/api 短名(test)</code> 切换。')).toEqual([])
  expect(punctuationIssues('<kbd>切换(test)</kbd>，现在可以重试;或返回。')).toHaveLength(1)
  expect(punctuationIssues('准备失败,点此重试')).toHaveLength(1)
})

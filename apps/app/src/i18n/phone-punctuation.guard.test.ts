import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

const halfwidth = /(?<=\p{Script=Han})[,:;()?!]|[,:;()?!](?=\p{Script=Han})/u

function punctuationIssues(source: string): string[] {
  return source.replace(/\r\n?/g, '\n').split('\n').flatMap((line, i) => {
    const entry = /^\s*(\w+|'[^']+'|"[^"]+"):\s*(['"])(.*)\2,?\s*(?:\/\/.*)?$/.exec(line)
    if (!entry) return []
    // Literal code in copy can be marked with backticks.
    const copy = entry[3]!.replace(/`[^`]*`/g, ' ')
    return halfwidth.test(copy) ? [`${i + 1}: ${entry[1]}`] : []
  })
}

it('uses fullwidth punctuation next to Chinese in the app copy tables', () => {
  const issues = ['zh-Hans.ts', 'minimal-conversation.ts', 'minimal-secondary.ts'].flatMap(path =>
    punctuationIssues(readFileSync(new URL(path, import.meta.url), 'utf8')).map(issue => `${path}:${issue}`))
  expect(issues).toEqual([])
})

it('checks copy on CRLF and skips comments and literal code', () => {
  expect(punctuationIssues([
    "// 'note': '一,二',",
    "  'code': '运行 `/短名(test)`。',",
    "  'bad': '清单:{target}',",
    '  inline: "打不开(文件)", // 注释,不查',
  ].join('\r\n'))).toEqual(["3: 'bad'", '4: inline'])
})

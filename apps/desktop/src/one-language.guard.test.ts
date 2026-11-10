import { isTaskCachePath } from '../../../scripts/task-cache-paths'
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

// 一套产品语言(设计稿 2026-10-31 §4 U4;2026-11-05 主人:「此刻」与「一起做」像两个 app):
// 桌面没有单独的「一起做」了 —— 主页「此刻」+「全部」+ 一件事的详情。界面上看得见的字(页面、通知、对话框)
// 不再出现「一起做」;注释里讲历史可以。按行判:整行是注释的跳过,行尾 `// …` 截掉(块注释正则会吞掉字符串里的 /*)。
const ROOT = join(__dirname)
const SKIP = /(^|\/)(vendor|pdfjs|node_modules|generated)(\/|$)|\.test\.|\.spec\./

function files(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const p = join(dir, name)
    if (isTaskCachePath(p)) return []
    if (SKIP.test(relative(ROOT, p).replaceAll('\\', '/'))) return []
    return statSync(p).isDirectory() ? files(p) : /\.(js|html)$/.test(name) ? [p] : []
  })
}

function visibleHits(source: string): Array<{ line: number; text: string }> {
  return source.split(/\r?\n/).flatMap((line, i) => {
    const t = line.trim()
    if (/^(\/\/|\/\*|\*|<!--)/.test(t)) return []
    const code = line.replace(/\s\/\/\s.*$/, '').replace(/<!--.*?-->/g, '')
    return code.includes('一起做') ? [{ line: i + 1, text: t }] : []
  })
}

describe('desktop: one product language', () => {
  it('no user-visible 「一起做」 in pages, notifications or dialogs', () => {
    const hits = files(ROOT).flatMap(f => visibleHits(readFileSync(f, 'utf8')).map(h => `${relative(ROOT, f)}:${h.line}  ${h.text}`))
    expect(hits).toEqual([])
  })

  it('the scanner still sees a string on a code line, and skips comment lines', () => {
    expect(visibleHits("const a = '一起做有回复了'")).toHaveLength(1)
    expect(visibleHits("x = `<h2>一起做</h2>` // 旧的")).toHaveLength(1)
    expect(visibleHits('// 一起做不再是导航项')).toEqual([])
    expect(visibleHits(' * 一起做和其他页一样')).toEqual([])
    expect(visibleHits('foo() // 原来的一起做')).toEqual([])
  })
})

import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

// 桌面 app 的 webview(wry / WKWebView)没实现 JS 对话框,也没有新窗口处理(2026-10-05 检查):
//   alert() 不显示、confirm() 直接返回 false、prompt() 返回 null —— 浏览器 / Playwright 里一切正常,真 app 里静默失灵。
// 用 view.js 的 showToast / armConfirm 代替;外部链接由 modules/external-links.js 统一交给系统浏览器。
const ROOT = join(__dirname)
const SKIP = /(^|\/)(vendor|pdfjs|node_modules)(\/|$)|\.test\.|\.spec\./

function skip(path: string): boolean {
  return SKIP.test(path.replaceAll('\\', '/'))
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const p = join(dir, name)
    if (skip(relative(ROOT, p))) return []
    return statSync(p).isDirectory() ? files(p) : /\.(js|html)$/.test(name) ? [p] : []
  })
}

function dialogCalls(source: string): Array<{ line: number; text: string }> {
  return source.split(/\r?\n/).flatMap((line, i) => {
    const code = line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '')
    return /(^|[^.\w])(window\.)?(alert|confirm|prompt)\(/.test(code) && !/^\s*\*/.test(line) ? [{ line: i + 1, text: line.trim() }] : []
  })
}

describe('desktop webview: no browser APIs that silently do nothing in the real app', () => {
  it.each(['\n', '\r\n'])('ignores comment references with %j line endings', newline => {
    const source = ['// no native confirm() popups', '// 展开的 prompt(先收起)', 'const safe = true'].join(newline)
    expect(dialogCalls(source)).toEqual([])
  })

  it.each(['\n', '\r\n'])('still detects browser dialogs with %j line endings', newline => {
    const source = ['// confirm() is unavailable', 'window.confirm("continue?") // prompt() in a comment', 'alert("done")', 'prompt("name")'].join(newline)
    expect(dialogCalls(source)).toEqual([
      { line: 2, text: 'window.confirm("continue?") // prompt() in a comment' },
      { line: 3, text: 'alert("done")' },
      { line: 4, text: 'prompt("name")' },
    ])
  })

  it.each(['/', '\\'])('excludes vendored files with %j path separators', separator => {
    for (const directory of ['vendor', 'pdfjs', 'node_modules']) {
      expect(skip(['modules', directory, 'bundle.js'].join(separator))).toBe(true)
    }
    expect(skip(['modules', 'settings-drawer.js'].join(separator))).toBe(false)
  })

  it('never calls alert / confirm / prompt', () => {
    const hits = files(ROOT).flatMap(f => dialogCalls(readFileSync(f, 'utf8')).map(hit => `${relative(ROOT, f)}:${hit.line}: ${hit.text}`))
    expect(hits).toEqual([])
  })
})

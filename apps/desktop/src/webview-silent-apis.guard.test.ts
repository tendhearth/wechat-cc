import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

// 桌面 app 的 webview(wry / WKWebView)没实现 JS 对话框,也没有新窗口处理(2026-10-05 检查):
//   alert() 不显示、confirm() 直接返回 false、prompt() 返回 null —— 浏览器 / Playwright 里一切正常,真 app 里静默失灵。
// 用 view.js 的 showToast / armConfirm 代替;外部链接由 modules/external-links.js 统一交给系统浏览器。
const ROOT = join(__dirname)
const SKIP = /(^|\/)(vendor|pdfjs|node_modules)(\/|$)|\.test\.|\.spec\./

function files(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const p = join(dir, name)
    if (SKIP.test(relative(ROOT, p))) return []
    return statSync(p).isDirectory() ? files(p) : /\.(js|html)$/.test(name) ? [p] : []
  })
}

describe('desktop webview: no browser APIs that silently do nothing in the real app', () => {
  it('never calls alert / confirm / prompt', () => {
    const hits = files(ROOT).flatMap(f => readFileSync(f, 'utf8').split('\n').flatMap((line, i) => {
      const code = line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '')
      return /(^|[^.\w])(window\.)?(alert|confirm|prompt)\(/.test(code) && !/^\s*\*/.test(line) ? [`${relative(ROOT, f)}:${i + 1}: ${line.trim()}`] : []
    }))
    expect(hits).toEqual([])
  })
})

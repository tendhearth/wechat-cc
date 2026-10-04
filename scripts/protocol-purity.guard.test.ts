/**
 * `packages/protocol` 的**纯净守卫**。
 *
 * 这个包要同时被 daemon(Bun/Node)、手机网页(浏览器)、未来的 Expo/React Native app
 * 和一个 relay 壳页 import。任何一处偷偷用了 Node 内置模块、`Buffer`、
 * `crypto.subtle`(浏览器/Node 的 Web Crypto,不是所有目标运行时都有)、或
 * `window`/`document`/`localStorage`(浏览器全局,RN/daemon 没有),这个包立刻
 * 在某个目标平台上跑不动 —— 而且症状只在那个平台出现,本地在 Bun 下测不出来。
 *
 * 这条测试不测 protocol 的逻辑,测的是「src/ 下的非测试代码没有踩这几类全局」。
 * 随机数只许走 `globalThis.crypto.getRandomValues`(Web Crypto 的这一小块是三端
 * 通用的,`crypto.subtle` 不是 —— 后者在 React Native 里没有)。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import ts from 'typescript'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PROTOCOL_SRC = join(ROOT, 'packages', 'protocol', 'src')

interface Violation {
  file: string
  rule: string
  line: number
}

const FORBIDDEN_RULES: Array<{ name: string; pattern: RegExp }> = [
  { name: `from 'node:`, pattern: /from\s+['"]node:/ },
  // 动态 import('node:...') / import("node:...") 绕不开静态 `from` 那条正则
  // (它要求字面量 "from" 紧跟引号),所以单独一条。
  { name: `import('node:`, pattern: /\bimport\s*\(\s*['"]node:/ },
  // 容忍 require 和左括号之间有空白(`require ('x')`),不只是紧贴的 `require(`。
  { name: 'require(', pattern: /\brequire\s*\(/ },
  { name: 'Buffer', pattern: /\bBuffer\b/ },
  { name: 'crypto.subtle', pattern: /crypto\.subtle\b/ },
]
const BROWSER_GLOBALS = new Set(['window', 'document', 'localStorage'])

/** 递归列出一个目录下所有 `.ts` 文件(不含 `.test.ts`),相对路径。 */
function listSourceFiles(dir: string, base = dir): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...listSourceFiles(full, base))
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(full)
    }
  }
  return out
}

function scanForViolations(files: string[]): Violation[] {
  const violations: Violation[] = []
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    const lines = source.split('\n')
    lines.forEach((line, idx) => {
      for (const rule of FORBIDDEN_RULES) {
        if (rule.pattern.test(line)) {
          violations.push({ file, rule: rule.name, line: idx + 1 })
        }
      }
    })
    // A wire field named `window` is data, not a dependency on the browser.
    // Inspect syntax so property values, shorthand and globalThis.window still fail.
    const syntax = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
    const visit = (node: ts.Node) => {
      if (ts.isIdentifier(node) && BROWSER_GLOBALS.has(node.text)) {
        const parent = node.parent
        const dataKey = (ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent)) && parent.name === node
        if (!dataKey) violations.push({ file, rule: node.text, line: syntax.getLineAndCharacterOfPosition(node.getStart(syntax)).line + 1 })
      }
      ts.forEachChild(node, visit)
    }
    visit(syntax)
  }
  return violations
}

describe('packages/protocol 纯净守卫', () => {
  const files = listSourceFiles(PROTOCOL_SRC)

  it('扫到了至少一个源文件(守卫没有对着空目录自我感觉良好)', () => {
    expect(files.length).toBeGreaterThanOrEqual(1)
  })

  it('src/ 下的非测试代码不出现 node:*、require()、Buffer、crypto.subtle、window、document、localStorage', () => {
    const violations = scanForViolations(files)
    if (violations.length > 0) {
      const detail = violations
        .map(v => `  ${v.file.replace(ROOT + '/', '')}:${v.line} 命中「${v.rule}」`)
        .join('\n')
      throw new Error(`packages/protocol/src 里出现了禁用引用:\n${detail}`)
    }
    expect(violations).toEqual([])
  })

  it('规则本身抓得住故意的违规(不是空正则、不是永远绿的哑守卫)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'protocol-purity-fixture-'))
    try {
      const fixture = [
        "import fs from 'node:fs'",
        "const mod = await import('node:fs')",
        "const mod2 = require ('foo')",
        'const b = Buffer.from([1])',
        'await crypto.subtle.digest("SHA-256", data)',
        'window.location.href',
        'document.createElement("div")',
        'localStorage.getItem("x")',
      ].join('\n')
      writeFileSync(join(dir, 'bad.ts'), fixture, 'utf8')
      const violations = scanForViolations(listSourceFiles(dir))
      expect(violations.map(v => v.rule).sort()).toEqual([...FORBIDDEN_RULES.map(r => r.name), ...BROWSER_GLOBALS].sort())
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('accepts wire field names while still rejecting browser globals in their values', () => {
    const dir = mkdtempSync(join(tmpdir(), 'protocol-purity-field-'))
    try {
      writeFileSync(join(dir, 'data.ts'), "const schema = { window: 'recent', document: 'label' }; type Page = { window?: 'start' }; const text = 'localStorage'")
      expect(scanForViolations(listSourceFiles(dir))).toEqual([])
      writeFileSync(join(dir, 'data.ts'), 'const bad = { value: window, document, storage: globalThis.localStorage }')
      expect(scanForViolations(listSourceFiles(dir)).map(v => v.rule)).toEqual(['window', 'document', 'localStorage'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

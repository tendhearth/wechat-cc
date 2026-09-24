import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { assembleMobilePage, serializeMobilePage } from './assemble'
import { readMobileSource, MOBILE_PAGE_OUT } from './sources'

describe('apps/mobile → src/daemon/mobile-page.generated.json', () => {
  const page = assembleMobilePage(readMobileSource)

  it('generated page is in sync with apps/mobile/src (fix: bun run build:mobile)', () => {
    // 比整份文本:手改生成物、或源文件被编辑器动过,都会在这里红。
    expect(readFileSync(MOBILE_PAGE_OUT, 'utf8')).toBe(serializeMobilePage(page))
  })

  it('first <script> is bare and defines T — relay/pset.html injects __CC_SHELL__ into it', () => {
    const i = page.phone.indexOf('<script')
    expect(page.phone.slice(i, i + 8)).toBe('<script>')
    expect(page.phone.indexOf('var T = {{TOKEN_JSON}}')).toBeGreaterThan(i)
  })

  it('no script line starts with ( or [ — ASI would glue it onto the previous line as a call/index', () => {
    // 2026-09-24 上类型时踩到:行首 `/** @type {X} */ (el).disabled=…` 会被接成上一行 `})(el)`,运行时 TypeError。
    for (const name of ['boot.js', 'transport.js', 'nav.js', 'workbench.js', 'presence.js', 'home.js', 'sw.js']) {
      const bad = readMobileSource(name).split('\n').map((line, i) => [i + 1, line.replace(/\/\*\*.*?\*\/\s*/g, '')] as const)
        .filter(([, line]) => /^\s*[([]/.test(line))
      expect(bad, name).toEqual([])
    }
  })

  it('pulls in no external script or stylesheet — the shell page has no usable origin', () => {
    expect(page.phone).not.toMatch(/<script[^>]*\ssrc=/)
    expect(page.phone).not.toMatch(/<link[^>]*rel="stylesheet"/)
  })
})

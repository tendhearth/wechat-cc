import { isTaskCachePath } from '../../../scripts/task-cache-paths'
import { tmpdir } from 'node:os'
// 桌面样式守卫(spec 2026-10-01 §6.1)。
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, relative, dirname } from 'node:path'

const ROOT = __dirname
const walk = (d: string, out: string[] = []): string[] => {
  for (const n of readdirSync(d)) { const f = join(d, n); if (isTaskCachePath(f)) continue; statSync(f).isDirectory() ? (n === 'vendor' ? 0 : walk(f, out)) : out.push(f) }
  return out
}
const STYLESHEETS = walk(ROOT).filter(f => f.endsWith('.css'))
const CSS = STYLESHEETS.filter(f => !f.endsWith('tokens.css'))
const rel = (f: string) => relative(ROOT, f)
const hexCount = (s: string) => (s.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(\s*\d/g) ?? []).length
/** 三块主界面零字面色值;其余按棘轮。Task 12 / 13 只许把数字往下改。 */
export const HEX_BUDGET: Record<string, number> = {
  // 2026-10-01 实测基线(Task 8,机械替换旧色板之后)。companion-window / animation-lab 不在换皮范围(spec §8)。
  'animation-lab.css': 32,
  'cc-life.css': 0,
  'cc-page-art.css': 0,
  'cc-surfaces.css': 0,
  'companion-window.css': 16,
  'fonts.css': 0,
  'postcard-album.css': 0,
  // styles.css 剩下的全是「复刻微信聊天」那一段(iPhone 框、绿气泡)的内容色,见该段上方注释。
  'styles.css': 36,
}
/** Task 10 加 cc-life.css、cc-now.css;Task 12 加工作台三份(styles/workbench*.css、styles/task-entry.css);converse.css 新建即零。 */
const ZERO_HEX: string[] = ['cc-life.css', 'cc-now.css', 'styles/workbench.css', 'styles/task-entry.css', 'styles/converse.css', 'styles/desk-two-pane.css']

function mixedIdSelectorLists(css: string): string[] {
  const violations: string[] = []
  const candidates: string[] = []
  const functions: {
    name: string
    line: number
    zeroSpecificity: boolean
    currentHasId: boolean
    previousHasId: boolean
    previousHasNonId: boolean
  }[] = []
  let inComment = false
  let inAttribute = false
  let prelude: 'at-rule' | 'rule' | undefined
  const lines = css.replace(/\r\n?/g, '\n').split('\n')
  for (const [index, line] of lines.entries()) {
    // 按行找注释边界，保留 */ 后同一行的代码。引号和转义里的标点不是选择器语法。
    const tokens = /\/\*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\\.|:[a-z-]+\(|[()[\],]|#(?=[\w\\\u0080-\uFFFF-])|[^#\s]/gi
    while (tokens.lastIndex < line.length) {
      if (inComment) {
        const end = line.indexOf('*/', tokens.lastIndex)
        if (end === -1) break
        tokens.lastIndex = end + 2
        inComment = false
      }
      const token = tokens.exec(line)?.[0]
      if (!token) break
      if (token === '/*') {
        inComment = true
        continue
      }
      // A style rule ends its selector prelude with an opening brace. At-rule
      // preludes (including @supports selector()) and declarations are discarded.
      if (!inAttribute && functions.length === 0 && ['{', '}', ';'].includes(token)) {
        if (token === '{' && prelude === 'rule') violations.push(...candidates)
        candidates.length = 0
        prelude = undefined
        continue
      }
      prelude ??= token === '@' ? 'at-rule' : 'rule'
      if (token === '[') inAttribute = true
      else if (token === ']') inAttribute = false
      else if (!inAttribute) {
        const current = functions.at(-1)
        if (token.endsWith('(') && (token === '(' || token.startsWith(':'))) {
          const name = token.slice(0, -1).toLowerCase()
          functions.push({
            name, line: index + 1, zeroSpecificity: name === ':where' || (current?.zeroSpecificity ?? false),
            currentHasId: false, previousHasId: false, previousHasNonId: false,
          })
        } else if (current && token === ',') {
          current.previousHasId ||= current.currentHasId
          current.previousHasNonId ||= !current.currentHasId
          current.currentHasId = false
        } else if (current && token === ')') {
          functions.pop()
          if (current.zeroSpecificity) continue
          const hasId = current.previousHasId || current.currentHasId
          const hasNonId = current.previousHasNonId || !current.currentHasId
          if (hasId && hasNonId && [':is', ':not', ':has'].includes(current.name)) {
            candidates.push(`${current.line} ${current.name}()`)
          }
          const parent = functions.at(-1)
          if (parent) parent.currentHasId ||= hasId
        } else if (current && token === '#') {
          current.currentHasId = true
        }
      }
    }
  }
  return violations
}

describe('desktop design style', () => {
  it('selector lists do not lend ID specificity to non-ID branches', () => {
    const violations = STYLESHEETS.flatMap(f =>
      mixedIdSelectorLists(readFileSync(f, 'utf8')).map(location => `${rel(f)}:${location}`),
    )
    expect(violations, ':is(), :not() and :has() take the specificity of their strongest argument, so an ID also raises the non-ID branches. Wrap the ID in :where() and keep a separate ID selector if its cascade needs it.').toEqual([])
  })

  it('checks multiline and nested selector lists without counting comments, attributes or :where() IDs', () => {
    const css = [
      '/* :is(#comment, .skip)',
      '   :not(#comment, .skip) */ :is(.thing, #thread) {}',
      ':not(/* keep scanning */ [hidden],',
      '  :has(#image:not([hidden]))) {}',
      ':has(> #thread, > article) {}',
      ':is(#earlier, #later) {}',
      ':is(#thread .item) {}',
      ':is(.item, :where(#earlier, #later)) {}',
      ':not([data-href="#thread,)"], :has(:where(#image):not([hidden]))) {}',
      ':has([href=\\#thread], .item) { content: ":is(#fake, .fake)"; }',
    ].join('\r\n')
    expect(mixedIdSelectorLists(css)).toEqual(['2 :is()', '3 :not()', '5 :has()'])
  })

  it('checks rule selectors inside feature queries, skipping the feature tests and declaration values', () => {
    const css = [
      '@supports selector(:is(#probe, .probe)) { .thread { display: block } }',
      '/* feature */ @supports',
      '  selector(:is(#probe, .probe)) {',
      '  @media (min-width: 600px) {',
      '    /* rule */ :is(#thread, .thread) { --example: :is(#value, .value) }',
      '  }',
      '}',
    ].join('\n')
    expect(mixedIdSelectorLists(css)).toEqual(['5 :is()'])
  })

  it('no dark mode', () => { for (const f of CSS) expect(readFileSync(f, 'utf8'), rel(f)).not.toMatch(/prefers-color-scheme:\s*dark/) })
  it('font-weight is 400 / 500 / normal only', () => {
    for (const f of CSS) expect(readFileSync(f, 'utf8').match(/font-weight:\s*(?!400\b|500\b|normal\b|var\()[^;}\s]+/g) ?? [], rel(f)).toEqual([])
    // 简写里的字重(`font: 600 11px/1.5 …`)同样只许 400 / 500 —— 裁决 E3。
    for (const f of CSS) expect(readFileSync(f, 'utf8').match(/\bfont:\s*(?!400\b|500\b)(\d{3}|bold|bolder)\b/g) ?? [], rel(f)).toEqual([])
  })
  it('fonts are local; no runtime CDN', () => {
    const html = readFileSync(join(ROOT, 'index.html'), 'utf8')
    for (const s of [html, ...CSS.map(f => readFileSync(f, 'utf8'))]) expect(s).not.toMatch(/fonts\.(googleapis|gstatic)\.com/)
    expect(html.indexOf('tokens.css')).toBeGreaterThan(-1)
    expect(html.indexOf('tokens.css')).toBeLessThan(html.indexOf('styles.css'))
  })
  it('body text uses system sans', () => {
    const css = readFileSync(join(ROOT, 'styles.css'), 'utf8')
    expect(css).toMatch(/--sans:\s*var\(--th-font-sans\)/)
    expect(css).not.toMatch(/font-family:\s*"Geist"/)
  })
  it('workbench status is the status-table glyph + text, same as 此刻 (no tinted chips, no coloured dots)', () => {
    const css = readFileSync(join(ROOT, 'styles/workbench.css'), 'utf8')
    expect(css.match(/background(-color)?:\s*var\(--(green|amber|rouge)-soft\)/g) ?? []).toEqual([])
    // 2026-11-05 U4 一套语言:行与详情的状态记号走 matter-status.js 的 .now-row-status(此刻同款),
    // 状态词旁边不再画红黄绿圆点 —— 圆点是第二套状态语言。
    expect(css).not.toMatch(/\.wb-status(\[[^\]]*\])?::before/)
    expect(css).not.toMatch(/\.wb-task-attention::before/)
    expect(css).toMatch(/\.now-row-status\[data-tone="accent"\]/)
    for (const f of ['styles/workbench.css', 'styles/task-entry.css', 'styles/converse.css', 'styles/desk-two-pane.css']) {
      let css = readFileSync(join(ROOT, f), 'utf8')
      if (f === 'styles/desk-two-pane.css') {
        // 旧的两处投影和宽窗口的三层 token。
        css = css.replace(/(\[data-desk-wide\] \.desk-waiting-card \{[^}]*?)box-shadow: 0 1px 0 var\(--th-hair\), 0 8px 18px color-mix\(in srgb, var\(--th-ink\) 7%, transparent\);/, '$1')
          .replace(/(\[data-desk-collapsed\]\[data-desk-peeking\] #dash-global-rail \{[^}]*?)box-shadow: 4px 0 16px color-mix\(in srgb, var\(--th-ink\) 8%, transparent\);/, '$1')
          .replace('box-shadow: var(--th-desk-shadow-sheet);', '')
          .replaceAll('box-shadow: var(--th-desk-shadow-raised);', '')
          .replaceAll('box-shadow: var(--th-desk-shadow-selection);', '')
      }
      expect(css, f).not.toMatch(/box-shadow:\s*(?!none|\s)/)
    }
  })
  it('literal colours: ratchet', () => {
    for (const f of CSS) {
      const r = rel(f)
      const budget = ZERO_HEX.includes(r) ? 0 : HEX_BUDGET[r]
      if (budget === undefined) continue
      expect(hexCount(readFileSync(f, 'utf8')), r).toBeLessThanOrEqual(budget)
    }
  })
})

it('source discovery excludes both task cache trees', () => {
  const root = mkdtempSync(join(tmpdir(), 'desktop-source-guard-'))
  try {
    for (const file of ['ordinary.css', '.cc-tasks/task/cache/copy.css', 'node_modules/.cache/cc-tasks/task/copy.css']) {
      mkdirSync(dirname(join(root, file)), { recursive: true })
      writeFileSync(join(root, file), 'body {}')
    }
    expect(walk(root).map(file => relative(root, file).replaceAll('\\', '/'))).toEqual(['ordinary.css'])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

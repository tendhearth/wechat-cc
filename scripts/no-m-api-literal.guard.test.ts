/**
 * 新代码里不再写 `/m/api`(P3,设计稿 docs/superpowers/specs/2026-11-05-p3-one-route-family-design.md「守卫」)。
 *
 * 一份数据一条 `/v1` 路径;`/m/api/*` 只剩兼容表里的别名,由 `src/features/phone/legacy-routes.ts` 一个文件认
 * (`packages/protocol/src/wire-compat.ts` 是那张表本身)。过渡期是棘轮:`src`、`apps/mobile/src`、`packages/protocol/src`
 * 里(测试与生成物除外)带引号的 `/m/api` 字面量按**行**数、按文件记基线,只许往下调;P3d 做完 src 里降到 0,
 * P3f / P3g / P3h 把 protocol 与网页那几份降完。
 *
 * 「带引号」= 引号(' " `)后面紧跟 `/m/api`,或者紧跟一个方法名加空格(路由表的键 `'GET /m/api/…'`)。
 * 注释**按行**跳过(去掉行首空白后以 `//`、`*`、`/*` 开头的行):不用跨行的块注释正则 —— 那种正则见过把字符串里的
 * `/*` 当成注释开头、吞掉后面的代码、静默少报。行尾注释里写的那一行照算(宁可多算)。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCAN_ROOTS = ['src', 'apps/mobile/src', 'packages/protocol/src']
/** 别名只活在这两个文件里(设计稿「守卫」)。 */
const ALLOWED = new Set(['src/features/phone/legacy-routes.ts', 'packages/protocol/src/wire-compat.ts'])
const SOURCE = /\.(ts|tsx|js|mjs|cjs|html)$/
const SKIP = /(\.test\.|\.generated\.|\/__golden__\/|\/node_modules\/)/
const LITERAL = /['"`](?:[A-Z]+ )?\/m\/api/

// @debt 带引号的 /m/api 字面量,按文件记的行数(P3c–P3h 逐步降;降到 0 = 只剩 legacy-routes.ts 与 wire-compat.ts)
const BASELINE: Record<string, number> = {
  'src/cli/selftest-phone.ts': 2,
  'src/features/jobs/mobile.ts': 2,
  'src/features/letters/mobile.ts': 2,
  'src/features/phone/mobile-activity.ts': 1,
  'src/features/phone/mobile-chat.ts': 5,
  'src/features/phone/mobile-reads.ts': 5,
  'src/features/phone/mobile-workbench.ts': 16,
  'src/features/phone/settings-panel.ts': 19,
  'apps/mobile/src/home.js': 1,
  'apps/mobile/src/presence.js': 1,
  'apps/mobile/src/workbench.js': 3,
  'packages/protocol/src/api.ts': 61,
  'packages/protocol/src/phone-calls.ts': 60,
  'packages/protocol/src/routes.ts': 52,
}

/** 一行是不是整行注释(按行判,不跨行)。 */
function isCommentLine(line: string): boolean {
  const t = line.trimStart()
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')
}

/** 一份源码里带引号 `/m/api` 字面量的行数(整行注释不算)。 */
function literalLines(text: string): number {
  let n = 0
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) if (!isCommentLine(line) && LITERAL.test(line)) n++
  return n
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (name === 'node_modules') continue
    if (statSync(p).isDirectory()) walk(p, out)
    else out.push(p)
  }
}

function scan(): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const r of SCAN_ROOTS) {
    const files: string[] = []
    walk(join(ROOT, r), files)
    for (const abs of files) {
      const rel = relative(ROOT, abs).split('\\').join('/')
      if (!SOURCE.test(rel) || SKIP.test('/' + rel) || ALLOWED.has(rel)) continue
      const n = literalLines(readFileSync(abs, 'utf8'))
      if (n) counts[rel] = n
    }
  }
  return counts
}

describe('literalLines(按行数、整行注释跳过)', () => {
  it('引号紧跟 /m/api 或「方法 + 空格 + /m/api」才算;整行注释不算;行尾注释那行照算', () => {
    const text = [
      "  'GET /m/api/state': handler,",
      '  fetch("/m/api/home")',
      '  const u = `/m/api/matter?id=${id}`',
      '  // 走 \'/m/api/old\' 那条',
      '   * 见 `/m/api/chat`',
      "  /* '/m/api/x' */",
      "  const p = '/x/m/api'",
      '  const s = "跟 /m/api 无关"',
      "  const q = '/*'; const r = '/m/api/after-star'",
      "  run() // '/m/api/trailing'",
    ].join('\r\n')
    expect(literalLines(text)).toBe(5)
  })
})

describe('/m/api 字面量只许变少', () => {
  const actual = scan()

  it('没有基线之外的新文件', () => {
    const extra = Object.keys(actual).filter(f => !(f in BASELINE))
    expect(extra, '新代码写 /v1 路径;别名只进 wire-compat.ts / legacy-routes.ts').toEqual([])
  })

  it('每个文件的行数 ≤ 基线且等于基线(降了就把基线调下来,降到 0 删掉那一行)', () => {
    for (const [file, max] of Object.entries(BASELINE)) {
      expect(actual[file] ?? 0, `${file}:比基线多 ⇒ 新加的写 /v1`).toBeLessThanOrEqual(max)
      expect(actual[file] ?? 0, `${file}:比基线少了 ⇒ 把 BASELINE 调成新的数(降到 0 删掉那一行)`).toBe(max)
    }
    expect(Object.values(BASELINE).every(n => n > 0), '基线里留着 0 的行 ⇒ 删掉').toBe(true)
  })
})

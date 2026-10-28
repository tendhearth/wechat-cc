/**
 * 版本号:从 `--version` 输出里抠出来、互相比大小。
 *
 * 只用来回答「有没有更新的」和「这是不是同一个版本」,**从不**用来判兼容(那是升级后自检的事)。
 */
import type { CliSpec } from './specs'

const SEMVER_RE = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/
const CURSOR_RE = /(\d{4}\.\d{2}\.\d{2}-[0-9a-f]{5,})/

/** `2.1.289 (Claude Code)` → `2.1.289`;`codex-cli 0.160.0` → `0.160.0`;`2026.09.02-c22c1a3` 原样。 */
export function parseVersion(spec: Pick<CliSpec, 'versionKind'>, raw: string | null | undefined): string | null {
  if (!raw) return null
  if (spec.versionKind === 'cursor-date') {
    const m = CURSOR_RE.exec(raw)
    if (m) return m[1]!
  }
  const m = SEMVER_RE.exec(raw)
  return m ? m[1]! : null
}

function cmpNum(a: number, b: number): number { return a < b ? -1 : a > b ? 1 : 0 }

function cmpSemver(a: string, b: string): number {
  const [ac, ap] = splitPre(a)
  const [bc, bp] = splitPre(b)
  const an = ac.split('.').map(Number)
  const bn = bc.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const c = cmpNum(an[i] ?? 0, bn[i] ?? 0)
    if (c) return c
  }
  // 1.0.0-rc < 1.0.0
  if (ap === bp) return 0
  if (ap === null) return 1
  if (bp === null) return -1
  return ap < bp ? -1 : 1
}

function splitPre(v: string): [string, string | null] {
  const i = v.indexOf('-')
  return i < 0 ? [v, null] : [v.slice(0, i), v.slice(i + 1)]
}

/** Cursor:先比日期,日期相同(同一天两次发布)只能说「不同」,按字符串定个稳定顺序。 */
function cmpCursor(a: string, b: string): number {
  const da = a.split('-')[0]!.split('.').map(Number)
  const db = b.split('-')[0]!.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const c = cmpNum(da[i] ?? 0, db[i] ?? 0)
    if (c) return c
  }
  return a === b ? 0 : a < b ? -1 : 1
}

/** a < b ⇒ 负数;相等 ⇒ 0;a > b ⇒ 正数。两种格式混着来(不该发生)就按字符串比。 */
export function compareVersions(spec: Pick<CliSpec, 'versionKind'>, a: string, b: string): number {
  if (a === b) return 0
  if (spec.versionKind === 'cursor-date' && CURSOR_RE.test(a) && CURSOR_RE.test(b)) return cmpCursor(a, b)
  if (SEMVER_RE.test(a) && SEMVER_RE.test(b)) return cmpSemver(SEMVER_RE.exec(a)![1]!, SEMVER_RE.exec(b)![1]!)
  return a < b ? -1 : 1
}

export function isNewer(spec: Pick<CliSpec, 'versionKind'>, candidate: string, than: string): boolean {
  return compareVersions(spec, candidate, than) > 0
}

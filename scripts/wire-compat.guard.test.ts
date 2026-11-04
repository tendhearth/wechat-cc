/**
 * 冻结的旧线上字段只许变少(M6b,设计稿 docs/superpowers/specs/2026-11-05-m6-read-side-design.md「定案」)。
 *
 * `packages/protocol/src/wire-compat.ts` 一行 = 一个老客户端还在读、daemon 现算的旧字段。新的旧形状不许再加进来
 * (src 里只剩步一种读形状);按退休条件删掉一行,就把下面的上限往下调 —— 棘轮只往一个方向转。
 *
 * 同一个文件里的 WIRE_ROUTE_ALIASES(P3,设计稿 2026-11-05-p3-one-route-family-design.md「守卫」):一行 = 一条 `/m/api`
 * 旧路径。两把棘轮:行数只许变少;「还是自己处理器」(handler: 'own')的行只许变少。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { MERGED_ALIAS_KEYS, WIRE_COMPAT, WIRE_ROUTE_ALIASES } from '../packages/protocol/src/wire-compat'
import { ROUTES } from '../packages/protocol/src/routes'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// @debt 冻结在线上、由 daemon 现算的旧字段(按退休条件逐行删;降到 0 = 线上只剩新形状)
const MAX_WIRE_COMPAT_ROWS = 5

describe('wire-compat 兼容表只许变少', () => {
  it(`行数 ≤ ${MAX_WIRE_COMPAT_ROWS}`, () => {
    expect(WIRE_COMPAT.length, '新加旧形状不行;删了一行就把 MAX_WIRE_COMPAT_ROWS 调成新的行数').toBeLessThanOrEqual(MAX_WIRE_COMPAT_ROWS)
  })
  it('上限跟实际一样(删了行忘了把上限调下来 ⇒ 红,棘轮不留空档)', () => {
    expect(WIRE_COMPAT.length).toBe(MAX_WIRE_COMPAT_ROWS)
  })
  it('每行都写清:字段、谁读、从哪推、什么时候删;字段不重复', () => {
    for (const row of WIRE_COMPAT) {
      expect(row.field.trim(), JSON.stringify(row)).not.toBe('')
      expect(row.readers.length, row.field).toBeGreaterThan(0)
      expect(row.derivedFrom.trim(), row.field).not.toBe('')
      expect(row.retireWhen.trim(), row.field).not.toBe('')
    }
    expect(new Set(WIRE_COMPAT.map(r => r.field)).size).toBe(WIRE_COMPAT.length)
  })
})

// @debt 还在线上的 /m/api 旧路径(别名表行数;按构建号逐行删,降到 0 = 手机只剩 /v1 一族)
const MAX_WIRE_ROUTE_ALIASES = 61
// @debt 别名表里还是面板自己处理器的行(P3c–P3e 每并一条降一;降到 0 = 每份数据只有一个处理器)
const MAX_OWN_HANDLER_ROWS = 55

const routeKeys = new Set(Object.keys(ROUTES))
const LEGACY_ROUTES = join(ROOT, 'src', 'features', 'phone', 'legacy-routes.ts')

describe('WIRE_ROUTE_ALIASES 别名表只许变少', () => {
  const own = WIRE_ROUTE_ALIASES.filter(r => r.handler === 'own')

  it(`行数 ≤ ${MAX_WIRE_ROUTE_ALIASES} 且等于上限`, () => {
    expect(WIRE_ROUTE_ALIASES.length, '新加别名不行;删了一行就把 MAX_WIRE_ROUTE_ALIASES 调成新的行数').toBeLessThanOrEqual(MAX_WIRE_ROUTE_ALIASES)
    expect(WIRE_ROUTE_ALIASES.length, '删了行忘了把上限调下来').toBe(MAX_WIRE_ROUTE_ALIASES)
  })

  it(`还是自己处理器的行 ≤ ${MAX_OWN_HANDLER_ROWS} 且等于上限`, () => {
    expect(own.length, '并了一条(handler 改 alias)就把 MAX_OWN_HANDLER_ROWS 调下来;不许把 alias 改回 own').toBeLessThanOrEqual(MAX_OWN_HANDLER_ROWS)
    expect(own.length).toBe(MAX_OWN_HANDLER_ROWS)
  })

  it('每行写清:旧键 /m/api、新键 /v1、谁读、什么时候删;旧键不重复、新键不重复', () => {
    for (const r of WIRE_ROUTE_ALIASES) {
      expect(r.from, JSON.stringify(r)).toMatch(/^(GET|POST) \/m\/api\//)
      expect(r.to, r.from).toMatch(/^(GET|POST) \/v1\//)
      expect(r.from.split(' ')[0], `${r.from}:新旧键方法要一样`).toBe(r.to.split(' ')[0])
      expect(r.readers.length, r.from).toBeGreaterThan(0)
      expect(r.retireWhen.trim(), r.from).not.toBe('')
      if (r.transform !== null) expect(r.transform, r.from).toMatch(/^[a-z][A-Za-z0-9]*$/)
    }
    expect(new Set(WIRE_ROUTE_ALIASES.map(r => r.from)).size).toBe(WIRE_ROUTE_ALIASES.length)
    expect(new Set(WIRE_ROUTE_ALIASES.map(r => r.to)).size).toBe(WIRE_ROUTE_ALIASES.length)
  })

  it('路由表里每条 /m/api 都登记了;own 行的旧键还在路由表里、链接令牌范围照路由表冻结;已并的旧键不在路由表里', () => {
    const phoneKeys = [...routeKeys].filter(k => / \/m\/api\//.test(k)).sort()
    for (const r of WIRE_ROUTE_ALIASES.filter(x => x.handler === 'alias')) expect(routeKeys.has(r.from), `${r.from} 已并成别名 ⇒ 路由表里不该还有它`).toBe(false)
    for (const r of own) {
      const spec = (ROUTES as Record<string, { phone?: { link: string } }>)[r.from]
      expect(spec?.phone, `${r.from}:还是自己处理器 ⇒ 路由表里该有这一行`).toBeDefined()
      expect(r.link, `${r.from}:link 照路由表冻结`).toBe(spec!.phone!.link)
    }
    // 路由表里的 /m/api 行都在别名表里(新加一条 /m/api 路由 ⇒ 红:新的写成 /v1)
    for (const k of phoneKeys) expect(WIRE_ROUTE_ALIASES.some(r => r.from === k), `${k} 不在别名表里`).toBe(true)
  })

  it('新键:P3c 的 /v1 双胞胎今天就在路由表里;P3d / P3e 要起的新路径今天还不在', () => {
    for (const r of own) {
      if (r.step === 'P3d' || r.step === 'P3e') expect(routeKeys.has(r.to), `${r.from} → ${r.to}:新路径已经存在,先核对是不是撞名`).toBe(false)
      else expect(routeKeys.has(r.to), `${r.from} → ${r.to}:双胞胎不在路由表里`).toBe(true)
    }
    for (const r of WIRE_ROUTE_ALIASES.filter(x => x.handler === 'alias')) expect(routeKeys.has(r.to), `${r.from} 已并 ⇒ 新键 ${r.to} 要在路由表里`).toBe(true)
  })

  it('已并的行 = MERGED_ALIAS_KEYS(类型 PanelRouteKey 并进来的就是这几个);面板处理器表里有它、处理器在 legacy-routes.ts', () => {
    expect(WIRE_ROUTE_ALIASES.filter(r => r.handler === 'alias').map(r => r.from).sort()).toEqual([...MERGED_ALIAS_KEYS].sort())
    const src = readFileSync(LEGACY_ROUTES, 'utf8')
    for (const k of MERGED_ALIAS_KEYS) expect(src.includes(`'${k}':`), `${k}:legacy-routes.ts 的表里没有它`).toBe(true)
    // 新键那一行的 phone 块:link 照别名行冻结的值抄(链接令牌经新键也只够得着旧键今天够得着的)
    for (const r of WIRE_ROUTE_ALIASES.filter(x => x.handler === 'alias')) {
      const spec = (ROUTES as Record<string, { phone?: { link: string } }>)[r.to]
      expect(spec?.phone?.link, `${r.to}:并了 ${r.from} ⇒ 这一行得有 phone 块,link 同别名行`).toBe(r.link)
    }
  })

  it('P3d 是纯改名(transform null),双胞胎与 P3e 都有转换;已并的行转换在 legacy-routes.ts 里有实现', () => {
    for (const r of WIRE_ROUTE_ALIASES) {
      if (r.step === 'P3d') expect(r.transform, r.from).toBeNull()
      else expect(r.transform, r.from).not.toBeNull()
    }
    const merged = WIRE_ROUTE_ALIASES.filter(r => r.handler === 'alias' && r.transform !== null)
    if (!merged.length) return
    expect(existsSync(LEGACY_ROUTES), 'legacy-routes.ts 不在').toBe(true)
    const src = readFileSync(LEGACY_ROUTES, 'utf8')
    for (const r of merged) expect(src.includes(r.transform!), `${r.from}:转换 ${r.transform} 在 legacy-routes.ts 里没有`).toBe(true)
  })
})

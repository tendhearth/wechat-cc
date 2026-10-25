/**
 * 链接令牌的范围 = 链接页面真正会调的路由(架构复查 10-21 理念 2「权限跟着入口走」)。
 *
 * 扫描器在 `link-routes-scan.ts`(形状、兜底、device-only 标记都写在那边的注释里)。这里:
 *   1. 把「拿着链接令牌会跑」的代码扫一遍(手机网页、设置页、中继壳页、App 配对、`selftest phone` 配对);
 *   2. 断言 LINK_ROUTES(routes.ts 里 link:'read' | 'write' 的行)与扫出来的集合**相等**:
 *      多开了 ⇒ 去 routes.ts 收成 'none';页面调了 'none' 的路由 ⇒ 链接会话会 403,要么挪进设备分支、要么开路由。
 *   3. 扫描器自己的几种失败方式各钉一条(喂人造源码),免得它哪天静默变空、永远绿。
 *
 * 给链接页面加一条新调用:先写进页面,这里会红着告诉你去 routes.ts 开哪一行(并写理由)。
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LINK_ROUTES, PHONE_ROUTES } from '../src/features/phone/phone-routes'
import { pageHtml } from '../src/features/phone/settings-panel-html'
import { assembleMobilePage } from '../apps/mobile/assemble'
import { readMobileSource } from '../apps/mobile/sources'
import { compareLinkScope, DEVICE_ONLY_MARK, ScanError, scanAtLeast, scanSource, type ScannedCall } from './link-routes-scan'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8')

/** 内联进传输层的协议包(压缩过的 noble)不是页面逻辑,扫它只会撞上 `q(` 之类的短变量名。找不到就红,别悄悄扫进去。 */
function withoutProtocolBundle(name: string, text: string): string {
  const bundle = read('apps', 'mobile', 'src', 'protocol-generated.js')
  const n = text.split(bundle).length - 1
  if (n !== 1) throw new Error(`${name}: 内联的协议包应该恰好出现 1 次,实际 ${n} 次(传输层的组装方式变了?)`)
  return text.replace(bundle, () => '')
}

/**
 * 拿链接令牌建连的 TS 代码(App 配对、`wechat-cc selftest phone`)只扫「用链接令牌建连」到「换成设备令牌」之间那一段;
 * 之后的 `dev.request` / `deviceClient.request` 用的是设备令牌,不算。写法变了找不到这一段 ⇒ 红。
 */
function linkSection(file: string, open: string, end: string): string {
  const src = read(...file.split('/'))
  const start = src.indexOf(open), stop = src.indexOf(end, start)
  if (start < 0 || stop < 0) throw new Error(`${file}: 找不到链接令牌那一段(${open} … ${end}),写法变了`)
  const section = src.slice(start, stop)
  assertLinkClientUsesOnly(section, file)
  return section
}

/**
 * 段内的 linkClient 只许三种用法:声明(`linkClient = …`)、`.request(`、`.close(`。
 * 传给别的函数(`pairOnce(linkClient)`)、存进变量、解构 —— 那里面的调用扫不到,守卫就会瞎,所以一律当认不出的形状(#519 评审)。
 */
export function assertLinkClientUsesOnly(section: string, where: string): void {
  for (const m of section.matchAll(/\blinkClient\b/g)) {
    const after = section.slice(m.index! + 'linkClient'.length)
    if (/^\s*=(?!=)/.test(after) || /^\.(request|close)\(/.test(after)) continue
    const line = section.slice(0, m.index!).split('\n').length
    throw new Error(`${where}: 链接令牌段第 ${line} 行 linkClient 的用法认不出(只许 .request( / .close( / 声明);传给别的函数会让守卫扫不到里面的调用`)
  }
}

/** 读 `.linkToken` 的源码文件就这两份;别处也拿链接令牌建连 ⇒ 红,把那一处加进 SOURCES。 */
const LINK_TOKEN_USERS = ['apps/app/src/net/pairing.ts', 'src/cli/selftest-phone.ts']
function linkTokenUsers(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(rel) }
      else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) && /\.linkToken\b/.test(read(...rel.split('/')))) out.push(rel)
    }
  }
  for (const d of ['src', 'apps/app/src', 'apps/desktop/src']) walk(d)
  return out.sort()
}

/** 每份源码至少要扫出这么多次调用;少了说明扫描器认不出新写法、在空转。 */
const SOURCES: ReadonlyArray<{ name: string; text: () => string; min: number }> = [
  { name: 'phone /m', text: () => withoutProtocolBundle('phone /m', assembleMobilePage(readMobileSource).phone), min: 5 },
  { name: 'settings /set', text: () => withoutProtocolBundle('settings /set', pageHtml('tFIXTURE')), min: 3 },
  { name: 'relay pset', text: () => read('relay', 'pset.src.html'), min: 1 },
  { name: 'app pairing', text: () => linkSection('apps/app/src/net/pairing.ts', 'const linkClient = deps.connect(link.relayUrl, link.linkToken)', 'linkClient.close()'), min: 1 },
  { name: 'selftest phone', text: () => linkSection('src/cli/selftest-phone.ts', 'linkClient = deps.connect(relayWsUrl, cls.link.linkToken)', 'deviceClient = deps.connect('), min: 1 },
]

function scanAll(): ScannedCall[] {
  return SOURCES.flatMap(s => scanAtLeast(s.name, s.text(), PHONE_ROUTES, s.min).calls)
}

describe('链接令牌的范围 = 链接页面调用的路由(理念 2)', () => {
  it('拿链接令牌建连的 TS 代码只有登记过的这几份', () => {
    expect(linkTokenUsers()).toEqual(LINK_TOKEN_USERS)
  })
  it('每份链接页面都扫得出调用,而且形状全认得', () => {
    const calls = scanAll()
    expect(calls.length).toBeGreaterThanOrEqual(10)
    for (const s of SOURCES) expect(calls.some(c => c.source === s.name), s.name).toBe(true)
  })
  it('LINK_ROUTES 与扫出来的集合相等', () => {
    expect(compareLinkScope(scanAll(), LINK_ROUTES)).toEqual([])
  })
  it('现在的链接范围(看得见的一份;改了页面就会跟着动)', () => {
    const bySource = Object.fromEntries(SOURCES.map(s => [s.name, [...new Set(scanAll().filter(c => c.source === s.name && !c.deviceOnly).map(c => c.key))].sort()]))
    expect(bySource).toEqual({
      'phone /m': ['GET /m/api/art/presence', 'GET /m/api/home', 'GET /m/api/matter', 'GET /m/api/matters', 'GET /set', 'POST /m/api/matter/stop', 'POST /set/api/pair'],
      'settings /set': ['GET /m', 'GET /set/api/state', 'POST /set/api/apply'],
      'relay pset': ['GET /m'],
      'app pairing': ['POST /set/api/pair'],
      'selftest phone': ['POST /set/api/pair'],
    })
    expect(scanAll().filter(c => c.deviceOnly)).toEqual([])
  })
})

describe('扫描器的失败方式(人造源码)', () => {
  const T = PHONE_ROUTES
  const keys = (src: string) => scanSource('fixture', src, T).calls.map(c => `${c.deviceOnly ? '[device] ' : ''}${c.key}`)
  it('认得各种调用形状:字面量、拼接、模板串、前缀路由、方法、封装', () => {
    expect(keys(`api("/m/api/home"); mApi('/m/api/matter?id='+id); sapi("/set/api/state"); sapi("/set/api/apply", {op:1})`))
      .toEqual(['GET /m/api/home', 'GET /m/api/matter', 'GET /set/api/state', 'POST /set/api/apply'])
    expect(keys('mPostOnce(`/m/api/matter/stop`, {method:"POST", body:x}); fetch(`/m/api/sticker/${n}`); ccNav("/set")'))
      .toEqual(['POST /m/api/matter/stop', 'GET /m/api/sticker/', 'GET /set'])
    expect(keys(`function api(path, opts) { return fetch(q(path), opts) }`)).toEqual([])
    expect(keys(`linkClient.request({ method: 'POST', path: '/set/api/pair', body: '{}' })`)).toEqual(['POST /set/api/pair'])
  })
  it('注释里的路径不算调用', () => {
    expect(keys(`// api("/m/api/chat")\n/* api("/m/api/memory") */ <!-- api("/m/api/today") -->api("/m/api/home")`)).toEqual(['GET /m/api/home'])
  })
  it('device-only 标记:紧跟调用的不计入链接集合;悬空的标记报错', () => {
    expect(keys(`if (isDevice) ${DEVICE_ONLY_MARK} api("/m/api/chat")`)).toEqual(['[device] GET /m/api/chat'])
    expect(compareLinkScope(scanSource('f', `${DEVICE_ONLY_MARK} api("/m/api/chat")`, T).calls, new Set())).toEqual([])
    expect(() => keys(`${DEVICE_ONLY_MARK} var x = 1; api("/m/api/home")`)).toThrow(ScanError)
  })
  it('认不出的形状报错:路径先放进变量、方法不是字面量、不是面板路由', () => {
    expect(() => keys(`var p = "/m/api/chat"; api(p)`)).toThrow(/认不出的调用形状/)
    expect(() => keys(`api("/m/api/seen", { method: m })`)).toThrow(/认不出请求方法/)
    expect(() => keys(`fetch("https://example.com/x")`)).toThrow(/不是面板路由/)
    expect(() => keys(`linkClient.request(opts)`)).toThrow(/linkClient/)
    // 链接令牌段里 linkClient 只许 .request( / .close( / 声明(#519 评审)
    expect(() => assertLinkClientUsesOnly(`const linkClient = deps.connect(a, b)\nawait linkClient.request({ method: 'POST', path: '/set/api/pair' })\nlinkClient.close()`, 't')).not.toThrow()
    expect(() => assertLinkClientUsesOnly(`const linkClient = deps.connect(a, b)\nawait pairOnce(linkClient)`, 't')).toThrow(/认不出/)
    expect(() => assertLinkClientUsesOnly(`const linkClient = deps.connect(a, b)\nconst c = linkClient`, 't')).toThrow(/认不出/)
  })
  it('对不上路由表的调用报错(拼错 / 方法不对 / 拼接却没有前缀路由)', () => {
    expect(() => keys(`api("/m/api/nope")`)).toThrow(/对不上路由表/)
    expect(() => keys(`api("/m/api/home", { method: "POST" })`)).toThrow(/对不上路由表/)
    expect(() => keys(`api("/m/api/matter/" + id)`)).toThrow(/对不上路由表/)
  })
  it('规则两个方向都红:多开的链接路由、页面调了只给设备的路由', () => {
    const calls = scanSource('f', `api("/m/api/home")`, T).calls
    expect(compareLinkScope(calls, new Set(['GET /m/api/home', 'GET /m/api/today']))).toEqual([expect.stringMatching(/^GET \/m\/api\/today:.*收成 link:'none'/)])
    expect(compareLinkScope(calls, new Set())).toEqual([expect.stringMatching(/^GET \/m\/api\/home:.*403/)])
  })
  it('扫出来太少就红(扫描器空转不能算过)', () => {
    expect(() => scanAtLeast('f', `api("/m/api/home")`, T, 5)).toThrow(/只扫出 1 次调用/)
    expect(() => scanAtLeast('f', 'var x = 1', T, 1)).toThrow(/只扫出 0 次调用/)
  })
})

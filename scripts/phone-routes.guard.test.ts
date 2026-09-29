/**
 * 手机面板路由的**接缝守卫**(梳理第 6 步,2026-09-29)。
 *
 * 面板的令牌带 routeAllow(`src/daemon/phone-routes.ts` 的 PHONE_ROUTES);路由本身写在
 * `settings-panel.ts` 的 routeRequest 与 `mobile-workbench.ts` 里。两边各写各的,漏登记的
 * 症状是「新加的手机功能一律 403 route_not_allowed」。这里从源码抓 `url.pathname === '…'`
 * 与 `startsWith('…')` 字面量,和集合的路径双向比对。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PHONE_ROUTES, PHONE_TOPICS, phoneTopicAllowed } from '../src/daemon/phone-routes'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8')

/** 从 `name` 之后的第一个 `{` 起按花括号配对截函数体(不靠行尾,CRLF 安全)。 */
function body(src: string, name: string): string {
  const start = src.indexOf(name)
  if (start < 0) throw new Error(`找不到 ${name}`)
  const open = src.indexOf('{', start)
  let depth = 0, end = open
  for (; end < src.length; end++) {
    if (src[end] === '{') depth++
    else if (src[end] === '}') { depth--; if (depth === 0) break }
  }
  return src.slice(open, end + 1)
}

const TOKENLESS = new Set(['/m/icon.png', '/m/manifest.json', '/m/sw.js'])

function sourcePaths(): Set<string> {
  const panel = body(read('src', 'daemon', 'settings-panel.ts'), 'async function routeRequest(')
  const mobile = read('src', 'daemon', 'mobile-workbench.ts')
  const out = new Set<string>()
  for (const src of [panel, mobile]) {
    for (const m of src.matchAll(/pathname\s*===\s*'(\/[^']*)'/g)) if (!TOKENLESS.has(m[1]!)) out.add(m[1]!)
    for (const m of src.matchAll(/pathname\.startsWith\(\s*'(\/[^']*)'\s*\)/g)) out.add(m[1]!)
  }
  return out
}

const registered = new Set([...PHONE_ROUTES].map(k => k.slice(k.indexOf(' ') + 1)))
const diff = (a: Set<string>, b: Set<string>) => [...a].filter(k => !b.has(k)).sort()

describe('手机面板路由与 PHONE_ROUTES 对得上', () => {
  const src = sourcePaths()
  it('真的抓到了东西(抓空 = 守卫沉默)', () => {
    expect(src.size).toBeGreaterThanOrEqual(20)
  })
  it('源码里每条带令牌的路由都登记了', () => {
    expect(diff(src, registered)).toEqual([])
  })
  it('登记的每条源码里都有(没有多余的)', () => {
    expect(diff(registered, src)).toEqual([])
  })
  it('CRLF 下抓到的一样', () => {
    const panel = read('src', 'daemon', 'settings-panel.ts').replace(/\r?\n/g, '\r\n')
    expect(body(panel, 'async function routeRequest(').length).toBeGreaterThan(1000)
  })
})

/**
 * 事件主题(第 9 步,`src/daemon/phone-events.ts` 的 `subscribe`)的双向核对:
 * `PHONE_TOPICS` 里的每个名字都要被 `phoneTopicAllowed` 接受,几个有代表性的坏主题
 * 都要被拒。"每个主题都有登记的来源、每个来源都对得上主题" 是第 11 步真来源接上
 * 之后才有意义的交叉核对(来源注册在那一步才存在),不在这里做。
 */
describe('PHONE_TOPICS 与 phoneTopicAllowed 对得上', () => {
  it('PHONE_TOPICS 里的每个主题名都被接受', () => {
    for (const topic of PHONE_TOPICS) {
      // 'matter/' 本身是前缀标记,不是一个可订阅的主题名 —— 得跟上合法 id 才行。
      if (topic === 'matter/') {
        expect(phoneTopicAllowed(`${topic}sample-id`)).toBe(true)
        continue
      }
      expect(phoneTopicAllowed(topic)).toBe(true)
    }
  })
  it('有代表性的坏主题都被拒', () => {
    for (const bad of ['matter/', 'matter/../x', 'unknown', '', 'Home', 'matter/a b']) {
      expect(phoneTopicAllowed(bad)).toBe(false)
    }
  })
})

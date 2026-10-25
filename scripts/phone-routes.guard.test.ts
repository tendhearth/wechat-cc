/**
 * 手机面板路由的**接缝守卫**(梳理第 6 步,2026-09-29;F2 起对着处理器表核对)。
 *
 * 面板的令牌带 routeAllow(`src/daemon/phone-routes.ts` 的 PHONE_ROUTES,从路由表 ROUTES 推出来);处理器登记在
 * `settings-panel.ts` 合成的那张 `"METHOD /path"` 表里(面板自己几条 + 各 mobile-*.ts 导出的表)。两边各写各的,
 * 漏登记的症状是「新加的手机功能一律 403 route_not_allowed」或「在册却 404」。这里拿真表的键和路由表双向比 ——
 * 方法也比(以前从源码抓路径字面量,只比得了路径)。
 */
import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROUTES } from '@wechat-cc/protocol/routes'
import { PHONE_ROUTES, PHONE_TOPICS, phoneTopicAllowed } from '../src/daemon/phone-routes'
import { makePhoneTopicSources } from '../src/daemon/phone-topic-sources'
import { makeSettingsPanel } from '../src/daemon/settings-panel'

const diff = (a: Iterable<string>, b: ReadonlySet<string>) => [...a].filter(k => !b.has(k)).sort()

describe('手机面板处理器表与路由表对得上', () => {
  // 只取表的键,不发请求:依赖给最小的空壳,状态目录用临时的(构造时会读设备登记)
  const stateDir = mkdtempSync(join(tmpdir(), 'phone-routes-guard-'))
  afterAll(() => rmSync(stateDir, { recursive: true, force: true }))
  const panel = makeSettingsPanel({
    stateDir, ownerChatId: () => null, chatPrefs: { get: () => ({}), set: () => ({}) },
    getUserName: () => null, setUserName: async () => {}, log: () => {},
  })
  const keys = new Set(panel.routeKeys())
  /** 路由表里属于面板的路径(/m、/m/…、/set、/set/…),不管带没带 phone / set 块。 */
  const panelPaths = new Set(Object.keys(ROUTES).filter(k => / \/(m|set)(\/|$)/.test(k)))
  it('真的拿到了东西(拿空 = 守卫沉默)', () => {
    expect(keys.size).toBeGreaterThanOrEqual(60)
  })
  it('表里每个键都在路由表里,而且是面板路由', () => {
    expect(diff(keys, new Set(Object.keys(ROUTES)))).toEqual([])
    expect(diff(keys, PHONE_ROUTES)).toEqual([])
  })
  it('路由表里每条面板路由都有处理器(没有登记了却 404 的)', () => {
    expect(diff(PHONE_ROUTES, keys)).toEqual([])
    expect(diff(panelPaths, keys)).toEqual([])
  })
})

/**
 * 事件主题(第 9 步,`src/daemon/phone-events.ts` 的 `subscribe`)的双向核对:
 * `PHONE_TOPICS` 里的每个名字都要被 `phoneTopicAllowed` 接受,几个有代表性的坏主题
 * 都要被拒。"每个主题都有登记的来源、每个来源都对得上主题" 在下一块(第 11 步真来源接上后)。
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

/**
 * 主题 ↔ 来源(第 11 步,`src/daemon/phone-topic-sources.ts`)的双向核对:在册的每个主题恰好
 * 一个来源认领(集线器按 find 取第一个,两个来源抢同一主题说明有一个永远不会被调用);每个
 * 来源至少认领一个在册主题(否则是死代码,或者主题忘了登记 ⇒ 手机订阅一律 topic_not_allowed)。
 * 只用 match(),不调 snapshot(),所以依赖给空壳就行。
 */
describe('PHONE_TOPICS 与手机事件来源对得上', () => {
  const sources = makePhoneTopicSources({ home: async () => { throw new Error('guard: 不该被调用') } })
  const samples = [...PHONE_TOPICS].map(t => (t.endsWith('/') ? `${t}abcd1234` : t))
  it('每个在册主题恰好一个来源', () => {
    for (const topic of samples) {
      expect(phoneTopicAllowed(topic)).toBe(true)
      expect(sources.filter(s => s.match(topic)).length, topic).toBe(1)
    }
  })
  it('每个来源至少认领一个在册主题', () => {
    for (const [i, source] of sources.entries()) {
      expect(samples.some(t => source.match(t)), `source #${i}`).toBe(true)
    }
  })
})

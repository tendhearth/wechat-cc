/**
 * P3d 纯改名的别名(wire-compat.ts 里 transform 为 null、已并的行):旧路径和新键是同一个处理器,回包逐字节一样。
 *
 * 金样(`src/daemon/__golden__/m-api-routes/`)只钉了 P3d 里的 art/presence、home、分块上传几条;这里对**每一行**纯改名
 * 用同一个面板、同一枚令牌各打一次旧路径和新路径,比状态码、content-type、cache-control 和正文字节。
 * 链接令牌:别名行冻结的 link 是 none 的,两条路都 403;是 read 的,两条路都放、回包一样。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WIRE_ROUTE_ALIASES } from '@wechat-cc/protocol'
import { removeTempDir } from '../../lib/test-temp'
import { makeSettingsPanel, type SettingsPanel } from './settings-panel'
import { mobileLettersRoutes } from '../letters'
import { mobileJobsRoutes } from '../jobs'

const OWNER = 'o9rename-owner@im.wechat'
const RENAMES = WIRE_ROUTE_ALIASES.filter(r => r.handler === 'alias' && r.transform === null)
/** 每条路径带一份像样的查询 / 正文,让处理器走到它真正的分支(不只是 400)。 */
const QUERY: Record<string, string> = {
  '/v1/matter/insight': 'id=deadbeef&lang=zh', '/v1/matter/input-receipt': 'id=deadbeef&requestId=11111111-1111-4111-8111-111111111111',
  '/v1/home': 'limit=5', '/v1/cli/activity': 'session_id=s1', '/v1/activity': 'limit=2', '/v1/letters/page': 'id=2026-10-01-abcdef&p=1',
}
const BODY: Record<string, unknown> = {
  '/v1/phone/push/register': { platform: 'apns', token: 'ab'.repeat(32) }, '/v1/phone/push/test': {}, '/v1/jobs/action': { id: 'j1', action: 'pause' },
}

let dir = ''
let panel: SettingsPanel
let device = ''

async function call(path: string, method: string, token: string, body?: unknown) {
  const sep = path.includes('?') ? '&' : '?'
  const res = await panel.handleRequest(new Request(`http://phone.test${path}${sep}d=${encodeURIComponent(token)}`, {
    method, ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
  }))
  return { status: res.status, type: res.headers.get('content-type'), cache: res.headers.get('cache-control'), bytes: Buffer.from(await res.arrayBuffer()).toString('base64') }
}
const pathOf = (key: string) => key.slice(key.indexOf(' ') + 1)
const methodOf = (key: string) => key.slice(0, key.indexOf(' '))
const target = (key: string) => {
  const p = pathOf(key), q = QUERY[p]
  return q ? `${p}?${q}` : p
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'legacy-renames-'))
  panel = makeSettingsPanel({
    stateDir: dir, ownerChatId: () => OWNER, chatPrefs: { get: () => ({}), set: () => ({}) },
    getUserName: () => '大人', setUserName: async () => {}, log: () => {}, now: () => Date.UTC(2026, 10, 5),
    insight: { forMatter: async () => ({ explanations: {}, progress: null }) },
    activity: { sources: () => ({}), now: () => Date.UTC(2026, 10, 5) },
    push: { register: () => true, unregister: () => {}, forgetAll: () => {}, test: async () => ({ ok: false, code: 'relay_offline' }) },
    featureRoutes: [
      mobileLettersRoutes({ list: () => [{ id: '2026-10-01-abcdef', day: '2026-10-01', sentAt: 1, requested: false, via: 'wechat', opening: '开头', pages: 0, text: '信' }], pagePath: () => null }),
      mobileJobsRoutes({ view: () => ({ ok: true, timezone: 'Asia/Shanghai', executor: 'claude', jobs: [] }), action: () => ({ ok: false, error: 'not_found' }) }),
    ],
  })
  const link = panel.issueToken()
  const paired = await (await panel.handleRequest(new Request(`http://phone.test/set/api/pair?t=${link}`, { method: 'POST' }))).json() as { device_token: string }
  device = paired.device_token
})
afterEach(async () => { await panel.stop(); removeTempDir(dir) })

describe('P3d 纯改名:旧路径与新键逐字节一样', () => {
  it('别名表里纯改名、已并的行不是空的(这条测试不空转)', () => {
    expect(RENAMES.length).toBeGreaterThanOrEqual(13)
  })

  it('设备令牌:每一行旧路径 / 新路径的状态码、头、正文字节都一样', async () => {
    let ok = 0
    for (const r of RENAMES) {
      const m = methodOf(r.from), body = m === 'POST' ? (BODY[pathOf(r.to)] ?? {}) : undefined
      const suffix = pathOf(r.to).endsWith('/') ? 'x.png' : ''
      const query = QUERY[pathOf(r.to)] ? `?${QUERY[pathOf(r.to)]}` : ''
      const oldRes = await call(pathOf(r.from) + suffix + query, m, device, body)
      const newRes = await call(pathOf(r.to) + suffix + query, m, device, body)
      expect(newRes, `${r.from} → ${r.to}`).toEqual(oldRes)
      expect(oldRes.status, `${r.from}:令牌门放过去了`).not.toBe(403)
      if (oldRes.status === 200) ok++
    }
    // 不全是「没接上」:有真回包的那几条也比过了
    expect(ok).toBeGreaterThanOrEqual(6)
  })

  it('方法不对:旧路径和新路径落到同一个结果(处理器自己判方法的回 405,不判的是面板的 404)', async () => {
    for (const r of RENAMES) {
      const wrong = methodOf(r.from) === 'GET' ? 'POST' : 'GET'
      if (WIRE_ROUTE_ALIASES.some(x => pathOf(x.from) === pathOf(r.from) && methodOf(x.from) === wrong)) continue
      const suffix = pathOf(r.to).endsWith('/') ? 'x.png' : ''
      expect(await call(pathOf(r.to) + suffix, wrong, device, wrong === 'POST' ? {} : undefined), r.from)
        .toEqual(await call(pathOf(r.from) + suffix, wrong, device, wrong === 'POST' ? {} : undefined))
    }
  })

  it('链接令牌:别名行冻结的 link 是 none ⇒ 两条路都 403;是 read ⇒ 两条路都放、回包一样', async () => {
    for (const r of RENAMES) {
      const link = panel.issueToken()
      const m = methodOf(r.from), body = m === 'POST' ? (BODY[pathOf(r.to)] ?? {}) : undefined
      const query = QUERY[pathOf(r.to)] ? `?${QUERY[pathOf(r.to)]}` : ''
      const oldRes = await call(pathOf(r.from) + query, m, link, body)
      const newRes = await call(target(r.to), m, link, body)
      if (r.link === 'none') {
        expect(oldRes.status, r.from).toBe(403)
        expect(newRes.status, r.to).toBe(403)
      } else {
        expect(oldRes.status, r.from).not.toBe(403)
        expect(newRes, r.to).toEqual(oldRes)
      }
    }
  })
})

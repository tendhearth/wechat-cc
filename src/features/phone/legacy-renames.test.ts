/**
 * P3d 纯改名的别名(wire-compat.ts 里 transform 为 null、已并的行):旧路径和新键是同一个处理器,回包逐字节一样。
 *
 * 金样(`src/daemon/__golden__/m-api-routes/`)只钉了 P3d 里的 art/presence、home、分块上传几条;这里对**每一行**纯改名
 * 用同一个面板、同一枚令牌各打一次旧路径和新路径,比状态码、content-type、cache-control 和正文字节。
 * 链接令牌:别名行冻结的 link 是 none 的,两条路都 403;是 read 的,两条路都放、回包一样。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WIRE_ROUTE_ALIASES } from '@wechat-cc/protocol'
import { removeTempDir } from '../../lib/test-temp'
import { makeSettingsPanel, type SettingsPanel } from './settings-panel'
import { mobileLettersRoutes } from '../letters'
import { mobileJobsRoutes } from '../jobs'
import { memoryPhoneRoutes } from '../memory'
import { stickerPhoneRoutes } from '../stickers'
import { terminalPhoneRoutes } from '../terminal'

const OWNER = 'o9rename-owner@im.wechat'
const RENAMES = WIRE_ROUTE_ALIASES.filter(r => r.handler === 'alias' && r.transform === null)
/** 每条路径带一份像样的查询 / 正文,让处理器走到它真正的分支(不只是 400)。 */
const QUERY: Record<string, string> = {
  '/v1/matter/insight': 'id=deadbeef&lang=zh', '/v1/matter/input-receipt': 'id=deadbeef&requestId=11111111-1111-4111-8111-111111111111',
  '/v1/home': 'limit=5', '/v1/cli/activity': 'session_id=s1', '/v1/activity': 'limit=2', '/v1/letters/page': 'id=2026-10-01-abcdef&p=1',
  '/v1/matter/owner-chat/page': 'before=2026-11-05T00:00:00.000Z', '/v1/matter/owner-chat/voice': 'id=m1&i=0', '/v1/stickers/file/': 'b64=1',
  '/v1/workbench/session/continue': 'key=eyJ2IjoxfQ', '/v1/workbench/attachment/upload': 'id=66666666-6666-4666-8666-666666666666&draftId=55555555-5555-4555-8555-555555555555',
}
/** 前缀键(表情一族)后面接的那一段。 */
const SUFFIX: Record<string, string> = { '/v1/stickers/file/': 'bear.png' }
const BODY: Record<string, unknown> = {
  '/v1/phone/push/register': { platform: 'apns', token: 'ab'.repeat(32) }, '/v1/phone/push/test': {}, '/v1/jobs/action': { id: 'j1', action: 'pause' },
  '/v1/matter/owner-chat/model': { provider: 'claude', model: null }, '/v1/memory/correct': { id: 'abcd', verdict: 'wrong' },
  '/v1/matter/owner-chat/say': { text: '在吗', requestId: '22222222-2222-4222-8222-222222222222' }, '/v1/workbench/session/continue': { key: 'eyJ2IjoxfQ' },
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

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'legacy-renames-'))
  mkdirSync(join(dir, 'stickers'))
  writeFileSync(join(dir, 'stickers', 'bear.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]))
  panel = makeSettingsPanel({
    stateDir: dir, ownerChatId: () => OWNER, chatPrefs: { get: () => ({}), set: () => ({}) },
    getUserName: () => '大人', setUserName: async () => {}, log: () => {}, now: () => Date.UTC(2026, 10, 5),
    insight: { forMatter: async () => ({ explanations: {}, progress: null }) },
    activity: { sources: () => ({}), now: () => Date.UTC(2026, 10, 5) },
    push: { register: () => true, unregister: () => {}, forgetAll: () => {}, test: async () => ({ ok: false, code: 'relay_offline' }) },
    featureRoutes: [
      // 表情原图(二进制回包)和 ?b64=1 两种都比;记忆读一份固定的;终端那三条没接 cliActions(503,两边一样)
      stickerPhoneRoutes({ list: () => [{ file: 'bear.png' }], dir: join(dir, 'stickers') }),
      memoryPhoneRoutes({ curated: () => ({ updated_at: null, when_label: null, mood: 'first', failures: 0, changes: [], sections: [] }) }),
      terminalPhoneRoutes({}),
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
    expect(RENAMES.length).toBeGreaterThanOrEqual(28)
  })

  it('设备令牌:每一行旧路径 / 新路径的状态码、头、正文字节都一样', async () => {
    let ok = 0
    for (const r of RENAMES) {
      const m = methodOf(r.from), body = m === 'POST' ? (BODY[pathOf(r.to)] ?? {}) : undefined
      const suffix = SUFFIX[pathOf(r.to)] ?? ''
      const query = QUERY[pathOf(r.to)] ? `?${QUERY[pathOf(r.to)]}` : ''
      const oldRes = await call(pathOf(r.from) + suffix + query, m, device, body)
      const newRes = await call(pathOf(r.to) + suffix + query, m, device, body)
      expect(newRes, `${r.from} → ${r.to}`).toEqual(oldRes)
      expect(oldRes.status, `${r.from}:令牌门放过去了`).not.toBe(403)
      if (oldRes.status === 200) ok++
    }
    // 不全是「没接上」:有真回包的那几条也比过了
    expect(ok).toBeGreaterThanOrEqual(8)
  })

  it('前缀键(表情):原图二进制、?b64=1、不在库里的名字、绕出目录的名字,旧前缀和新前缀一样', async () => {
    const raw = await call('/v1/stickers/file/bear.png', 'GET', device)
    expect(raw.status).toBe(200)
    expect(raw.type).toBe('image/png')
    expect(Buffer.from(raw.bytes, 'base64')).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]))
    for (const tail of ['bear.png', 'bear.png?b64=1', 'nope.png', '..%2Fbear.png', 'a%2Fbear.png']) {
      const fresh = await call(`/v1/stickers/file/${tail}`, 'GET', device)
      expect(await call(`/m/api/sticker/${tail}`, 'GET', device), tail).toEqual(fresh)
    }
    expect((await call('/v1/stickers/file/nope.png', 'GET', device)).status).toBe(404)
  })

  it('方法不对:旧路径和新路径落到同一个结果(处理器自己判方法的回 405,不判的是面板的 404)', async () => {
    for (const r of RENAMES) {
      const wrong = methodOf(r.from) === 'GET' ? 'POST' : 'GET'
      if (WIRE_ROUTE_ALIASES.some(x => pathOf(x.from) === pathOf(r.from) && methodOf(x.from) === wrong)) continue
      const suffix = SUFFIX[pathOf(r.to)] ?? ''
      expect(await call(pathOf(r.to) + suffix, wrong, device, wrong === 'POST' ? {} : undefined), r.from)
        .toEqual(await call(pathOf(r.from) + suffix, wrong, device, wrong === 'POST' ? {} : undefined))
    }
  })

  it('链接令牌:别名行冻结的 link 是 none ⇒ 两条路都 403;是 read ⇒ 两条路都放、回包一样', async () => {
    for (const r of RENAMES) {
      const link = panel.issueToken()
      const m = methodOf(r.from), body = m === 'POST' ? (BODY[pathOf(r.to)] ?? {}) : undefined
      const query = QUERY[pathOf(r.to)] ? `?${QUERY[pathOf(r.to)]}` : ''
      const suffix = SUFFIX[pathOf(r.to)] ?? ''
      const oldRes = await call(pathOf(r.from) + suffix + query, m, link, body)
      const newRes = await call(pathOf(r.to) + suffix + query, m, link, body)
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

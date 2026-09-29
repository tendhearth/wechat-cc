import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { removeTempDir } from '../lib/test-temp'
import { makeTokenRegistry } from './internal-api/token-registry'
import { deviceSessionKey, makeDeviceCredentials, makeDeviceStore } from './device-store'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) removeTempDir(d) })
const stateDir = () => { const d = mkdtempSync(join(tmpdir(), 'device-store-')); dirs.push(d); return d }
const file = (d: string) => join(d, 'settings-devices.json')
const idOf = (tok: string) => createHash('sha256').update(tok).digest('hex').slice(0, 8)

describe('makeDeviceStore', () => {
  it('旧格式 {token:{created_at}} 原地升级:补 id、last_seen_at = created_at,老令牌照认', () => {
    const d = stateDir(), tok = 'd' + 'a'.repeat(48)
    writeFileSync(file(d), JSON.stringify({ [tok]: { created_at: '2026-09-01T00:00:00.000Z' } }))
    const s = makeDeviceStore(d)
    expect(s.list()).toEqual([{ id: idOf(tok), created_at: '2026-09-01T00:00:00.000Z', last_seen_at: '2026-09-01T00:00:00.000Z' }])
    expect(s.idOf(tok)).toBe(idOf(tok))
    expect(s.tokens()).toEqual([tok])
    expect(JSON.parse(readFileSync(file(d), 'utf8'))[tok].id).toBe(idOf(tok))
  })

  it('pair:d + 48 hex,0600,上限 20', () => {
    const d = stateDir(), s = makeDeviceStore(d)
    const first = s.pair()!
    expect(first.token).toMatch(/^d[0-9a-f]{48}$/)
    expect(first.id).toBe(idOf(first.token))
    if (process.platform !== 'win32') expect(statSync(file(d)).mode & 0o777).toBe(0o600)
    for (let i = 1; i < 20; i++) expect(s.pair()).not.toBeNull()
    expect(s.pair()).toBeNull()
  })

  it('revoke 返回被删的 token;不存在的 id ⇒ null', () => {
    const s = makeDeviceStore(stateDir())
    const a = s.pair()!, b = s.pair()!
    expect(s.revoke(a.id)).toBe(a.token)
    expect(s.revoke('ffffffff')).toBeNull()
    expect(s.tokens()).toEqual([b.token])
  })

  it('touch 同一台 5 分钟内只写一次盘', () => {
    let now = Date.parse('2026-09-29T00:00:00Z')
    const d = stateDir(), s = makeDeviceStore(d, () => now)
    const a = s.pair()!
    now += 60_000; s.touch(a.id)
    const seen1 = s.list()[0]!.last_seen_at
    expect(seen1).toBe(new Date(now).toISOString())
    now += 60_000; s.touch(a.id)
    expect(JSON.parse(readFileSync(file(d), 'utf8'))[a.token].last_seen_at).toBe(seen1)
    now += 5 * 60_000; s.touch(a.id)
    expect(JSON.parse(readFileSync(file(d), 'utf8'))[a.token].last_seen_at).toBe(new Date(now).toISOString())
  })

  it('label:去控制字符、首尾空白,最多 24 字;空串删标签;不存在的 id ⇒ false', () => {
    const s = makeDeviceStore(stateDir()), a = s.pair()!
    expect(s.label(a.id, '  我的\u0007手机  ')).toBe(true)
    expect(s.list()[0]!.label).toBe('我的手机')
    s.label(a.id, '长'.repeat(30))
    expect(s.list()[0]!.label).toBe('长'.repeat(24))
    s.label(a.id, '   ')
    expect(s.list()[0]!.label).toBeUndefined()
    expect(s.label('ffffffff', 'x')).toBe(false)
  })

  it('文件坏了 ⇒ 当作没有设备,不抛', () => {
    const d = stateDir(); writeFileSync(file(d), '{not json')
    expect(makeDeviceStore(d).list()).toEqual([])
  })
})

describe('makeDeviceCredentials', () => {
  const ROUTES = new Set(['GET /m'])
  const setup = () => {
    const d = stateDir(), tokens = makeTokenRegistry()
    const store = makeDeviceStore(d)
    return { d, tokens, store, creds: makeDeviceCredentials({ store, tokens, routeAllow: ROUTES }) }
  }

  it('bootRegister:文件里每台都进注册表,origin device、sessionKey device:<id>', () => {
    const { d, tokens } = setup()
    const tok = 'd' + 'b'.repeat(48)
    writeFileSync(file(d), JSON.stringify({ [tok]: { created_at: '2026-09-01T00:00:00.000Z' } }))
    const creds = makeDeviceCredentials({ store: makeDeviceStore(d), tokens, routeAllow: ROUTES })
    creds.bootRegister()
    expect(tokens.resolve(tok)).toMatchObject({ tier: 'admin', origin: 'device', sessionKey: deviceSessionKey(idOf(tok)), routeAllow: ROUTES })
  })

  it('pair 同时写文件与注册表;revoke 只撤那一台', () => {
    const { tokens, creds } = setup()
    const a = creds.pair()!, b = creds.pair()!
    expect(tokens.resolve(a.token)?.origin).toBe('device')
    expect(creds.revoke(a.id)).toBe(true)
    expect(tokens.resolve(a.token)).toBeNull()
    expect(tokens.resolve(b.token)?.origin).toBe('device')
    expect(creds.tokens()).toEqual([b.token])
    expect(creds.revoke(a.id)).toBe(false)
  })

  it('forgetAll:文件清空、注册表里每台都失效', () => {
    const { tokens, creds } = setup()
    const a = creds.pair()!, b = creds.pair()!
    creds.forgetAll()
    expect(tokens.resolve(a.token)).toBeNull()
    expect(tokens.resolve(b.token)).toBeNull()
    expect(creds.list()).toEqual([])
  })
})

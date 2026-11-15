/**
 * 分享一件事给合伙人,从令牌到回包整条:真库、真分享域、真面板。
 * 守的是三件事:分享令牌只到得了那一个只读出口;撤销 / 过期 / 归档立即生效;回包里没有编号和本机路径。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from '../../lib/db'
import { makeWorkbenchStore } from '../../adapters/store/workbench/store'
import { makeShareDomain } from '../workbench/service/share'
import { SHARE_TTL_MS } from '../../domain/matters/share-scope'
import { makeTokenRegistry } from '../../daemon/internal-api/token-registry'
import { makeSettingsPanel } from './settings-panel'
import { phoneRoutes } from './routes'

const OWNER = 'owner@im.wechat', REMOTE = { relay: 'wss://relay.test/v2/phone', id: 'r' + 'a2'.repeat(13) }
let dir: string, db: Db, clock: number

function setup(over: { remote?: typeof REMOTE | null } = {}) {
  const store = makeWorkbenchStore(db)
  const ctx = { store, state: { runsByTask: new Map() }, deps: { ownerChatId: () => OWNER }, now: () => clock }
  const domain = makeShareDomain(ctx as never, { view: { phaseOf: (task: { status: string }) => task.status === 'completed' ? 'replied' : 'working' } as never })
  const tokens = makeTokenRegistry()
  const panel = makeSettingsPanel({
    stateDir: dir, ownerChatId: () => OWNER, chatPrefs: { get: () => ({}), set: (_c, p) => p }, getUserName: () => null, setUserName: async () => {}, log: () => {},
    tokens, now: () => clock, relayV2Configured: () => true, remote: { isEnabled: () => true, setEnabled: () => {}, requestRestart: () => {} },
    remoteInfo: () => over.remote === undefined ? REMOTE : over.remote,
    shares: { create: domain.shareCreate, view: domain.shareView, tokens: domain.shareTokens, valid: domain.shareTokenValid },
  })
  const task = store.create({ title: '登录页插图', path: '/Users/someone/work/site', providerId: 'codex', ownerChatId: OWNER })
  const get = (path: string, token: string, init?: RequestInit) => panel.handleRequest(new Request(`http://127.0.0.1${path}${path.includes('?') ? '&' : '?'}d=${token}`, init))
  return { store, domain, panel, tokens, task, get }
}
const tokenOf = (url: string) => /&t=(s[a-f0-9]{64})&/.exec(url)![1]!

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'share-panel-')); db = openDb({ path: ':memory:' }); clock = 1_800_000_000_000 })
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

describe('分享一件事给合伙人', () => {
  it('主人开链接 ⇒ 合伙人凭它读到这件事;回包里没有编号、没有本机路径', async () => {
    const f = setup()
    const made = f.panel.shareLink(f.task.id, ' 小林 ')
    if (!made.ok) throw Error('expected a link')
    expect(made.url).toMatch(/^https:\/\/relay\.test\/pset\/#id=r(?:a2){13}&t=s[a-f0-9]{64}&p=%2Fshare$/)
    expect(JSON.stringify(made.share)).not.toContain(tokenOf(made.url))
    const res = await f.get('/share/state', tokenOf(made.url))
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const text = await res.text(), body = JSON.parse(text)
    expect(body).toMatchObject({ ok: true, v: 1, name: '小林', expiresAt: clock + SHARE_TTL_MS, matter: { title: '登录页插图', legs: [{ position: 1, executor: 'codex' }] } })
    expect(text).not.toContain(f.task.id)
    expect(text).not.toContain('/Users/')
    expect(text).not.toContain(OWNER)
    expect(f.domain.shareList(f.task.id)[0]!.lastOpenedAt).toBe(clock)
    // 那一页本身:只给有效的链接,页面里没有这件事的任何内容,也没有令牌。
    const page = await f.get('/share', tokenOf(made.url)), html = await page.text()
    expect([page.status, page.headers.get('content-type')]).toEqual([200, 'text/html; charset=utf-8'])
    expect(html).toContain('请你看看这件事')
    expect(html).not.toContain('登录页插图')
    expect(html).not.toContain(tokenOf(made.url))
    expect((await f.get('/share', 's' + '0'.repeat(64))).status).toBe(401)
  })

  it('分享令牌只到得了那一个出口:别的路径、别的方法一律 401,令牌登记处里也没有它', async () => {
    const f = setup()
    const made = f.panel.shareLink(f.task.id, '小林')
    if (!made.ok) throw Error('expected a link')
    const token = tokenOf(made.url)
    expect(f.tokens.resolve(token)).toBeNull()
    expect(f.panel.validToken(token)).toBe(false)
    for (const path of ['/v1/matters', `/v1/matter?id=${f.task.id}`, '/v1/home', '/v1/phone/state', '/m/api/matters', '/set', '/set/api/state', '/share/', '/share/x', '/share/state/x', '/share/state/']) {
      expect([path, (await f.get(path, token)).status]).toEqual([path, 401])
    }
    expect((await f.get('/share/state', token, { method: 'POST', body: '{}' })).status).toBe(401)
    // 同一个请求里又带一枚设备 / 链接令牌:d 是分享令牌就只走分享出口,拿不到主人的东西。
    const link = f.panel.issueToken()
    expect((await f.panel.handleRequest(new Request(`http://127.0.0.1/set/api/state?d=${token}&t=${link}`))).status).toBe(401)
    expect((await f.panel.handleRequest(new Request(`http://127.0.0.1/share/state?t=${token}`))).status).toBe(200)
    // 请求里点名别的事也没用:看哪一件由分享记录定。
    const other = f.store.create({ title: '别的事', path: '/Users/someone/work/other', providerId: 'claude', ownerChatId: OWNER })
    const named = await (await f.get(`/share/state?matter=${other.id}&id=${other.id}`, token)).json() as { matter: { title: string } }
    expect(named.matter.title).toBe('登录页插图')
  })

  it('乱写的、撤销的、过期的、已归档的、不是主人名下的:都是同一个 401', async () => {
    const f = setup()
    const link = () => { const made = f.panel.shareLink(f.task.id, '小林'); if (!made.ok) throw Error('expected a link'); return { token: tokenOf(made.url), id: made.share.id } }
    const denied = async (token: string) => { const res = await f.get('/share/state', token); return [res.status, await res.json()] }
    const DENIED = [401, { error: 'unauthorized' }]
    expect(await denied('s' + '0'.repeat(64))).toEqual(DENIED)

    const revoked = link(), kept = link()
    expect(f.domain.shareRevoke(f.task.id, revoked.id)).toBe(true)
    expect(await denied(revoked.token)).toEqual(DENIED)
    expect(f.panel.shareTokens()).toEqual([kept.token])
    expect(f.panel.shareTokenValid(revoked.token)).toBe(false)
    expect((await f.get('/share/state', kept.token)).status).toBe(200)

    db.query("UPDATE workbench_tasks SET status='completed' WHERE id=?").run(f.task.id)
    f.store.setArchived(f.task.id, true)
    expect(await denied(kept.token)).toEqual(DENIED)
    expect(f.panel.shareTokenValid(kept.token)).toBe(false)
    expect(() => f.domain.shareCreate(f.task.id, '阿伟')).toThrow('matter_archived')
    f.store.setArchived(f.task.id, false)

    clock += SHARE_TTL_MS
    expect(await denied(kept.token)).toEqual(DENIED)
    expect(f.panel.shareTokens()).toEqual([])

    // 开出去之后这件事不再是主人名下的 ⇒ 链接失效。
    clock -= SHARE_TTL_MS
    const moved = f.store.create({ title: '后来转走的事', path: '/work/m', providerId: 'codex', ownerChatId: OWNER })
    const movedLink = f.panel.shareLink(moved.id, '小林')
    if (!movedLink.ok) throw Error('expected a link')
    expect((await f.get('/share/state', tokenOf(movedLink.url))).status).toBe(200)
    db.query('UPDATE workbench_tasks SET owner_chat_id=? WHERE id=?').run('guest@im.wechat', moved.id)
    expect(await denied(tokenOf(movedLink.url))).toEqual(DENIED)

    const theirs = f.store.create({ title: '访客的事', path: '/work/x', providerId: 'codex', ownerChatId: 'guest@im.wechat' })
    expect(() => f.domain.shareCreate(theirs.id, '小林')).toThrow('matter_not_found')
    expect(() => f.domain.shareList(theirs.id)).toThrow('matter_not_found')
    expect(() => f.domain.shareCreate('deadbeef', '小林')).toThrow('matter_not_found')
  })

  it('中继没就绪不开链接,也不留下记录', () => {
    const f = setup({ remote: null })
    expect(f.panel.shareLink(f.task.id, '小林')).toEqual({ ok: false, error: 'share_relay_not_ready', state: 'starting' })
    expect(f.domain.shareList(f.task.id)).toEqual([])
  })
})

describe('主人侧三条路由', () => {
  const q = new URLSearchParams()
  const share = { link: () => ({ ok: false as const, error: 'share_relay_not_ready' as const, state: 'remote_off' as const }), list: () => { throw Error('matter_not_found') }, revoke: () => true }
  const routes = phoneRoutes({ phoneConnect: () => ({ link: async () => ({ ok: false as const, state: 'starting' as const }), devices: () => [], share }) })
  const OPERATOR = { tier: 'admin' as const, origin: 'operator' as const }

  it('只认桌面的 operator 凭据:主人的聊天会话、手机设备、链接都不行', async () => {
    for (const caller of [{ tier: 'admin', origin: 'session', chatId: OWNER }, { tier: 'admin', origin: 'device' }, { tier: 'admin', origin: 'link' }, { tier: 'trusted', origin: 'file' }, undefined]) {
      expect((await routes['POST /v1/matter/share']!(q, { matter: 'aaaaaaaa', name: '小林' }, caller as never)).status).toBe(403)
      expect((await routes['GET /v1/matter/shares']!(new URLSearchParams('matter=aaaaaaaa'), undefined, caller as never)).status).toBe(403)
      expect((await routes['POST /v1/matter/share/revoke']!(q, { matter: 'aaaaaaaa', id: 'bbbbbbbbbbbb' }, caller as never)).status).toBe(403)
    }
  })
  it('说得清为什么没开成', async () => {
    expect(await routes['POST /v1/matter/share']!(q, { matter: 'aaaaaaaa', name: '小林' }, OPERATOR as never)).toEqual({ status: 409, body: { error: 'share_relay_not_ready', state: 'remote_off' } })
    expect(await routes['GET /v1/matter/shares']!(new URLSearchParams('matter=aaaaaaaa'), undefined, OPERATOR as never)).toEqual({ status: 404, body: { error: 'matter_not_found' } })
    expect(await routes['POST /v1/matter/share/revoke']!(q, { matter: 'aaaaaaaa', id: 'bbbbbbbbbbbb' }, OPERATOR as never)).toEqual({ status: 200, body: { revoked: true } })
  })
})

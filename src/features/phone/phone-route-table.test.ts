import { describe, it, expect } from 'vitest'
import { combinePhoneRoutes, lookupPhoneRoute, ownsMethod, routePhone, sharedRoute } from './phone-route-table'

const ok = (tag: string) => () => new Response(tag)
const call = async (table: Parameters<typeof routePhone>[0], method: string, path: string) => {
  const r = await routePhone(table, new URL('http://x' + path), new Request('http://x' + path, { method }))
  return r ? await r.text() : null
}

// 键用路由表里真有的(F3 起表的键是 PanelRouteKey,编造的键编译不过)
describe('手机处理器表', () => {
  it('同一个键登记两次 ⇒ 合表时抛,不悄悄盖掉', () => {
    expect(() => combinePhoneRoutes({ 'GET /m/api/chat/model': ok('1') }, { 'GET /m/api/chat/model': ok('2') })).toThrow(/GET \/m\/api\/chat\/model/)
    expect(Object.keys(combinePhoneRoutes({ 'GET /m/api/chat/model': ok('1') }, { 'POST /m/api/chat/model': ok('2') }))).toEqual(['GET /m/api/chat/model', 'POST /m/api/chat/model'])
  })
  it('精确键;方法不对且没 ownsMethod ⇒ 查不到(面板回 404)', async () => {
    const t = { 'GET /m/api/chat/model': ok('a') }
    expect(await call(t, 'GET', '/m/api/chat/model')).toBe('a')
    expect(await call(t, 'POST', '/m/api/chat/model')).toBeNull()
    expect(await call(t, 'GET', '/m/api/memory')).toBeNull()
  })
  it('ownsMethod:方法不对也交给它(由它自己回 405)', async () => {
    const h = ownsMethod((_u: URL, req: Request) => new Response(req.method === 'GET' ? 'a' : '405'))
    expect(await call({ 'GET /m/api/chat/model': h }, 'DELETE', '/m/api/chat/model')).toBe('405')
  })
  it('以 / 结尾的键是前缀:要同方法、路径更长;精确命中前缀本身也算', async () => {
    const t = { 'GET /m/api/sticker/': ok('s') }
    expect(await call(t, 'GET', '/m/api/sticker/x.png')).toBe('s')
    expect(await call(t, 'GET', '/m/api/sticker/')).toBe('s')
    expect(await call(t, 'POST', '/m/api/sticker/x.png')).toBeNull()
    expect(lookupPhoneRoute(t, 'GET', '/m/api/stickerx')).toBeNull()
  })
  it('sharedRoute:一条路径几个方法同一个处理器', () => {
    const h = ok('x')
    expect(sharedRoute(['GET', 'POST'], '/m/api/chat/model', h)).toEqual({ 'GET /m/api/chat/model': h, 'POST /m/api/chat/model': h })
  })
})

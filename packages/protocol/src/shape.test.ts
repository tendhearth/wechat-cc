import { describe, it, expect } from 'vitest'
import * as s from './shape'
import { ClientHello, ServerHello, ReqMsg, V2ClientMessage, V2ServerMessage, SealedV2Frame } from './messages'

describe('shape:消息校验器(代替 zod,见文件头)', () => {
  it('object 只留声明过的键;optional 缺省 / undefined 都行;类型不对就失败', () => {
    const O = s.object({ a: s.string(), b: s.optional(s.int()) })
    expect(O.parse({ a: 'x', extra: 1 })).toEqual({ a: 'x' })
    expect(O.parse({ a: 'x', b: undefined })).toEqual({ a: 'x' })
    expect(O.parse({ a: 'x', b: 3 })).toEqual({ a: 'x', b: 3 })
    for (const bad of [null, [], 'x', { a: 1 }, { a: 'x', b: 1.5 }, { a: 'x', b: '3' }]) expect(O.safeParse(bad).success).toBe(false)
    expect(() => O.parse({ a: 1 })).toThrow(s.ShapeError)
  })
  it('int / string 的下限,literal、oneOf、union、record、array', () => {
    expect(s.int({ min: 0 }).safeParse(-1).success).toBe(false)
    expect(s.int().safeParse(Number.NaN).success).toBe(false)
    expect(s.int().safeParse(Infinity).success).toBe(false)
    // 同 zod v4 的 .int():超出安全整数范围的不算整数(1e21 / 1e300 在 JS 里 isInteger 为真)
    for (const big of [1e21, 1e300, -1e300, Number.MAX_SAFE_INTEGER + 1]) expect(s.int().safeParse(big).success, String(big)).toBe(false)
    expect(s.int().parse(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER)
    expect(s.string({ min: 1 }).safeParse('').success).toBe(false)
    expect(s.oneOf(['utf8', 'base64']).safeParse('hex').success).toBe(false)
    expect(s.union(s.literal(1), s.literal(2)).parse(2)).toBe(2)
    expect(s.union(s.literal(1), s.literal(2)).safeParse(3).success).toBe(false)
    expect(s.record(s.string()).safeParse({ a: 1 }).success).toBe(false)
    expect(s.array(s.int()).parse([1, 2])).toEqual([1, 2])
    expect(s.array(s.int()).safeParse([1, 'x']).success).toBe(false)
  })
  it('判别联合按 t 挑分支,未知的 t / 缺字段都失败', () => {
    expect(V2ClientMessage.parse({ t: 'req', rid: 'r', method: 'GET', path: '/x', junk: 1 })).toEqual({ t: 'req', rid: 'r', method: 'GET', path: '/x' })
    expect(V2ClientMessage.safeParse({ t: 'res', rid: 'r' }).success).toBe(false)   // res 是后台 → 客户端
    expect(V2ClientMessage.safeParse({ t: 'sub', sid: 's' }).success).toBe(false)
    expect(V2ServerMessage.parse({ t: 'ev', sid: 's', epoch: 'e', seq: 0, data: { n: 1 } })).toMatchObject({ data: { n: 1 } })
    expect(V2ServerMessage.safeParse({ t: 'ev', sid: 's', epoch: 'e', seq: -1, data: 1 }).success).toBe(false)
    expect(V2ServerMessage.safeParse(null).success).toBe(false)
  })
  it('线上那几个明文帧', () => {
    expect(ClientHello.parse({ hs: 'k', v: [2], client: 'web' })).toEqual({ hs: 'k', v: [2], client: 'web' })
    expect(ClientHello.safeParse({ hs: 'k', client: 'app' }).success).toBe(false)
    expect(ServerHello.safeParse({ hs: '', v: 2 }).success).toBe(false)
    expect(ServerHello.safeParse({ hs: 42, v: 2 }).success).toBe(false)
    expect(SealedV2Frame.safeParse({ c: 0, ct: 'x' }).success).toBe(false)   // 计数器必须是字符串(v2.ts 的同一个洞)
    expect(ReqMsg.safeParse({ t: 'req', rid: '', method: 'GET', path: '/' }).success).toBe(false)
  })
})

/**
 * 桌面 / MCP 那一边(`/v1/*`)的契约(架构终态 F1):请求 / 响应的 zod 契约只在协议包里一份(`desktop-api.ts`),
 * 而且只能写给路由表里真有的路由 —— 契约表多出一条路由表里没有的键 ⇒ 要么路由改名了、要么写错了,都是漂移。
 * 还没写响应契约的路由有多少,这里打一行(F1 的「做完」是每条都有 res;数字只给人看,不当门)。
 */
import { describe, expect, it } from 'vitest'
import { ROUTES } from '@wechat-cc/protocol/routes'
import { REQUEST_SCHEMAS, RESPONSE_SCHEMAS } from '@wechat-cc/protocol/desktop-api'

const keys = new Set(Object.keys(ROUTES))

describe('桌面契约只写给路由表里有的路由', () => {
  it('REQUEST_SCHEMAS 的每个键都在路由表里', () => {
    expect(Object.keys(REQUEST_SCHEMAS).filter(k => !keys.has(k))).toEqual([])
  })
  it('RESPONSE_SCHEMAS 的每个键都在路由表里', () => {
    expect(Object.keys(RESPONSE_SCHEMAS).filter(k => !keys.has(k))).toEqual([])
  })
  it('(报数)/v1 路由里有响应契约的比例', () => {
    const v1 = [...keys].filter(k => / \/v1\//.test(k))
    const withRes = v1.filter(k => RESPONSE_SCHEMAS[k])
    console.log(`desktop contracts: ${withRes.length}/${v1.length} /v1 routes have a response schema`)
    expect(v1.length).toBeGreaterThan(0)
  })
})

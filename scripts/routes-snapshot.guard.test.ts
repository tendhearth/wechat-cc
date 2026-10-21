/**
 * 路由表的**行为快照**(重构第二批 5a,2026-10-20)。
 *
 * `fixtures/routes-snapshot-2026-10-20.json` 是改表之前 origin/dev(eb3c828c)上各份名单的原样:
 * 每条 /v1 路由的档位、各种令牌的 routeAllow(operator / 设备 / 链接 / federation / selftest)、
 * PHONE_ROUTES、LINK_READ_OK / LINK_WRITE_OK(连理由)、LINK_ROUTES、LAN_ONLY_OPS、PHONE_TOPICS,
 * 以及 lib.rs workbench_request_allowed 与 workbench-proxy.ts ROUTES 里解析出来的元组。
 *
 * 这里断言:只看快照里**已有的路由**,从路由表推出来的每一份和快照逐条相等(5a 提交时是整份相等,
 * 没有一条新路由)。于是:
 * - 新加一条路由不用碰快照(「加一行 + gen:routes」照旧成立);
 * - 已有路由的档位 / 令牌 / link 变了、或者被删了,这里红 —— 有意为之(比如 5b 收敛)就把快照里那一条
 *   一起改,并在 PR 里写明。
 * 快照不从表重新生成(那就是「实现验证实现」,永远绿)。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROUTE_MIN_TIER, routesForToken } from '../src/daemon/internal-api/route-tiers'
import { makeTokenRegistry } from '../src/daemon/internal-api/token-registry'
import { LAN_ONLY_OPS, LINK_READ_OK, LINK_ROUTES, LINK_WRITE_OK, PHONE_ROUTES, PHONE_TOPICS } from '../src/daemon/phone-routes'
import { WORKBENCH_ROUTES_JSON } from './gen-routes'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const snap = JSON.parse(readFileSync(join(ROOT, 'scripts', 'fixtures', 'routes-snapshot-2026-10-20.json'), 'utf8'))
const generated = JSON.parse(readFileSync(WORKBENCH_ROUTES_JSON, 'utf8')) as { tauri: string[]; devProxy: string[] }
/** 快照里出现过的路由;表里后来新加的不在这里,不参与比较。 */
const KNOWN: ReadonlySet<string> = new Set([...Object.keys(snap.ROUTE_MIN_TIER), ...snap.PHONE_ROUTES])
const sorted = (a: Iterable<string>) => [...a].filter(k => KNOWN.has(k)).sort()
const known = <T>(o: Readonly<Record<string, T>>) => Object.fromEntries(Object.entries(o).filter(([k]) => KNOWN.has(k)))

describe('从路由表推出来的名单与改造前快照逐条一致', () => {
  it('ROUTE_MIN_TIER(每条 /v1 路由的档位)', () => {
    expect(known(ROUTE_MIN_TIER)).toEqual(snap.ROUTE_MIN_TIER)
  })
  it('各种令牌的 routeAllow', () => {
    const reg = makeTokenRegistry(() => 'deadbeef'.repeat(8))
    reg.registerOperatorToken('op')
    expect({
      operator: sorted(reg.resolve('op')!.routeAllow!),
      device: sorted(PHONE_ROUTES),
      link: sorted(LINK_ROUTES),
      federation: sorted(routesForToken('federation')),
      selftest: sorted(routesForToken('selftest')),
    }).toEqual(snap.tokenAllow)
  })
  it('PHONE_ROUTES / LINK_ROUTES / LAN_ONLY_OPS / PHONE_TOPICS', () => {
    expect(sorted(PHONE_ROUTES)).toEqual(snap.PHONE_ROUTES)
    expect(sorted(LINK_ROUTES)).toEqual(snap.LINK_ROUTES)
    // 这两份不是路由:整份比
    expect([...LAN_ONLY_OPS].sort()).toEqual(snap.LAN_ONLY_OPS)
    expect([...PHONE_TOPICS].sort()).toEqual(snap.PHONE_TOPICS)
  })
  it('LINK_READ_OK / LINK_WRITE_OK 连理由逐字一致', () => {
    expect(known(LINK_READ_OK)).toEqual(snap.LINK_READ_OK)
    expect(known(LINK_WRITE_OK)).toEqual(snap.LINK_WRITE_OK)
  })
  it('lib.rs 与 dev 代理的放行名单(生成物)和改造前源码里的元组一致', () => {
    expect(sorted(generated.tauri)).toEqual(snap.tauriAllowed)
    expect(sorted(generated.devProxy)).toEqual(snap.devProxyRoutes)
  })
})

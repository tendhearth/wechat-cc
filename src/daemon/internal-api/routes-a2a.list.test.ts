/**
 * `GET /v1/a2a/list` 的投影必须带上信箱可达性。
 *
 * WHY(2026-09-01,Mac↔Windows 真机闭环时发现):这个投影只挑了
 * `id/name/url/paused/counts`。而**六位配对码建立的对端根本没有 url**
 * —— 它的可达性全在 `transport='mailbox'` + `mailbox_addr` + `relays` 里。
 * 于是仪表盘上一个完全正常的信箱对端显示成「有名字、没地址」,看起来像
 * 装坏了;想排查「它到底通不通」也无从下手。
 *
 * 换句话说:**投影是按 push 传输的假设写的,信箱传输加进来时没跟着长**。
 * 这个测试把「列表要暴露传输方式与信箱可达性」钉成契约,免得下次再加一种
 * 传输时又悄悄漏掉。
 */
import { describe, test, expect } from 'bun:test'
import { a2aRoutes } from './routes-a2a'
import type { InternalApiDeps } from './types'

const MAILBOX_PEER = {
  id: 'cc-dae1afe0',
  name: '煞笔',
  // 刻意没有 url —— 这正是配对码建立的对端的样子
  inbound_api_key: 'x'.repeat(16),
  outbound_api_key: 'y',
  capabilities: [],
  paused: false,
  transport: 'mailbox' as const,
  mailbox_addr: 'MCowBQYDK2VwAyEAOmw1Jrcc',
  mailbox_enc_pub: 'MCowBQYDK2VuAyEAaaaa',
  relays: ['https://cc.tendhearth.com/mailbox'],
}

function listBody() {
  const deps = {
    a2a: {
      registry: { list: () => [MAILBOX_PEER] },
      eventsStore: { counts: () => ({ in: 0, out: 1 }) },
    },
  } as unknown as InternalApiDeps
  const handler = a2aRoutes(deps)['GET /v1/a2a/list']!
  const res = handler({} as never, undefined as never) as { body: { agents: Record<string, unknown>[] } }
  return res.body.agents[0]!
}

describe('GET /v1/a2a/list 投影', () => {
  test('带出 transport,否则前端分不清 push 与 mailbox 对端', () => {
    expect(listBody().transport).toBe('mailbox')
  })

  test('带出 mailbox_addr 与 relays —— 无 url 对端的可达性全在这里', () => {
    const a = listBody()
    expect(a.mailbox_addr).toBe('MCowBQYDK2VwAyEAOmw1Jrcc')
    expect(a.relays).toEqual(['https://cc.tendhearth.com/mailbox'])
  })

  test('不泄露任何密钥字段', () => {
    const keys = Object.keys(listBody())
    expect(keys.filter(k => /api_key|enc_pub/.test(k))).toEqual([])
  })
})

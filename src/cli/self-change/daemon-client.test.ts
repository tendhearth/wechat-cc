import { describe, expect, it } from 'vitest'

import type { ApiInfo } from '../../lib/api-info'
import { makeDaemonClient } from './daemon-client'

const API: ApiInfo = {
  baseUrl: 'http://127.0.0.1:41234',
  token: 'file-token',
  operatorToken: 'operator-token',
  tokenFilePath: '/s/token',
  operatorTokenFilePath: '/s/operator-token',
}

interface Call { url: string; method: string; auth: string | undefined; body: unknown }

function harness(responses: Array<{ ok: boolean; status: number; body?: unknown }>, api: () => ApiInfo | null = () => API) {
  const calls: Call[] = []
  let reads = 0
  const fetchMock = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      auth: headers.authorization ?? headers.Authorization,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    })
    const r = responses.shift() ?? { ok: false, status: 500 }
    return { ok: r.ok, status: r.status, json: async () => r.body } as unknown as Response
  }) as unknown as typeof fetch
  const client = makeDaemonClient({ readApiInfo: () => { reads++; return api() }, fetch: fetchMock })
  return { calls, client, reads: () => reads }
}

describe('notice', () => {
  it('POST 到 notice 路由,带 operator token 与 { text }', async () => {
    const h = harness([{ ok: true, status: 200, body: { ok: true } }])
    expect(await h.client.notice('自改 #ab 开始')).toBe(true)
    expect(h.calls[0]).toMatchObject({
      url: 'http://127.0.0.1:41234/v1/self-change/notice',
      method: 'POST',
      auth: 'Bearer operator-token',
      body: { text: '自改 #ab 开始' },
    })
  })

  it('409 / 502 都只是「没送到」,不抛', async () => {
    const h = harness([{ ok: false, status: 409, body: { error: 'owner_chat_unknown' } }])
    expect(await h.client.notice('x')).toBe(false)
  })

  it('daemon 没在跑(读不到 api-info)⇒ false,一个请求都不发', async () => {
    const h = harness([], () => null)
    expect(await h.client.notice('x')).toBe(false)
    expect(h.calls).toHaveLength(0)
  })

  it('fetch 抛(daemon 正在重启)⇒ false', async () => {
    const client = makeDaemonClient({
      readApiInfo: () => API,
      fetch: (() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch,
    })
    expect(await client.notice('x')).toBe(false)
  })
})

describe('ask', () => {
  it('POST prompt + timeoutMs,回 { hash, code }', async () => {
    const h = harness([{ ok: true, status: 200, body: { hash: 'h1', code: '07' } }])
    expect(await h.client.ask('拍板卡', 3600_000)).toEqual({ hash: 'h1', code: '07' })
    expect(h.calls[0]).toMatchObject({
      url: 'http://127.0.0.1:41234/v1/self-change/ask',
      method: 'POST',
      auth: 'Bearer operator-token',
      body: { prompt: '拍板卡', timeoutMs: 3600_000 },
    })
  })

  it('code 可以是 null(只有一条待批时主人直接回 y)', async () => {
    const h = harness([{ ok: true, status: 200, body: { hash: 'h1', code: null } }])
    expect(await h.client.ask('x', 60_000)).toEqual({ hash: 'h1', code: null })
  })

  it('非 2xx ⇒ null', async () => {
    const h = harness([{ ok: false, status: 409, body: { error: 'owner_chat_unknown' } }])
    expect(await h.client.ask('x', 60_000)).toBeNull()
  })

  it('200 但没有 hash ⇒ null(不能拿一个假 hash 去轮询)', async () => {
    const h = harness([{ ok: true, status: 200, body: { code: '07' } }])
    expect(await h.client.ask('x', 60_000)).toBeNull()
  })
})

describe('decision', () => {
  it('hash 进 query,回的字符串原样给出', async () => {
    const h = harness([{ ok: true, status: 200, body: { decision: 'allow' } }])
    expect(await h.client.decision('h 1')).toBe('allow')
    expect(h.calls[0]!.url).toBe('http://127.0.0.1:41234/v1/self-change/decision?hash=h%201')
    expect(h.calls[0]!.method).toBe('GET')
    expect(h.calls[0]!.auth).toBe('Bearer operator-token')
  })

  it('不认识的值 / 非 2xx / 读不到 api-info 一律 unknown', async () => {
    expect(await harness([{ ok: true, status: 200, body: { decision: '???' } }]).client.decision('h')).toBe('unknown')
    expect(await harness([{ ok: false, status: 503 }]).client.decision('h')).toBe('unknown')
    expect(await harness([], () => null).client.decision('h')).toBe('unknown')
  })
})

describe('health', () => {
  it('用 file token 打 /v1/health —— operator token 根本够不着这条', async () => {
    const h = harness([{ ok: true, status: 200, body: { ok: true } }])
    expect(await h.client.health()).toBe(true)
    expect(h.calls[0]).toMatchObject({ url: 'http://127.0.0.1:41234/v1/health', method: 'GET', auth: 'Bearer file-token' })
  })

  it('daemon 没起 ⇒ false', async () => {
    expect(await harness([], () => null).client.health()).toBe(false)
  })
})

describe('api-info 的重读', () => {
  it('每次调用都重读一次(daemon 会在流水线中途被换掉、端口和钥匙都会变)', async () => {
    const h = harness([
      { ok: true, status: 200, body: { ok: true } },
      { ok: true, status: 200, body: { decision: 'pending' } },
      { ok: true, status: 200, body: { ok: true } },
    ])
    await h.client.notice('a')
    await h.client.decision('h')
    await h.client.health()
    expect(h.reads()).toBe(3)
  })
})

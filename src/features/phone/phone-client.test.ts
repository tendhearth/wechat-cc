import { describe, expect, it } from 'vitest'
import { currentPhoneClient, markAppRequest, phoneClientOf, surfaceOrigin, withPhoneClient } from './phone-client'

describe('phone client (2026-10-19: App vs browser, judged by transport only)', () => {
  it('only a Request the daemon marked on the v2 stream is the app; everything else — including a lookalike — is the browser', () => {
    const marked = markAppRequest(new Request('http://127.0.0.1/m/api/matter/create?_via=tunnel'))
    expect(phoneClientOf(marked)).toBe('app')
    // 同样的 URL / 请求头,不是 daemon 标过的那一个对象 ⇒ 浏览器
    const lookalike = new Request(marked.url, { headers: { 'x-cc-client': 'app', 'user-agent': 'TendhearthApp' } })
    expect(phoneClientOf(lookalike)).toBe('web')
    expect(phoneClientOf(marked.clone())).toBe('web')
  })

  it('the client sticks to the request handling, across awaits and the background work it starts; null outside', async () => {
    expect(currentPhoneClient()).toBeNull()
    let later: string | null = 'unset'
    let background!: Promise<void>
    const got = await withPhoneClient('app', async () => {
      await new Promise(r => setTimeout(r, 1))
      background = (async () => { await new Promise(r => setTimeout(r, 5)); later = currentPhoneClient() })()
      return currentPhoneClient()
    })
    expect(got).toBe('app')
    expect(currentPhoneClient()).toBeNull()
    await background
    expect(later).toBe('app')
    // 两个请求同时在处理,各是各的
    const [a, b] = await Promise.all([
      withPhoneClient('web', async () => { await new Promise(r => setTimeout(r, 3)); return currentPhoneClient() }),
      withPhoneClient('app', async () => { await new Promise(r => setTimeout(r, 1)); return currentPhoneClient() }),
    ])
    expect([a, b]).toEqual(['web', 'app'])
  })

  it('surface → origin: desktop is desktop; phone is whatever the current request says, unknown outside one', () => {
    expect(surfaceOrigin('desktop')).toBe('desktop')
    expect(surfaceOrigin('phone')).toBeNull()
    expect(withPhoneClient('web', () => surfaceOrigin('phone'))).toBe('web')
    expect(withPhoneClient('app', () => surfaceOrigin('desktop'))).toBe('desktop')
  })
})

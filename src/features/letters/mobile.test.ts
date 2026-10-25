import { describe, it, expect } from 'vitest'
import { mobileLettersRoutes, type MobileLettersDeps } from './mobile'
import { routePhone } from '../phone/phone-route-table'
import { framedTooLarge } from '../phone/mobile-matter-response'
import type { LetterListItem } from './archive'

const req = (path: string, method = 'GET') => { const url = new URL(`http://x${path}`); return { url, req: new Request(url, { method }) } }
const call = async (deps: MobileLettersDeps | undefined, path: string, method?: string) => {
  const r = req(path, method)
  return routePhone(mobileLettersRoutes(deps), r.url, r.req)
}
const item = (i: number, text?: string): LetterListItem => ({ id: `2026-10-${String(i).padStart(2, '0')}-abcdef`, day: '2026-10-01', sentAt: i, requested: false, via: 'wechat', opening: '开头', pages: text ? 0 : 1, ...(text ? { text } : {}) })

describe('mobileLettersRoutes', () => {
  it('不是自己的路径 ⇒ null;方法不对 ⇒ 405;没接 ⇒ 503', async () => {
    expect(await call(undefined, '/m/api/chat')).toBeNull()
    expect((await call(undefined, '/m/api/letters', 'POST'))!.status).toBe(405)
    expect((await call(undefined, '/m/api/letters'))!.status).toBe(503)
    expect((await call(undefined, '/m/api/letters/page?id=a&p=1'))!.status).toBe(503)
  })
  it('列表一帧装不下 ⇒ 从最旧那头少给,最新那封总在', async () => {
    const big = '字'.repeat(4000)
    const letters = Array.from({ length: 60 }, (_, i) => item(60 - i, big))
    const res = await call({ list: () => letters, pagePath: () => null }, '/m/api/letters')
    const body = await res!.text()
    expect(framedTooLarge(body)).toBe(false)
    const got = JSON.parse(body) as { letters: LetterListItem[] }
    expect(got.letters.length).toBeLessThan(60)
    expect(got.letters[0]!.id).toBe(letters[0]!.id)
  })
  it('取页参数坏了 ⇒ 400;取不到 ⇒ 404;list / pagePath 抛错 ⇒ 503', async () => {
    const deps: MobileLettersDeps = { list: () => { throw new Error('x') }, pagePath: () => { throw new Error('x') } }
    expect((await call(deps, '/m/api/letters'))!.status).toBe(503)
    expect((await call(deps, '/m/api/letters/page?id=a&p=1'))!.status).toBe(503)
    expect((await call(deps, '/m/api/letters/page?id=a'))!.status).toBe(400)
    expect((await call(deps, '/m/api/letters/page?id=a&p=1&offset=-1'))!.status).toBe(400)
    expect((await call({ list: () => [], pagePath: () => null }, '/m/api/letters/page?id=a&p=1'))!.status).toBe(404)
  })
})

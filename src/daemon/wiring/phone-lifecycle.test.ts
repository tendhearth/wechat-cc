import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { makePhoneLifecycle } from './phone-lifecycle'

describe('phone lifecycle(手机那一簇关机时停掉:隧道 / notifier / 订阅 / 设置面板)', () => {
  it('stops in the order things were added, once; a failing stop does not skip the rest', async () => {
    const order: string[] = []
    const logs: string[] = []
    const lc = makePhoneLifecycle((t, l) => logs.push(`${t} ${l}`))
    lc.add('tunnel', () => { order.push('tunnel') })
    lc.add('notifier', () => { throw new Error('boom') })
    lc.add('panel', async () => { order.push('panel') })
    await lc.stop(); await lc.stop()
    expect(order).toEqual(['tunnel', 'panel'])
    expect(logs.some(l => l.includes('notifier') && l.includes('boom'))).toBe(true)
  })
  it('something that only comes up after stop (the async tunnel import) is stopped right away instead of started', async () => {
    const lc = makePhoneLifecycle(() => {})
    await lc.stop()
    expect(lc.stopped()).toBe(true)
    let stopped = false
    lc.add('late tunnel', () => { stopped = true })
    expect(stopped).toBe(true)
  })
  it('main.ts registers the phone cluster BEFORE polling ⇒ reverse stop: inbound stops first, in-flight App replies still drain through the tunnel', () => {
    const src = readFileSync(join(__dirname, '..', 'main.ts'), 'utf8')
    const phone = src.indexOf("name: 'phone'")
    const polling = src.indexOf('registerPolling(')
    expect(phone).toBeGreaterThan(0)
    expect(polling).toBeGreaterThan(0)
    expect(phone).toBeLessThan(polling)
  })
})

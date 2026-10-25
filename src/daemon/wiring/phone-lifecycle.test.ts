import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { makePhoneLifecycle } from './phone-lifecycle'

describe('phone lifecycle(手机那一簇关机时停掉:隧道 / notifier / 订阅 / 设置面板)', () => {
  it('stops in a FIXED order regardless of when things were added (real boot: the panel is added synchronously, the tunnels only after the async import) — tunnels first, panel last', async () => {
    const order: string[] = []
    const lc = makePhoneLifecycle(() => {})
    lc.add('settings-panel', () => { order.push('settings-panel') })   // 同步,先到
    lc.add('phone-events', () => { order.push('phone-events') })
    lc.add('notifier', () => { order.push('notifier') })               // 异步 import 回来以后才到
    lc.add('v2-tunnel', () => { order.push('v2-tunnel') })
    lc.add('media-mirror', () => { order.push('media-mirror') })          // 媒体镜像的单槽回调最先放掉:不再往手机对话里记
    await lc.stop()
    expect(order).toEqual(['media-mirror', 'v2-tunnel', 'notifier', 'phone-events', 'settings-panel'])
  })
  it('stops once; a failing stop is logged and does not skip the rest', async () => {
    const order: string[] = []
    const logs: string[] = []
    const lc = makePhoneLifecycle((t, l) => logs.push(`${t} ${l}`))
    lc.add('settings-panel', async () => { order.push('settings-panel') })
    lc.add('notifier', () => { throw new Error('boom') })
    lc.add('v2-tunnel', () => { order.push('v2-tunnel') })
    await lc.stop(); await lc.stop()
    expect(order).toEqual(['v2-tunnel', 'settings-panel'])
    expect(logs.some(l => l.includes('notifier') && l.includes('boom'))).toBe(true)
  })
  it('something that only comes up after stop (the async tunnel import) is stopped right away instead of started', async () => {
    const lc = makePhoneLifecycle(() => {})
    await lc.stop()
    expect(lc.stopped()).toBe(true)
    let stopped = false
    lc.add('v2-tunnel', () => { stopped = true })
    expect(stopped).toBe(true)
  })
  it('the module table owns the phone cluster BEFORE polling ⇒ reverse stop: inbound stops first, in-flight App replies still drain through the tunnel', () => {
    // 关机顺序的全貌在 __e2e__/shutdown-order 的快照里;这一条只钉住「手机那一簇在拉消息之前登记」。
    const src = readFileSync(join(__dirname, '..', 'daemon-modules.ts'), 'utf8')
    const phone = src.indexOf("ctx.own('phone'")
    const polling = src.indexOf("lifecycleModule('polling'")
    expect(phone).toBeGreaterThan(0)
    expect(polling).toBeGreaterThan(0)
    expect(phone).toBeLessThan(polling)
  })
})

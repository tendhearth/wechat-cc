import { describe, it, expect } from 'vitest'
import { serve } from './http'

// 梳理第 6 步(2026-09-29):不传 hostname 时只听本机。今天所有调用方都显式传了,
// 改缺省是给以后的调用方兜底 —— 忘了写 hostname 不该默默对整个局域网开门。
describe('serve 的监听地址', () => {
  it('不传 hostname ⇒ 127.0.0.1', async () => {
    const s = serve({ port: 0, fetch: () => new Response('ok') })
    await s.ready
    try {
      expect(s.hostname).toBe('127.0.0.1')
      expect(await (await fetch(`http://127.0.0.1:${s.port}/`)).text()).toBe('ok')
    } finally { s.stop(true) }
  })
  it('显式传 0.0.0.0 照旧', async () => {
    const s = serve({ hostname: '0.0.0.0', port: 0, fetch: () => new Response('ok') })
    await s.ready
    try { expect(s.hostname).toBe('0.0.0.0') } finally { s.stop(true) }
  })
})

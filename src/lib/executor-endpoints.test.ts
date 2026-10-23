/**
 * 端点 host 一处声明(3c 第 4 步,2026-10-23):网络探测、调用分类(→ 网络守护)都从 executor-facts 取。
 * 以前三份里 agy 写成 cloudcode-pa / generativelanguage,cursor 探的是 cursor.com —— 真机抓包看到的不是这些。
 */
import { describe, it, expect } from 'vitest'
import { EXECUTOR_FACTS } from './executor-facts'
import { PROVIDER_IDS } from './provider-ids'
import { classifyCall } from './call-classifier'
import { endpointFor } from '../daemon/net-probe'

describe('executor endpoints: one declaration', () => {
  it('every executor declares a host and says how it is known', () => {
    for (const id of PROVIDER_IDS) {
      expect(EXECUTOR_FACTS[id].endpoint.host, id).toMatch(/^[a-z0-9.-]+\.[a-z]+$/)
      expect(EXECUTOR_FACTS[id].endpoint.source.length, id).toBeGreaterThan(0)
    }
  })
  it('the hosts captured on the real machine (2026-10-23) are the ones declared', () => {
    expect(EXECUTOR_FACTS.agy.endpoint.host).toBe('daily-cloudcode-pa.googleapis.com')
    expect(EXECUTOR_FACTS.cursor.endpoint.host).toBe('api2.cursor.sh')
  })
  it('the network probe and the call classifier both read it', () => {
    for (const id of PROVIDER_IDS) {
      const host = EXECUTOR_FACTS[id].endpoint.host
      expect(new URL(endpointFor(id)!.url).host, `probe ${id}`).toBe(host)
      // cursor 的分类按模型判、host 固定;其余没给 base URL ⇒ 官方默认端点
      expect(classifyCall({ provider: id }).host, `classifier ${id}`).toBe(host)
    }
  })
  it('agy and keyed Gemini are probed separately now that their hosts differ', () => {
    expect(endpointFor('agy')!.id).not.toBe(endpointFor('gemini')!.id)
  })
})

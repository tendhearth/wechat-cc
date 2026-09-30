import { describe, it, expect } from 'vitest'
import en from '../i18n/en'
import { linkErrorKey, makeGate, pairErrorKey } from './pair'

describe('配对错误 → 文案键', () => {
  it('每种链接错误、配对错误都有自己的一句话,键都在文案表里', () => {
    const keys = [
      ...(['not_a_link', 'remote_off', 'bad_link'] as const).map(linkErrorKey),
      ...(['expired', 'device_limit', 'offline', 'too_old', 'unknown'] as const).map(pairErrorKey),
    ]
    for (const k of keys) expect(en[k]).toBeTruthy()
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('配对单飞闸', () => {
  it('同一帧内第二次进入被挡;leave 后才能再进', () => {
    const g = makeGate()
    expect(g.enter()).toBe(true)
    expect(g.enter()).toBe(false)
    expect(g.busy()).toBe(true)
    g.leave()
    expect(g.busy()).toBe(false)
    expect(g.enter()).toBe(true)
  })
})

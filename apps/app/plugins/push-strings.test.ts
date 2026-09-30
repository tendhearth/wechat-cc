import { describe, it, expect } from 'vitest'
import { swiftSource, kotlinSource, loadStrings } from './push-strings'
import en from '../src/i18n/en'
import zh from '../src/i18n/zh-Hans'

describe('原生通知文案生成器', () => {
  it('两种语言键一致', () => {
    const s = loadStrings()
    expect(Object.keys(s['zh-Hans']).sort()).toEqual(Object.keys(s.en).sort())
  })
  it('Swift:enum PushStrings 的字典字面量;引号、反斜杠、换行转义', () => {
    const src = swiftSource({ en: { a: 'say "hi"\\\n' }, 'zh-Hans': { a: '中' } })
    expect(src).toContain('enum PushStrings')
    expect(src).toContain('"a": "say \\"hi\\"\\\\\\n"')
    expect(src).toContain('"zh-Hans": [')
  })
  it('Kotlin:object PushStrings 的 mapOf;$ 也转义', () => {
    const src = kotlinSource({ en: { a: 'cost $5 "x"' }, 'zh-Hans': { a: '中' } })
    expect(src).toContain('package com.tendhearth.app.push')
    expect(src).toContain('"a" to "cost \\$5 \\"x\\""')
  })
  it('安卓渠道名与 app 里建渠道用的 JS 文案一致(同一个渠道只能有一个名字)', () => {
    const s = loadStrings()
    expect(s.en['channel.decide']).toBe(en['push.channelDecide'])
    expect(s.en['channel.updates']).toBe(en['push.channelUpdates'])
    expect(s['zh-Hans']['channel.decide']).toBe(zh['push.channelDecide'])
    expect(s['zh-Hans']['channel.updates']).toBe(zh['push.channelUpdates'])
  })
})

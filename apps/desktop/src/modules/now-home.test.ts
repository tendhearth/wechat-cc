import { describe, it, expect } from 'vitest'
import { ccPresence, nowStatusLine } from './now-home.js'

describe('ccPresence', () => {
  const p = (presence: string) => ({ presence, activity: { kind: 'idle', label: '', since: null }, news: { unread: 0, latest_kind: null, latest_title: null } })
  it('拉到真数据就在身边(外发 offline 只影响微信,不变暗)', () => {
    for (const s of ['ok', 'degraded', 'offline']) expect(ccPresence(p(s))).toBe('here')
  })
  it('拉不到 / 还没拉 ⇒ 不在身边', () => { expect(ccPresence(p('down'))).toBe('away'); expect(ccPresence(null)).toBe('away') })
})
describe('nowStatusLine', () => {
  const p = (presence: string) => ({ presence })
  it('在家但不全好 ⇒ 黄点,说出是哪一类(2026-10-06;以前一律绿)', () => {
    expect(nowStatusLine({ alive: true }, p('offline'))).toEqual({ cls: 'warn', text: 'CC 在家 · 微信发不出去' })
    expect(nowStatusLine({ alive: true }, p('degraded'))).toEqual({ cls: 'warn', text: 'CC 在家 · 有功能没起来' })
    expect(nowStatusLine({ alive: true }, p('ok'))).toEqual({ cls: 'ok', text: 'CC 在家 · 运行中' })
  })
  it('presence 够不着 ⇒ 红点 + 不在身边,即使 doctor 说 daemon 活着(与 CC 变暗同一信号)', () => {
    expect(nowStatusLine({ alive: true }, p('down'))).toEqual({ cls: 'bad', text: 'CC 不在身边' })
  })
  it('还没拉到(doctor 或 presence 尚未第一拍)⇒ 灰点「正在连接…」,既不报绿也不报红', () => {
    expect(nowStatusLine(null, null)).toEqual({ cls: 'unknown', text: '正在连接…' })
    expect(nowStatusLine({ alive: true }, null)).toEqual({ cls: 'unknown', text: '正在连接…' })
    expect(nowStatusLine(null, p('ok'))).toEqual({ cls: 'unknown', text: '正在连接…' })
  })
  it('daemon 没跑 ⇒ 红', () => { expect(nowStatusLine({ alive: false }, p('ok'))).toEqual({ cls: 'bad', text: 'CC 没在运行' }) })
  it('两边都通才绿', () => { expect(nowStatusLine({ alive: true }, p('ok'))).toEqual({ cls: 'ok', text: 'CC 在家 · 运行中' }) })
})

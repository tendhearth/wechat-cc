import { describe, it, expect } from 'vitest'
import { discover, signatureOf, formatDiscover } from './self-discover'

const NOW = Date.parse('2026-10-23T20:00:00.000Z')
const at = (hAgo: number, rest: string) => `${new Date(NOW - hAgo * 3_600_000).toISOString()} ${rest}`
const base = { now: NOW, hours: 48, minCount: 3 }

describe('signatureOf', () => {
  it('抹掉会变的部分:聊天 id、wxid、十六进制 id、数字;同一类失败落到同一个签名', () => {
    const a = signatureOf('settlement backfill failed for wxid_kgzqqkcfrwzm22 (retry next cycle): Error: agy result status=ERROR')
    const b = signatureOf('settlement backfill failed for wxid_abc9 (retry next cycle): Error: agy result status=ERROR')
    expect(a).toBe(b)
    expect(signatureOf('chat=o9cq7sObd@im.wechat error=ilink/sendmessage errcode=-2: prepare failed')).toBe('chat=<chat> error=ilink/sendmessage errcode=-<n>: prepare failed')
    expect(signatureOf('c5aee7f6: recollect_ask_failed')).toBe('<id>: recollect_ask_failed')
  })
})

describe('discover', () => {
  it('按标签 + 签名分组数次数,次数多的在前;记首次 / 最近', () => {
    const log = [
      at(30, '[RETRY_FAIL] sendmessage gave up after 1 attempt(s): ilink/sendmessage errcode=-2: prepare failed'),
      at(20, '[INGEST] extract eval error, deferring batch {"c":"x","u":1}: Error: agy not currently available in your location'),
      at(10, '[RETRY_FAIL] sendmessage gave up after 1 attempt(s): ilink/sendmessage errcode=-2: prepare failed'),
      at(9, '[INGEST] extract eval error, deferring batch {"c":"y","u":2}: Error: agy not currently available in your location'),
      at(5, '[RETRY_FAIL] sendmessage gave up after 3 attempt(s): ilink/sendmessage errcode=-2: prepare failed'),
      at(4, '[INGEST] extract eval error, deferring batch {"c":"z","u":3}: Error: agy not currently available in your location'),
      at(1, '[RETRY_FAIL] sendmessage gave up after 1 attempt(s): ilink/sendmessage errcode=-2: prepare failed'),
    ].join('\n')
    const c = discover({ ...base, log })
    expect(c.map(x => [x.tag, x.count])).toEqual([['RETRY_FAIL', 4], ['INGEST', 3]])
    expect(c[0]!.firstSeen < c[0]!.lastSeen).toBe(true)
  })
  it('不是失败的行不收;窗口外的不收;次数不够的不收', () => {
    const log = [
      at(1, '[BOOT] started fine'), at(1, '[BOOT] started fine'), at(1, '[BOOT] started fine'),
      at(100, '[X] boom failed'), at(100, '[X] boom failed'), at(100, '[X] boom failed'),
      at(1, '[Y] once failed'), at(1, '[Y] once failed'),
    ].join('\n')
    expect(discover({ ...base, log })).toEqual([])
  })
  it('中文的失败说法也认', () => {
    const log = [1, 2, 3].map(h => at(h, '[GUARD] 网络守护:被拒')).join('\n')
    expect(discover({ ...base, log })[0]?.count).toBe(3)
  })
  it('人读版:没有就说没有;有就带次数和例子', () => {
    expect(formatDiscover([], 48)).toMatch(/没有/)
    const log = [1, 2, 3].map(h => at(h, '[A] x failed')).join('\n')
    expect(formatDiscover(discover({ ...base, log }), 48)).toMatch(/3 次 {2}\[A\]/)
  })
})

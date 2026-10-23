import { describe, it, expect } from 'vitest'
import { discover, signatureOf, formatDiscover, redact } from './self-discover'

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
  it('打印配置的那行(「超时 30000ms」「timeout=5s」)不算失败;真的超时了算', () => {
    const cfg = [1, 2, 3].map(h => at(h, '[BOOT] social: 披露闸门超时 30000ms(按实际 cheapEval provider 的延迟预算)')).join('\n')
    expect(discover({ ...base, log: cfg })).toEqual([])
    const real = [1, 2, 3].map(h => at(h, '[TURN] provider timed out after 60s')).join('\n')
    expect(discover({ ...base, log: real })[0]?.count).toBe(3)
  })

  it('中文的失败说法也认', () => {
    const log = [1, 2, 3].map(h => at(h, '[GUARD] 网络守护:被拒')).join('\n')
    expect(discover({ ...base, log })[0]?.count).toBe(3)
  })
  it('给了部署时刻 ⇒ 每类数「部署后还有几次」(0 多半是修好了),人读版也带上', () => {
    const log = [30, 20, 10, 2, 1].map(h => at(h, '[INGEST] agy not eligible failed')).join('\n')
    const c = discover({ ...base, log, deployedAt: NOW - 5 * 3_600_000 })
    expect(c[0]).toMatchObject({ count: 5, sinceDeploy: 2 })
    expect(formatDiscover(c, 48)).toContain('5 次(部署后 2)')
    expect(discover({ ...base, log })[0]!.sinceDeploy).toBeUndefined()
  })

  it('人读版:没有就说没有;有就带次数和例子', () => {
    expect(formatDiscover([], 48)).toMatch(/没有/)
    const log = [1, 2, 3].map(h => at(h, '[A] x failed')).join('\n')
    expect(formatDiscover(discover({ ...base, log }), 48)).toMatch(/3 次 {2}\[A\]/)
  })
})

describe('redact —— 例子交给模型之前抹掉人', () => {
  it('聊天 id、wxid、十六进制 id、text= 后面的正文抹掉;数字留着', () => {
    expect(redact('chat=o9cq800sObd3lbrHBgiItB1pooDQ@im.wechat error=errcode=-2 attempts=3')).toBe('chat=<chat> error=errcode=-2 attempts=3')
    expect(redact('backfill failed for wxid_kgzqqkcfrwzm21 batch 8209')).toBe('backfill failed for <wxid> batch 8209')
    expect(redact('send failed to=x text=今晚一起吃饭吗')).toBe('send failed to=x text=<略>')
    // 10-23 第一次真跑漏过:字母数字混排的联系人编号。
    expect(redact('settlement backfill failed for YWW100110221102 (retry next cycle)')).toBe('settlement backfill failed for <id> (retry next cycle)')
    expect(redact('{"c":"YWW100110221102","u":1,"l":8209}')).toBe('{"c":"<id>","u":1,"l":8209}')
    // 纯词、纯数字、短的版本号留着:例子还得看得懂。
    expect(redact('NetworkUnprotectedError errcode=-2 batch 8209 e373342')).toBe('NetworkUnprotectedError errcode=-2 batch 8209 e373342')
  })
  it('discover 的 example 是抹过的', () => {
    const NOW2 = Date.parse('2026-10-23T20:00:00.000Z')
    const log = [1, 2, 3].map(h => `${new Date(NOW2 - h * 3_600_000).toISOString()} [R] send failed chat=abc@im.wechat`).join('\n')
    expect(discover({ log, now: NOW2, hours: 48, minCount: 3 })[0]!.example).toBe('send failed chat=<chat>')
  })
})

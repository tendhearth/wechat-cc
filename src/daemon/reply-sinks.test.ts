import { describe, expect, it } from 'vitest'
import { makeReplySinks } from './reply-sinks'

describe('reply-sinks', () => {
  it('open then capture appends, close() returns the captured text', () => {
    const sinks = makeReplySinks()
    const handle = sinks.open('c1')
    expect(sinks.capture('c1', 'hello')).toBe(true)
    expect(handle.close()).toBe('hello')
  })

  it('two captures are newline-joined at close (bubble replies must not run together)', () => {
    const sinks = makeReplySinks()
    const handle = sinks.open('c1')
    expect(sinks.capture('c1', 'foo')).toBe(true)
    expect(sinks.capture('c1', 'bar')).toBe(true)
    expect(handle.close()).toBe('foo\nbar')
  })

  // 2026-10-02 手机真机验收:模型连调几次 reply,其中一次 text 为空,
  // 收口时 join 出一行空行,模型自己还解释「上面那条空的是误发」。
  it('blank captures are swallowed: claimed (not sent to WeChat) but never joined into the reply', () => {
    const sinks = makeReplySinks()
    const handle = sinks.open('c1')
    expect(sinks.capture('c1', 'foo')).toBe(true)
    expect(sinks.capture('c1', '')).toBe(true)
    expect(sinks.capture('c1', '  \n ')).toBe(true)
    expect(sinks.capture('c1', 'bar')).toBe(true)
    expect(handle.close()).toBe('foo\nbar')
  })

  it('capture with no open sink returns false', () => {
    const sinks = makeReplySinks()
    expect(sinks.capture('nope', 'text')).toBe(false)
  })

  it('open twice on the same chatId throws reply_sink_busy', () => {
    const sinks = makeReplySinks()
    sinks.open('c1')
    expect(() => sinks.open('c1')).toThrow('reply_sink_busy')
  })

  it('after close, capture on that chatId returns false (deregistered)', () => {
    const sinks = makeReplySinks()
    const handle = sinks.open('c1')
    sinks.capture('c1', 'x')
    handle.close()
    expect(sinks.capture('c1', 'y')).toBe(false)
  })

  it('close on an empty sink returns an empty string', () => {
    const sinks = makeReplySinks()
    const handle = sinks.open('c1')
    expect(handle.close()).toBe('')
  })

  it('capture/open are isolated across different chatIds', () => {
    const sinks = makeReplySinks()
    const h1 = sinks.open('c1')
    const h2 = sinks.open('c2')
    sinks.capture('c1', 'one')
    sinks.capture('c2', 'two')
    expect(h1.close()).toBe('one')
    expect(h2.close()).toBe('two')
    // c1's close deregistered only c1, not c2.
    expect(sinks.capture('c1', 'z')).toBe(false)
  })

  it('after close, the chatId can be re-opened', () => {
    const sinks = makeReplySinks()
    const h1 = sinks.open('c1')
    h1.close()
    const h2 = sinks.open('c1')
    expect(sinks.capture('c1', 'again')).toBe(true)
    expect(h2.close()).toBe('again')
  })

  // 回复交付(spec 2026-10-03 §4.3 第 2 步):新路径把整个 TurnReply 交给接收器 —— 文字照常拼进 close(),
  // 附件与旁白另外取(桌面 / 手机显示;语音 / 表情不再漏到微信)。
  it('captureReply:文字进 close(),附件与旁白从 extras() 取', () => {
    const sinks = makeReplySinks()
    const handle = sinks.open('c1')
    expect(sinks.isOpen?.('c1')).toBe(true)
    expect(sinks.captureReply?.('c1', { text: '晚安', silent: false, attachments: [{ kind: 'voice', text: '晚安' }], narration: ['看了下日程'] })).toBe(true)
    expect(handle.extras?.()).toEqual({ attachments: [{ kind: 'voice', text: '晚安' }], narration: ['看了下日程'] })
    expect(handle.close()).toBe('晚安')
    expect(sinks.isOpen?.('c1')).toBe(false)
  })

  it('captureReply:静默 / 空文字 ⇒ 认领,但 close() 是空串', () => {
    const sinks = makeReplySinks()
    const handle = sinks.open('c1')
    expect(sinks.captureReply?.('c1', { text: '', silent: true, attachments: [], narration: [] })).toBe(true)
    expect(handle.close()).toBe('')
  })

  it('captureReply 没开接收器 ⇒ false', () => {
    expect(makeReplySinks().captureReply?.('c1', { text: 'x', silent: false, attachments: [], narration: [] })).toBe(false)
  })
})

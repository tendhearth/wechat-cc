import { describe, expect, it } from 'vitest'
import { makeReplySinks } from './reply-sinks'

describe('reply-sinks', () => {
  it('open then capture appends, close() returns the captured text', () => {
    const sinks = makeReplySinks()
    const handle = sinks.open('c1')
    expect(sinks.capture('c1', 'hello')).toBe(true)
    expect(handle.close()).toBe('hello')
  })

  it('two captures concatenate before close', () => {
    const sinks = makeReplySinks()
    const handle = sinks.open('c1')
    expect(sinks.capture('c1', 'foo')).toBe(true)
    expect(sinks.capture('c1', 'bar')).toBe(true)
    expect(handle.close()).toBe('foobar')
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
})

import { describe, expect, it } from 'vitest'
import { ClaudeWorkbenchEvents } from './claude-workbench-events'

describe('Claude workbench event capacity', () => {
  it('fails at a bounded slow-reader backlog and keeps the public error observable', async () => {
    const stream = new ClaudeWorkbenchEvents(2, 1000)
    stream.push({ kind: 'text', text: 'one' }); stream.push({ kind: 'text', text: 'two' })
    expect(() => stream.push({ kind: 'text', text: 'three' })).toThrow('event_buffer_limit')
    stream.fail(new Error('bounded failure'))
    const events = []; for await (const event of stream) events.push(event)
    expect(events).toHaveLength(2)
    expect(events.at(-1)).toEqual({ kind: 'error', message: 'bounded failure' })
  })
  it('bounds buffered bytes as well as event count', async () => {
    const stream = new ClaudeWorkbenchEvents(100, 100)
    expect(() => stream.push({ kind: 'text', text: 'x'.repeat(101) })).toThrow('event_buffer_limit')
    stream.end()
    const iterator = stream[Symbol.asyncIterator]()
    expect(await iterator.next()).toEqual({ value: undefined, done: true })
  })
  it('releases abandoned backlog and rejects concurrent next calls', async () => {
    const stream = new ClaudeWorkbenchEvents(), iterator = stream[Symbol.asyncIterator]()
    const pending = iterator.next()
    await expect(iterator.next()).rejects.toThrow('concurrent_next')
    await iterator.return!()
    expect(await pending).toEqual({ value: undefined, done: true })
    expect(() => stream[Symbol.asyncIterator]()).toThrow('single_consumer')
  })
  it('always ends with a bounded error when the native failure exceeds the byte budget', async () => {
    const stream = new ClaudeWorkbenchEvents(5, 100)
    expect(() => stream.fail(new Error('界'.repeat(200)))).not.toThrow()
    const events = []; for await (const event of stream) events.push(event)
    expect(events).toHaveLength(1)
    expect(events[0]?.kind).toBe('error')
    expect(Buffer.byteLength(JSON.stringify(events[0]))).toBeLessThanOrEqual(100)
  })

})

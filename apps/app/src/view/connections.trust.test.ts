import { describe, expect, it } from 'vitest'
import { connectionsTrust, muteDots } from './connections'

describe('connectionsTrust', () => {
  it('没数据 ⇒ none', () => { expect(connectionsTrust({}, 'online')).toBe('none'); expect(connectionsTrust({ error: 'offline' }, 'online')).toBe('none') })
  it('有数据、无错、在线 ⇒ live', () => expect(connectionsTrust({ data: {} }, 'online')).toBe('live'))
  it('有数据但最近一次拉取失败 ⇒ stale(缓存的 ready 不能冒充现状)', () => expect(connectionsTrust({ data: {}, error: 'timeout' }, 'online')).toBe('stale'))
  it('有数据但没在线(离线 / 连接中 / 已撤销)⇒ stale', () => {
    for (const st of ['offline', 'connecting', 'revoked']) expect(connectionsTrust({ data: {} }, st)).toBe('stale')
  })
})
describe('muteDots', () => {
  it('所有圆点压成 unknown,文字不动', () => {
    const v = { headline: { dot: 'ok' as const, key: 'k' }, sources: [{ dot: 'ok' as const, label: 'a' }, { dot: 'bad' as const, label: 'b' }], computers: [{ dot: 'ok' as const, label: 'c' }] }
    const m = muteDots(v)
    expect([m.headline.dot, ...m.sources.map(x => x.dot), ...m.computers.map(x => x.dot)]).toEqual(['unknown', 'unknown', 'unknown', 'unknown'])
    expect(m.sources[1]!.label).toBe('b')
  })
})

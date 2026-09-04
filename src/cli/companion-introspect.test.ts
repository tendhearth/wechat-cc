import { describe, it, expect } from 'vitest'
import { requestIntrospectTick } from './companion-introspect'

describe('requestIntrospectTick', () => {
  it('reads server.pid and signals SIGUSR3', () => {
    const killed: Array<{ pid: number; sig: string }> = []
    const res = requestIntrospectTick({
      readPid: () => '7788\n',
      kill: (pid, sig) => killed.push({ pid, sig }),
    }, '/tmp/state')
    expect(res.pid).toBe(7788)
    expect(killed).toEqual([{ pid: 7788, sig: 'SIGWINCH' }])
  })

  it('throws when the daemon is not running here', () => {
    expect(() => requestIntrospectTick({ readPid: () => null, kill: () => {} }, '/tmp/state'))
      .toThrow(/没在本机运行/)
  })

  it('throws on an invalid pid', () => {
    expect(() => requestIntrospectTick({ readPid: () => 'garbage', kill: () => {} }, '/tmp/state'))
      .toThrow(/无效/)
  })
})

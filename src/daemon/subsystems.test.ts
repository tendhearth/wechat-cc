import { describe, it, expect } from 'vitest'
import { SubsystemSupervisor } from './subsystems'

const noopLog = () => {}

describe('SubsystemSupervisor', () => {
  it('value ⇒ ok, returns the value', async () => {
    const sup = new SubsystemSupervisor(noopLog)
    const v = await sup.start('a', () => ({ x: 1 }))
    expect(v).toEqual({ x: 1 })
    expect(sup.statuses()).toMatchObject([{ name: 'a', state: 'ok' }])
    expect(sup.statuses()[0]!.sinceIso).toMatch(/^\d{4}-/)
  })

  it('null/undefined ⇒ off, returns undefined', async () => {
    const sup = new SubsystemSupervisor(noopLog)
    expect(await sup.start('a', () => null)).toBeUndefined()
    expect(await sup.start('b', () => undefined)).toBeUndefined()
    expect(sup.statuses().map(s => s.state)).toEqual(['off', 'off'])
    expect(sup.degraded()).toEqual([])
  })

  it('sync throw and async reject ⇒ degraded with message only, never propagates', async () => {
    const lines: string[] = []
    const sup = new SubsystemSupervisor((tag, line) => lines.push(`${tag} ${line}`))
    expect(await sup.start('boom', () => { throw new Error('bind EADDRINUSE') })).toBeUndefined()
    expect(await sup.start('boom2', async () => { throw new Error('late') })).toBeUndefined()
    expect(sup.degraded()).toMatchObject([
      { name: 'boom', state: 'degraded', error: 'bind EADDRINUSE' },
      { name: 'boom2', state: 'degraded', error: 'late' },
    ])
    expect(lines.some(l => l.startsWith('SUBSYS') && l.includes('boom'))).toBe(true)
  })

  it('non-Error throw is stringified', async () => {
    const sup = new SubsystemSupervisor(noopLog)
    await sup.start('weird', () => { throw 'plain string' })
    expect(sup.degraded()[0]!.error).toBe('plain string')
  })

  it('duplicate start(name) throws — programming error, fail fast', async () => {
    const sup = new SubsystemSupervisor(noopLog)
    await sup.start('dup', () => 1)
    await expect(sup.start('dup', () => 2)).rejects.toThrow(/duplicate/)
  })
})

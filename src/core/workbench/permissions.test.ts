import { describe, expect, it, vi } from 'vitest'
import { makeRunPermissions } from './permissions'

describe('run-bound Workbench permissions', () => {
  it('publishes a bounded request and resolves it exactly once', async () => {
    const audit = vi.fn()
    const permissions = makeRunPermissions({ taskId: 'deadbeef', timeoutMs: 1000, audit })
    const answer = permissions.request({ tool: ' Bash ', description: ' remove generated files ' })
    const [pending] = permissions.pending()

    expect(pending).toMatchObject({ taskId: 'deadbeef' })
    expect(pending!.id).toMatch(/^[a-f0-9-]{36}$/)
    expect(pending).toMatchObject({ tool: 'Bash', description: 'remove generated files' })
    expect(permissions.resolve(pending!.id, 'allow')).toBe(true)
    await expect(answer).resolves.toBe(true)
    expect(permissions.pending()).toEqual([])
    expect(permissions.resolve(pending!.id, 'deny')).toBe(false)
    expect(audit.mock.calls.map(call => call[0].type)).toEqual(['request', 'outcome'])
  })

  it('denies and removes requests on SDK abort', async () => {
    const controller = new AbortController()
    const permissions = makeRunPermissions({ taskId: 'deadbeef', timeoutMs: 1000 })
    const answer = permissions.request({ tool: 'Bash', description: 'remove generated files' }, controller.signal)
    controller.abort()
    await expect(answer).resolves.toBe(false)
    expect(permissions.pending()).toEqual([])
  })

  it('denies expired requests and all requests when the run ends', async () => {
    const expired = makeRunPermissions({ taskId: 'deadbeef', timeoutMs: 5 })
    const expiry = expired.request({ tool: 'Bash', description: 'remove generated files' })
    await expect(expiry).resolves.toBe(false)
    expect(expired.pending()).toEqual([])

    const ended = makeRunPermissions({ taskId: 'deadbeef', timeoutMs: 1000 })
    const first = ended.request({ tool: 'Bash', description: 'one' })
    const second = ended.request({ tool: 'Bash', description: 'two' })
    ended.rejectAll('cancelled')
    await expect(Promise.all([first, second])).resolves.toEqual([false, false])
    expect(ended.pending()).toEqual([])
  })

  it('fails closed on empty malformed request fields', async () => {
    const permissions = makeRunPermissions({ taskId: 'deadbeef', timeoutMs: 1000 })
    await expect(permissions.request({ tool: '  ', description: 'detail' })).resolves.toBe(false)
    await expect(permissions.request({ tool: 'Bash', description: '  ' })).resolves.toBe(false)
    await expect(permissions.request({ tool: 'x'.repeat(161), description: 'detail' })).resolves.toBe(false)
    await expect(permissions.request({ tool: 'Bash', description: 'x'.repeat(20_001) })).resolves.toBe(false)
    expect(permissions.pending()).toEqual([])
  })

  it('denies and cleans up when request or outcome audit storage fails', async () => {
    const permissions = makeRunPermissions({
      taskId: 'deadbeef', timeoutMs: 1000,
      audit: () => { throw new Error('audit unavailable') },
    })
    await expect(permissions.request({ tool: 'Bash', description: 'remove output' })).resolves.toBe(false)
    expect(permissions.pending()).toEqual([])

    let calls=0
    const outcomeFailure=makeRunPermissions({taskId:'deadbeef',timeoutMs:1000,audit:()=>{if(++calls===2)throw new Error('audit unavailable')}})
    const answer=outcomeFailure.request({tool:'Bash',description:'remove output'})
    const id=outcomeFailure.pending()[0]!.id
    expect(outcomeFailure.resolve(id,'allow')).toBe(true)
    await expect(answer).resolves.toBe(false)
    expect(outcomeFailure.pending()).toEqual([])
  })

  it('cannot allow after the absolute expiry even when the timer callback is delayed', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-09-12T00:00:00Z'))
      const permissions=makeRunPermissions({taskId:'deadbeef',timeoutMs:100})
      const answer=permissions.request({tool:'Bash',description:'remove output'})
      const id=permissions.pending()[0]!.id
      vi.setSystemTime(new Date('2026-09-12T00:00:01Z'))
      expect(permissions.resolve(id,'allow')).toBe(false)
      await expect(answer).resolves.toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})

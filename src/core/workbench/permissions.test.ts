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

// 放行规则(2026-10-19):登记之前先问 decide;规则拿主意的那条不进 pending、不发 request 审计(= 不通知主人)。
describe('Workbench permissions × 放行规则', () => {
  const flush = () => new Promise(r => setTimeout(r, 0))
  it('decide allow ⇒ true, never pending, one outcome audit with by', async () => {
    const audit = vi.fn()
    const p = makeRunPermissions({ taskId: 't', timeoutMs: 1000, audit, decide: async () => ({ verdict: 'allow', by: 'rule' }) })
    const answer = p.request({ tool: 'Bash', description: 'ls', command: 'ls' })
    expect(p.pending()).toEqual([])
    await expect(answer).resolves.toBe(true)
    expect(audit.mock.calls.map(c => c[0])).toEqual([expect.objectContaining({ type: 'outcome', outcome: 'allow', by: 'rule' })])
  })
  it('decide deny ⇒ false with by', async () => {
    const audit = vi.fn()
    const p = makeRunPermissions({ taskId: 't', timeoutMs: 1000, audit, decide: async () => ({ verdict: 'deny', by: 'rule' }) })
    await expect(p.request({ tool: 'Bash', description: 'git push', command: 'git push' })).resolves.toBe(false)
    expect(audit.mock.calls.map(c => c[0])).toEqual([expect.objectContaining({ type: 'outcome', outcome: 'deny', by: 'rule' })])
  })
  it('while decide is pending: nothing pending, no request audit', async () => {
    const audit = vi.fn()
    const p = makeRunPermissions({ taskId: 't', timeoutMs: 1000, audit, decide: () => new Promise(() => {}) })
    void p.request({ tool: 'Bash', description: 'ls' })
    await flush()
    expect(p.pending()).toEqual([])
    expect(audit).not.toHaveBeenCalled()
  })
  it('decide ask ⇒ the same audit sequence as without decide', async () => {
    const audit = vi.fn()
    const p = makeRunPermissions({ taskId: 't', timeoutMs: 1000, audit, decide: async () => ({ verdict: 'ask', by: 'default' }) })
    const answer = p.request({ tool: 'Bash', description: 'ls' })
    await flush()
    const [pending] = p.pending()
    expect(p.resolve(pending!.id, 'allow')).toBe(true)
    await expect(answer).resolves.toBe(true)
    expect(audit.mock.calls.map(c => c[0].type)).toEqual(['request', 'outcome'])
    expect(audit.mock.calls[1]![0].by).toBeUndefined()
  })
  it('decide throwing ⇒ asks', async () => {
    const p = makeRunPermissions({ taskId: 't', timeoutMs: 1000, decide: async () => { throw new Error('x') } })
    void p.request({ tool: 'Bash', description: 'ls' })
    await flush()
    expect(p.pending().length).toBe(1)
  })
  it('abort during decide ⇒ false and never registered', async () => {
    let release!: (v: { verdict: 'allow'; by: string }) => void
    const controller = new AbortController()
    const p = makeRunPermissions({ taskId: 't', timeoutMs: 1000, decide: () => new Promise(r => { release = r }) })
    const answer = p.request({ tool: 'Bash', description: 'ls' }, controller.signal)
    controller.abort()
    release({ verdict: 'allow', by: 'rule' })
    await expect(answer).resolves.toBe(false)
    expect(p.pending()).toEqual([])
  })
  it('run ended during decide ⇒ false', async () => {
    let release!: (v: { verdict: 'allow'; by: string }) => void
    const p = makeRunPermissions({ taskId: 't', timeoutMs: 1000, decide: () => new Promise(r => { release = r }) })
    const answer = p.request({ tool: 'Bash', description: 'ls' })
    p.rejectAll()
    release({ verdict: 'allow', by: 'rule' })
    await expect(answer).resolves.toBe(false)
  })
  it('decide gets the facts the executor supplied', async () => {
    const decide = vi.fn(async () => ({ verdict: 'ask' as const, by: 'default' }))
    const p = makeRunPermissions({ taskId: 't', timeoutMs: 1000, decide })
    void p.request({ tool: 'Edit', description: 'edit a', paths: ['/w/a'], cwd: '/w' })
    await flush()
    expect(decide).toHaveBeenCalledWith({ tool: 'Edit', description: 'edit a', paths: ['/w/a'], cwd: '/w' })
  })
})

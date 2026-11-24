import { describe, expect, it, vi } from 'vitest'
import { PERMISSION_SNAPSHOT_NOTICE, MatterPermission, boundedPermissionDisplay } from '@wechat-cc/protocol'
import { makeRunPermissions } from './permissions'

describe('run-bound Workbench permissions', () => {
  it('delivers only audited owner denials, counts consecutive rejections and resets after approval', async () => {
    const audit=vi.fn(), onDenied=vi.fn(), p=makeRunPermissions({taskId:'deadbeef',audit})
    const ask=()=>p.request({tool:'Bash',description:'ssh elsewhere',onDenied})
    for(let i=0;i<2;i++){
      const result=ask();expect(p.resolve(p.pending()[0]!.id,'deny',' 本机验证 ')).toBe(true)
      expect(await result).toBe(false);expect(p.denialLimitReached()).toBe(false)
    }
    const approved=ask();p.resolve(p.pending()[0]!.id,'allow');expect(await approved).toBe(true)
    for(let i=0;i<3;i++){const result=ask();p.resolve(p.pending()[0]!.id,'deny');expect(await result).toBe(false);expect(p.denialLimitReached()).toBe(i===2)}
    expect(onDenied.mock.calls).toEqual([['本机验证'],['本机验证'],[''],[''],['']])
    expect(audit.mock.calls[1]![0]).toMatchObject({type:'outcome',outcome:'deny',reason:'本机验证'})
    const failed=makeRunPermissions({taskId:'deadbeef',audit:event=>{if(event.type==='outcome')throw Error('disk')}})
    const result=failed.request({tool:'Bash',description:'x',onDenied});expect(failed.resolve(failed.pending()[0]!.id,'deny','reason')).toBe(false)
    expect(await result).toBe(false);expect(onDenied).toHaveBeenCalledTimes(5);expect(failed.denialLimitReached()).toBe(false)
    const aborted=new AbortController(),pending=p.request({tool:'Bash',description:'x',onDenied},aborted.signal)
    aborted.abort();expect(await pending).toBe(false);expect(onDenied).toHaveBeenCalledTimes(5)
  })

  it('validates denial reasons without consuming or changing the approval scope', async () => {
    const p=makeRunPermissions({taskId:'deadbeef'}),answer=p.request({tool:'Bash',description:'x',onDenied:()=>{}})
    const id=p.pending()[0]!.id
    expect(()=>p.resolve(id,'allow','reason')).toThrow('invalid_request')
    expect(()=>p.resolve(id,'deny','x'.repeat(2001))).toThrow('invalid_request')
    expect(p.pending()).toHaveLength(1)
    expect(p.resolve(id,'deny','x'.repeat(2000))).toBe(true);expect(await answer).toBe(false)
  })
  it('publishes a bounded request and resolves it exactly once', async () => {
    const audit = vi.fn()
    const permissions = makeRunPermissions({ taskId: 'deadbeef', timeoutMs: 1000, audit })
    const answer = permissions.request({ tool: ' Bash ', command: 'rm build', description: ' remove generated files ' })
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

  it('keeps the full command and snapshot notice when the wire preview is truncated', async () => {
    const permissions = makeRunPermissions({ taskId: 'sample' })
    const command = 'printf '.padEnd(9000, 'x')
    const description = `command=${command}`
    const display = boundedPermissionDisplay(() => ({ body: { kind: 'command', command } }))
    const answer = permissions.request({ tool: 'Bash', description, command, display })
    const card = MatterPermission.parse(permissions.pending()[0])
    expect(card.showSnapshotNotice).toBe(true)
    expect(card.display?.truncated).toBe(true)
    expect(card.description === `${description}\n\n${PERMISSION_SNAPSHOT_NOTICE}`).toBe(true)
    permissions.resolve(card.id, 'deny')
    await expect(answer).resolves.toBe(false)
  })

  it('keeps a verified MCP target alongside the unchanged operation preview', async () => {
    const permissions = makeRunPermissions({ taskId: 'sample' })
    const tool = 'mcp__team__prod__lookup__all'
    const mcp = { server: 'team__prod', tool: 'lookup__all' }
    const display = { body: { kind: 'fields' as const, fields: [{ name: 'query', value: 'sample' }] } }
    const answer = permissions.request({ tool, description: 'sample lookup', display, mcp })
    const card = MatterPermission.parse(permissions.pending()[0])
    expect(card).toMatchObject({ tool, display, mcp })
    permissions.resolve(card.id, 'deny')
    await expect(answer).resolves.toBe(false)
  })

  it('denies and removes requests on SDK abort', async () => {
    const controller = new AbortController()
    const permissions = makeRunPermissions({ taskId: 'deadbeef', timeoutMs: 1000 })
    const answer = permissions.request({ tool: 'Bash', command: 'rm build', description: 'remove generated files' }, controller.signal)
    controller.abort()
    await expect(answer).resolves.toBe(false)
    expect(permissions.pending()).toEqual([])
  })

  it('denies expired requests and all requests when the run ends', async () => {
    const expired = makeRunPermissions({ taskId: 'deadbeef', timeoutMs: 5 })
    const expiry = expired.request({ tool: 'Bash', command: 'rm build', description: 'remove generated files' })
    await expect(expiry).resolves.toBe(false)
    expect(expired.pending()).toEqual([])

    const ended = makeRunPermissions({ taskId: 'deadbeef', timeoutMs: 1000 })
    const first = ended.request({ tool: 'Bash', command: 'rm build', description: 'one' })
    const second = ended.request({ tool: 'Bash', command: 'rm build', description: 'two' })
    ended.rejectAll('cancelled')
    await expect(Promise.all([first, second])).resolves.toEqual([false, false])
    expect(ended.pending()).toEqual([])
  })

  it('fails closed on empty malformed request fields', async () => {
    const permissions = makeRunPermissions({ taskId: 'deadbeef', timeoutMs: 1000 })
    await expect(permissions.request({ tool: '  ', description: 'detail' })).resolves.toBe(false)
    await expect(permissions.request({ tool: 'Bash', command: 'rm build', description: '  ' })).resolves.toBe(false)
    await expect(permissions.request({ tool: 'x'.repeat(161), description: 'detail' })).resolves.toBe(false)
    await expect(permissions.request({ tool: 'Bash', command: 'rm build', description: 'x'.repeat(20_001) })).resolves.toBe(false)
    expect(permissions.pending()).toEqual([])
  })

  it('denies and cleans up when request or outcome audit storage fails', async () => {
    const permissions = makeRunPermissions({
      taskId: 'deadbeef', timeoutMs: 1000,
      audit: () => { throw new Error('audit unavailable') },
    })
    await expect(permissions.request({ tool: 'Bash', command: 'rm build', description: 'remove output' })).resolves.toBe(false)
    expect(permissions.pending()).toEqual([])

    let calls=0
    const outcomeFailure=makeRunPermissions({taskId:'deadbeef',timeoutMs:1000,audit:()=>{if(++calls===2)throw new Error('audit unavailable')}})
    const answer=outcomeFailure.request({tool:'Bash',command: 'rm build', description:'remove output'})
    const id=outcomeFailure.pending()[0]!.id
    expect(outcomeFailure.resolve(id,'allow')).toBe(false)
    await expect(answer).resolves.toBe(false)
    expect(outcomeFailure.pending()).toEqual([])
  })

  it('shows full review details without feeding them or the display cwd to the decision rules', async () => {
    const decide = vi.fn(async () => ({ verdict: 'ask' as const, by: 'default' }))
    const audit = vi.fn()
    const permissions = makeRunPermissions({ taskId: 'sample', decide, audit })
    const cwd = '/sample/work', fallback = '/sample/project', description = 'Review edit'
    const display = { body: { kind: 'edit' as const, path: cwd + '/file', changes: [{ before: 'old', after: 'new' }] } }
    const reviewDescription = 'Review edit\nold\r\nnew\n'
    const pending = permissions.request({ tool: 'Edit', description, reviewDescription, display, displayCwd: cwd }, undefined, fallback)
    await expect.poll(() => permissions.pending().length).toBe(1)
    const card = permissions.pending()[0]!
    expect(card.display?.body.kind).toBe('edit')
    expect(card.description === reviewDescription && card.cwd === cwd).toBe(true)
    expect(decide).toHaveBeenCalledWith({ tool: 'Edit', description, cwd: fallback })
    expect(audit.mock.calls[0]?.[0].legacyDescription === description).toBe(true)
    permissions.resolve(card.id, 'deny')
    await expect(pending).resolves.toBe(false)
  })

  it('publishes the run directory only when the request omits its own directory', async () => {
    const permissions = makeRunPermissions({ taskId: 'sample', root: '/sample/project' })
    const runCwd = '/sample/worktree'
    const request = { tool: 'Bash', command: 'printf sample', description: 'Run a sample' }
    const answers = [
      permissions.request(request, undefined, runCwd),
      permissions.request({ ...request, cwd: '/sample/explicit' }, undefined, runCwd),
      permissions.request({ ...request, cwd: 'relative' }, undefined, runCwd),
      permissions.request(request),
    ]
    const cards = permissions.pending().map(card => MatterPermission.parse(card))
    expect(cards.map(card => card.cwd).every((cwd, i) => cwd === [runCwd, '/sample/explicit', undefined, undefined][i])).toBe(true)
    expect(cards).toHaveLength(4)
    permissions.rejectAll()
    await expect(Promise.all(answers)).resolves.toEqual([false, false, false, false])
  })

  it('cannot allow after the absolute expiry even when the timer callback is delayed', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-09-12T00:00:00Z'))
      const permissions=makeRunPermissions({taskId:'deadbeef',timeoutMs:100})
      const answer=permissions.request({tool:'Bash',command: 'rm build', description:'remove output'})
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
    void p.request({ tool: 'Bash', command: 'rm build', description: 'ls' })
    await flush()
    expect(p.pending()).toEqual([])
    expect(audit).not.toHaveBeenCalled()
  })
  it('decide ask ⇒ the same audit sequence as without decide', async () => {
    const audit = vi.fn()
    const p = makeRunPermissions({ taskId: 't', timeoutMs: 1000, audit, decide: async () => ({ verdict: 'ask', by: 'default' }) })
    const answer = p.request({ tool: 'Bash', command: 'rm build', description: 'ls' })
    await flush()
    const [pending] = p.pending()
    expect(p.resolve(pending!.id, 'allow')).toBe(true)
    await expect(answer).resolves.toBe(true)
    expect(audit.mock.calls.map(c => c[0].type)).toEqual(['request', 'outcome'])
    expect(audit.mock.calls[1]![0].by).toBeUndefined()
  })
  it('decide throwing ⇒ asks', async () => {
    const p = makeRunPermissions({ taskId: 't', timeoutMs: 1000, decide: async () => { throw new Error('x') } })
    void p.request({ tool: 'Bash', command: 'rm build', description: 'ls' })
    await flush()
    expect(p.pending().length).toBe(1)
  })
  it('abort during decide ⇒ false and never registered', async () => {
    let release!: (v: { verdict: 'allow'; by: string }) => void
    const controller = new AbortController()
    const p = makeRunPermissions({ taskId: 't', timeoutMs: 1000, decide: () => new Promise(r => { release = r }) })
    const answer = p.request({ tool: 'Bash', command: 'rm build', description: 'ls' }, controller.signal)
    controller.abort()
    release({ verdict: 'allow', by: 'rule' })
    await expect(answer).resolves.toBe(false)
    expect(p.pending()).toEqual([])
  })
  it('run ended during decide ⇒ false', async () => {
    let release!: (v: { verdict: 'allow'; by: string }) => void
    const p = makeRunPermissions({ taskId: 't', timeoutMs: 1000, decide: () => new Promise(r => { release = r }) })
    const answer = p.request({ tool: 'Bash', command: 'rm build', description: 'ls' })
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

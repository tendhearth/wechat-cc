import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createInternalApi, type InternalApi } from './index'
import { minTierFor } from './route-tiers'

const TASK = {
  id: 'deadbeef', title: 'Draft', path: '/tmp/project', providerId: 'codex',
  status: 'queued', createdAt: 1, updatedAt: 1, error: null,
}

function service(overrides: Record<string, unknown> = {}) {
  return {
    list: vi.fn(() => ({ tasks: [TASK], providers: [{ id: 'codex', displayName: 'Codex' }], defaultProvider: 'codex', canWechat: true })),
    detail: vi.fn(() => ({ task: TASK, events: [], artifacts: [] })),
    create: vi.fn(() => TASK),
    continueTask: vi.fn(() => TASK),
    cancel: vi.fn(async () => ({ ...TASK, status: 'cancelling' })),
    artifact: vi.fn(() => ({ name: 'draft.md', mime: 'text/markdown', size: 5, sha256: 'a'.repeat(64), contentBase64: 'aGVsbG8=' })),
    approve: vi.fn(() => undefined),
    resolvePermission: vi.fn(() => undefined),
    ...overrides,
  }
}

describe('Workbench internal HTTP API', () => {
  let stateDir: string
  let api: InternalApi | null

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'workbench-api-'))
    api = null
  })

  afterEach(async () => {
    await api?.stop()
    rmSync(stateDir, { recursive: true, force: true })
  })

  async function start(initial?: ReturnType<typeof service>) {
    api = createInternalApi({ stateDir, daemonPid: 1, workbench: initial } as never)
    const adminToken = api.mintSessionToken('admin', 'codex/default/owner')
    const { port, tokenFilePath, operatorTokenFilePath } = await api.start()
    const trustedToken = readFileSync(tokenFilePath, 'utf8').trim()
    const operatorToken = readFileSync(operatorTokenFilePath, 'utf8').trim()
    const request = (path: string, init: RequestInit = {}, token = adminToken) => fetch(`http://127.0.0.1:${port}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...init.headers },
    })
    return { request, trustedToken, operatorToken }
  }

  it('declares every Workbench route admin-only and rejects the trusted file token', async () => {
    const { request, trustedToken } = await start(service())
    const keys = [
      'GET /v1/workbench', 'GET /v1/workbench/task', 'POST /v1/workbench/create',
      'POST /v1/workbench/continue', 'POST /v1/workbench/cancel',
      'GET /v1/workbench/artifact', 'POST /v1/workbench/approve',
      'POST /v1/workbench/permission',
    ]
    for (const key of keys) expect(minTierFor(key)).toBe('admin')
    const response = await request('/v1/workbench', {}, trustedToken)
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: 'forbidden', required: 'admin' })
  })

  it('returns 503 until setWorkbench late-binds the service', async () => {
    const { request } = await start()
    expect((await request('/v1/workbench')).status).toBe(503)
    const workbench = service()
    api!.setWorkbench(workbench as never)
    const response = await request('/v1/workbench')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(await workbench.list())
  })

  it('allows the generated desktop operator token to read and mutate Workbench tasks', async () => {
    const workbench = service()
    const { request, operatorToken } = await start(workbench)
    const list = await request('/v1/workbench', {}, operatorToken)
    expect(list.status).toBe(200)
    expect(await list.json()).toEqual(await workbench.list())
    const create = await request('/v1/workbench/create', {
      method: 'POST',
      body: JSON.stringify({ path: '/tmp/project', providerId: 'claude', text: 'draft this' }),
    }, operatorToken)
    expect(create.status).toBe(202)
    expect(await create.json()).toEqual({ task: TASK })
  })

  it('serves all eight routes with the documented wire shapes and 202 mutations', async () => {
    const workbench = service()
    const { request } = await start(workbench)
    const calls: Array<[string, RequestInit, number]> = [
      ['/v1/workbench', {}, 200],
      ['/v1/workbench/task?id=deadbeef', {}, 200],
      ['/v1/workbench/create', { method: 'POST', body: JSON.stringify({ title: ' Draft ', path: '/tmp/project', providerId: 'codex', text: ' write it ' }) }, 202],
      ['/v1/workbench/continue', { method: 'POST', body: JSON.stringify({ id: 'deadbeef', text: ' revise ' }) }, 202],
      ['/v1/workbench/cancel', { method: 'POST', body: JSON.stringify({ id: 'deadbeef' }) }, 202],
      ['/v1/workbench/artifact?id=deadbeef&artifactId=123e4567-e89b-12d3-a456-426614174000', {}, 200],
      ['/v1/workbench/approve', { method: 'POST', body: JSON.stringify({ id: 'deadbeef', artifactId: '123e4567-e89b-12d3-a456-426614174000', sha256: 'a'.repeat(64) }) }, 200],
      ['/v1/workbench/permission', { method: 'POST', body: JSON.stringify({ id: 'deadbeef', requestId: '123e4567-e89b-42d3-a456-426614174000', decision: 'deny' }) }, 200],
    ]
    for (const [path, init, status] of calls) expect((await request(path, init)).status).toBe(status)
    expect(workbench.create).toHaveBeenCalledWith({ title: 'Draft', path: '/tmp/project', providerId: 'codex', text: 'write it' })
    expect(workbench.continueTask).toHaveBeenCalledWith('deadbeef', 'revise')
    expect(workbench.approve).toHaveBeenCalledWith('deadbeef', '123e4567-e89b-12d3-a456-426614174000', 'a'.repeat(64))
    expect(workbench.resolvePermission).toHaveBeenCalledWith('deadbeef', '123e4567-e89b-42d3-a456-426614174000', 'deny')
  })

  it('keeps per-task waiting and permission information intact through list and detail', async () => {
    const running = { ...TASK, status: 'running', waitingFor: null, pendingPermissionCount: 2 }
    const waitingFor = { taskId: TASK.id, title: 'Draft', reason: 'nested_path' }
    const queued = { ...TASK, id: 'cafefeed', path: '/tmp/project/docs', waitingFor, pendingPermissionCount: 0 }
    const workbench = service({
      list: vi.fn(() => ({ tasks: [running, queued], providers: [], defaultProvider: null, canWechat: false })),
      detail: vi.fn((id: string) => ({ task: id === queued.id ? queued : running, events: [], artifacts: [], permissions: [] })),
    })
    const { request } = await start(workbench)
    expect(await (await request('/v1/workbench')).json()).toMatchObject({ tasks: [running, queued] })
    expect(await (await request(`/v1/workbench/task?id=${queued.id}`)).json()).toMatchObject({ task: queued, permissions: [] })
    expect(workbench.detail).toHaveBeenCalledWith(queued.id)
    queued.waitingFor.reason = 'writer_not_closed'
    expect(await (await request(`/v1/workbench/task?id=${queued.id}`)).json()).toMatchObject({
      task: { waitingFor: { taskId: TASK.id, reason: 'writer_not_closed' } },
    })
  })

  it('rejects malformed identifiers and bounded create fields before calling the service', async () => {
    const workbench = service()
    const { request } = await start(workbench)
    const badRequests: Array<[string, RequestInit]> = [
      ['/v1/workbench/task?id=NOPE', {}],
      ['/v1/workbench/artifact?id=deadbeef&artifactId=../secret', {}],
      ['/v1/workbench/create', { method: 'POST', body: JSON.stringify({ title: '', path: 'relative', providerId: 'other', text: ' ' }) }],
      ['/v1/workbench/create', { method: 'POST', body: JSON.stringify({ title: 'x'.repeat(121), path: '/tmp', providerId: 'claude', text: 'x'.repeat(20_001) }) }],
      ['/v1/workbench/approve', { method: 'POST', body: JSON.stringify({ id: 'deadbeef', artifactId: '123e4567-e89b-12d3-a456-426614174000', sha256: 'abc' }) }],
      ['/v1/workbench/permission', { method: 'POST', body: JSON.stringify({ id: 'deadbeef', requestId: '../wrong', decision: 'always' }) }],
    ]
    for (const [path, init] of badRequests) {
      const response = await request(path, init)
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ error: 'invalid_request' })
    }
    expect(workbench.create).not.toHaveBeenCalled()
    expect(workbench.detail).not.toHaveBeenCalled()
    expect(workbench.artifact).not.toHaveBeenCalled()
    expect(workbench.approve).not.toHaveBeenCalled()
    expect(workbench.resolvePermission).not.toHaveBeenCalled()
  })

  it.each([
    ['workbench_busy', 409], ['not_found', 404], ['unavailable_provider', 422],
    ['invalid_text', 400], ['invalid_path', 400], ['artifact_changed', 409], ['permission_stale', 409],
    ['secret backend detail', 500],
  ])('maps service error %s to %i without exposing unknown details', async (code, expected) => {
    const { request } = await start(service({ list: vi.fn(() => { throw new Error(code) }) }))
    const response = await request('/v1/workbench')
    expect(response.status).toBe(expected)
    expect(await response.json()).toEqual(expected === 500 ? { error: 'internal' } : { error: code })
  })

  it('validates optional restart tokens and forwards approval only when supplied', async () => {
    const workbench=service(),{request}=await start(workbench)
    for(const restartToken of ['',null,7,'A'.repeat(64),'a'.repeat(63),'a'.repeat(65)]) {
      const response=await request('/v1/workbench/continue',{method:'POST',body:JSON.stringify({id:'deadbeef',text:'next',restartToken})})
      expect(response.status).toBe(400);expect(await response.json()).toEqual({error:'invalid_request'})
    }
    expect(workbench.continueTask).not.toHaveBeenCalled()
    const restartToken='a'.repeat(64)
    const response=await request('/v1/workbench/continue',{method:'POST',body:JSON.stringify({id:'deadbeef',text:' next ',restartToken})})
    expect(response.status).toBe(202)
    expect(workbench.continueTask).toHaveBeenCalledWith('deadbeef','next',{restartToken})
  })

  it.each(['restart_confirmation_required','restart_confirmation_stale'])('returns %s as 409 without echoing the token', async error => {
    const {request}=await start(service({continueTask:()=>{throw new Error(error)}}))
    const response=await request('/v1/workbench/continue',{method:'POST',body:JSON.stringify({id:'deadbeef',text:'next',restartToken:'a'.repeat(64)})})
    expect(response.status).toBe(409);expect(await response.json()).toEqual({error})
  })

  it('returns 409 for a stale task permission response', async () => {
    const workbench=service({resolvePermission:vi.fn(() => {throw new Error('permission_stale')})})
    const {request}=await start(workbench)
    const response=await request('/v1/workbench/permission',{
      method:'POST',body:JSON.stringify({id:'deadbeef',requestId:'123e4567-e89b-42d3-a456-426614174000',decision:'allow'}),
    })
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({error:'permission_stale'})
  })
})

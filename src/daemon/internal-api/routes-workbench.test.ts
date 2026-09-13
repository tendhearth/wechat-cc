import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { request as httpRequest } from 'node:http'
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
    setArchived: vi.fn(() => ({ ...TASK, archivedAt: 123, canArchive: true })),
    cancel: vi.fn(async () => ({ ...TASK, status: 'cancelling' })),
    artifact: vi.fn(() => ({ name: 'draft.md', mime: 'text/markdown', size: 5, sha256: 'a'.repeat(64), contentBase64: 'aGVsbG8=' })),
    approve: vi.fn(() => undefined),
    resolvePermission: vi.fn(() => undefined),
    ...overrides,
  }
}

describe('Workbench internal HTTP API', () => {
  it('accepts attachment-only messages and forwards scoped material through create, continue and live input',async()=>{
    const submitInput=vi.fn(async()=>({status:'pending'})),workbench=service({submitInput}),{request}=await start(workbench)
    const material={draftId:crypto.randomUUID(),attachmentIds:[crypto.randomUUID()]}
    expect((await request('/v1/workbench/create',{method:'POST',body:JSON.stringify({path:'/tmp/project',providerId:'claude',text:'',...material})})).status).toBe(202)
    expect(workbench.create).toHaveBeenCalledWith({path:'/tmp/project',providerId:'claude',text:'',...material})
    const inputRequestId=crypto.randomUUID()
    expect((await request('/v1/workbench/continue',{method:'POST',body:JSON.stringify({id:TASK.id,text:'',inputRequestId,...material})})).status).toBe(202)
    expect(workbench.continueTask).toHaveBeenCalledWith(TASK.id,'',{inputRequestId,...material})
    const live={id:TASK.id,text:'',requestId:crypto.randomUUID(),runId:crypto.randomUUID(),...material}
    expect((await request('/v1/workbench/input',{method:'POST',body:JSON.stringify(live)})).status).toBe(200)
    const {id,...expected}=live;expect(submitInput).toHaveBeenCalledWith(id,expected)
    for(const attachmentIds of [null,'not-array',[material.attachmentIds[0],material.attachmentIds[0]],['invalid']])expect((await request('/v1/workbench/create',{method:'POST',body:JSON.stringify({path:'/tmp/project',providerId:'claude',text:'x',...material,attachmentIds})})).status).toBe(400)
  })
  it('limits upload bodies before decoding and keeps uploads and reads behind exact admin routes',async()=>{
    const attachment={id:crypto.randomUUID(),name:'a.txt',mime:'text/plain',size:1,sha256:'a'.repeat(64)},draftId=crypto.randomUUID()
    const uploadAttachment=vi.fn(()=>attachment),readAttachment=vi.fn(()=>({attachment,base64:'eA=='})),discardAttachment=vi.fn()
    const {request,trustedToken,operatorToken}=await start(service({uploadAttachment,readAttachment,discardAttachment}))
    const input={...attachment,draftId,base64:'eA=='}
    expect((await request('/v1/workbench/attachment',{method:'POST',body:JSON.stringify(input)},trustedToken)).status).toBe(403)
    const response=await request('/v1/workbench/attachment',{method:'POST',body:JSON.stringify(input)},operatorToken)
    expect(response.status).toBe(200);expect(await response.json()).toEqual({attachment})
    expect((await request('/v1/workbench/attachment?taskId='+TASK.id+'&id='+attachment.id,{},operatorToken)).status).toBe(200)
    expect(readAttachment).toHaveBeenCalledWith(TASK.id,attachment.id)
    expect((await request('/v1/workbench/discard-attachment',{method:'POST',body:JSON.stringify({id:attachment.id,draftId})},operatorToken)).status).toBe(200)
    expect((await request('/v1/workbench/attachment',{method:'POST',body:' '.repeat(12*1024*1024+1)})).status).toBe(413)
    expect(uploadAttachment).toHaveBeenCalledTimes(1)
  })
  it('distinguishes foreign, changed and over-limit attachments from internal errors',async()=>{
    const uploadAttachment=vi.fn(),{request}=await start(service({uploadAttachment}))
    for(const [error,status] of [['attachment_scope',404],['attachment_conflict',409],['attachment_changed',409],['attachment_storage_limit',413],['invalid_attachment_size',413],['attachment_platform_unsupported',422]] as const){
      uploadAttachment.mockImplementationOnce(()=>{throw Error(error)})
      expect((await request('/v1/workbench/attachment',{method:'POST',body:JSON.stringify({id:crypto.randomUUID(),draftId:crypto.randomUUID(),name:'x.txt',mime:'text/plain',base64:'eA=='})})).status).toBe(status)
    }
  })
  it('bounds chunked uploads without trusting a content length and keeps the API usable',async()=>{
    const uploadAttachment=vi.fn(),{port,adminToken,request}=await start(service({uploadAttachment}))
    const result=await new Promise<{status:number;body:string;connection:string|undefined}>((resolve,reject)=>{
      const req=httpRequest({host:'127.0.0.1',port,path:'/v1/workbench/attachment',method:'POST',headers:{authorization:`Bearer ${adminToken}`,'content-type':'application/json','transfer-encoding':'chunked'}},res=>{
        let body='';res.setEncoding('utf8');res.on('data',chunk=>{body+=chunk});res.on('end',()=>resolve({status:res.statusCode!,body,connection:res.headers.connection}));res.on('error',reject)
      })
      req.on('error',reject)
      for(let i=0;i<13;i++)req.write(Buffer.alloc(1024*1024,32))
      req.end()
    })
    expect(result.status).toBe(413)
    expect(result.connection).toBe('close')
    expect(JSON.parse(result.body)).toEqual({error:'request_body_too_large'})
    expect(uploadAttachment).not.toHaveBeenCalled()
    const following=await request('/v1/workbench')
    expect({status:following.status,body:await following.text()}).toEqual({status:200,body:JSON.stringify({tasks:[TASK],providers:[{id:'codex',displayName:'Codex'}],defaultProvider:'codex',canWechat:true})})
  })
  it('gates live input, question answers and unpaginated attention behind exact admin routes',async()=>{
    const submitInput=vi.fn(async()=>({status:'pending'})),resolveAnswer=vi.fn(),withdrawInput=vi.fn(),attention=vi.fn(()=>({tasks:[]}))
    const {request,trustedToken}=await start(service({submitInput,resolveAnswer,withdrawInput,attention}))
    const requestId=crypto.randomUUID(),runId=crypto.randomUUID()
    for(const [path,body] of [
      ['/v1/workbench/input',{id:TASK.id,runId,requestId,text:'补充'}],
      ['/v1/workbench/answer',{id:TASK.id,requestId,answers:{q:['文字']}}],
      ['/v1/workbench/withdraw-input',{id:TASK.id,requestId}],
    ] as const){
      expect((await request(path,{method:'POST',body:JSON.stringify(body)},trustedToken)).status).toBe(403)
      expect((await request(path,{method:'POST',body:JSON.stringify(body)})).status).toBe(200)
      expect((await request(path+'/extra',{method:'POST',body:JSON.stringify(body)})).status).toBe(404)
    }
    expect(submitInput).toHaveBeenCalledExactlyOnceWith(TASK.id,{runId,requestId,text:'补充'})
    expect(resolveAnswer).toHaveBeenCalledExactlyOnceWith(TASK.id,requestId,{q:['文字']})
    expect((await request('/v1/workbench/attention',{},trustedToken)).status).toBe(403)
    expect((await request('/v1/workbench/attention')).status).toBe(200)
    expect((await request('/v1/workbench/input',{method:'POST',body:JSON.stringify({id:TASK.id,runId:'bad',requestId,text:'x'})})).status).toBe(400)
  })
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
    return { request, trustedToken, operatorToken, port, adminToken }
  }

  it('reads native history only through exact admin routes with bounded query input',async()=>{
    const listNativeHistory=vi.fn(async()=>({items:[],nextCursor:null,coverage:'native_indexed_history'})),readNativeHistory=vi.fn(async()=>({messages:[],nextCursor:null}))
    const {request,trustedToken}=await start(service({listNativeHistory,readNativeHistory}))
    const key=Buffer.from(JSON.stringify({v:1,providerId:'codex',nativeId:'source-id'})).toString('base64url')
    expect((await request('/v1/workbench/sessions?providerId=codex&q=hello&limit=25')).status).toBe(200)
    expect(listNativeHistory).toHaveBeenCalledWith('codex',{q:'hello',limit:25})
    expect((await request(`/v1/workbench/session?key=${key}&limit=50`)).status).toBe(200)
    expect(readNativeHistory).toHaveBeenCalledWith(key,{limit:50})
    for(const route of ['/v1/workbench/sessions?providerId=codex','/v1/workbench/session?key='+key])expect((await request(route,{},trustedToken)).status).toBe(403)
    for(const suffix of ['providerId=unknown','providerId=codex&providerId=claude','providerId=codex&limit=101','providerId=codex&q='+ 'x'.repeat(201)])expect((await request('/v1/workbench/sessions?'+suffix)).status).toBe(400)
    expect((await request('/v1/workbench/session?key=../secret')).status).toBe(400)
    expect((await request('/v1/workbench/sessions/extra?providerId=codex')).status).toBe(404)
    expect(minTierFor('GET /v1/workbench/sessions')).toBe('admin');expect(minTierFor('GET /v1/workbench/session')).toBe('admin')
  })

  it('keeps handoff previews read-only, submits explicit tokens and serves records only on exact admin routes',async()=>{
    const previewHandoff=vi.fn(async()=>({token:'a'.repeat(64),context:'chosen v1'})),handoff=vi.fn(async()=>({task:TASK})),handoffRecord=vi.fn(()=>({packet:{context:'chosen v1'}}))
    const {request,trustedToken}=await start(service({previewHandoff,handoff,handoffRecord}))
    const input={sourceTaskId:TASK.id,targetProviderId:'claude',purpose:'review',request:'检查',artifacts:[]}
    expect((await request('/v1/workbench/handoff-preview',{method:'POST',body:JSON.stringify(input)})).status).toBe(200)
    expect(previewHandoff).toHaveBeenCalledWith(input);expect(handoff).not.toHaveBeenCalled()
    expect((await request('/v1/workbench/handoff',{method:'POST',body:JSON.stringify({token:'a'.repeat(64)})})).status).toBe(202)
    expect(handoff).toHaveBeenCalledWith({token:'a'.repeat(64)})
    expect((await request('/v1/workbench/handoff?taskId=deadbeef&handoffId=123e4567-e89b-42d3-a456-426614174000')).status).toBe(200)
    for(const [method,path] of [['POST','/v1/workbench/handoff-preview'],['POST','/v1/workbench/handoff'],['GET','/v1/workbench/handoff']]){
      expect(minTierFor(`${method} ${path}`)).toBe('admin')
      expect((await request(path!,{method},trustedToken)).status).toBe(403)
    }
    expect((await request('/v1/workbench/handoff',{method:'POST',body:JSON.stringify({token:'../unsafe'})})).status).toBe(400)
    expect((await request('/v1/workbench/handoff?taskId=deadbeef&taskId=cafefeed&handoffId=123e4567-e89b-42d3-a456-426614174000')).status).toBe(400)
    previewHandoff.mockRejectedValueOnce(new Error('handoff_changed'))
    expect((await request('/v1/workbench/handoff-preview',{method:'POST',body:JSON.stringify(input)})).status).toBe(409)
  })

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

  it.each([
    ['GET', '/v1/workbench/attention'],
    ['POST', '/v1/workbench/input'],
    ['POST', '/v1/workbench/withdraw-input'],
    ['POST', '/v1/workbench/answer'],
  ])('allows the generated desktop operator file token through HTTP for %s %s', async (method, path) => {
    const requestId = crypto.randomUUID(), runId = crypto.randomUUID()
    const receipt = { id: requestId, taskId: TASK.id, runId, text: '补充', status: 'pending' }
    const pending = { tasks: [{ id: TASK.id, title: TASK.title, providerId: TASK.providerId, pendingPermissionCount: 0, pendingQuestionCount: 1, attentionKey: JSON.stringify([requestId]) }] }
    const attention = vi.fn(() => pending), submitInput = vi.fn(async () => receipt)
    const resolveAnswer = vi.fn(), withdrawInput = vi.fn()
    const { request, operatorToken, trustedToken } = await start(service({ attention, submitInput, resolveAnswer, withdrawInput }))
    const calls: Record<string, { body?: unknown; response: unknown }> = {
      '/v1/workbench/attention': { response: pending },
      '/v1/workbench/input': { body: { id: TASK.id, runId, requestId, text: '补充' }, response: { input: receipt } },
      '/v1/workbench/withdraw-input': { body: { id: TASK.id, requestId }, response: { ok: true } },
      '/v1/workbench/answer': { body: { id: TASK.id, requestId, answers: { q: ['文字'] } }, response: { ok: true } },
    }
    const call = calls[path!]!
    const init = { method, ...(call.body ? { body: JSON.stringify(call.body) } : {}) }
    expect(minTierFor(`${method} ${path}`)).toBe('admin')
    const refused = await request(path!, init, trustedToken)
    expect(refused.status).toBe(403)
    expect(await refused.json()).toMatchObject({ error: 'forbidden', required: 'admin' })
    expect(attention).not.toHaveBeenCalled(); expect(submitInput).not.toHaveBeenCalled()
    expect(resolveAnswer).not.toHaveBeenCalled(); expect(withdrawInput).not.toHaveBeenCalled()

    // This comes from api.start().operatorTokenFilePath, just as both desktop
    // proxies load it; a minted admin session would miss routeAllow failures.
    const response = await request(path!, init, operatorToken)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(call.response)
    expect((await request(path + '/extra', init, operatorToken)).status).toBe(404)
    expect((await request(path!, { method: method === 'GET' ? 'POST' : 'GET' }, operatorToken)).status).toBe(404)
    if (path === '/v1/workbench/attention') expect(attention).toHaveBeenCalledExactlyOnceWith()
    if (path === '/v1/workbench/input') expect(submitInput).toHaveBeenCalledExactlyOnceWith(TASK.id, { runId, requestId, text: '补充' })
    if (path === '/v1/workbench/withdraw-input') expect(withdrawInput).toHaveBeenCalledExactlyOnceWith(TASK.id, requestId)
    if (path === '/v1/workbench/answer') expect(resolveAnswer).toHaveBeenCalledExactlyOnceWith(TASK.id, requestId, { q: ['文字'] })
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

  it('parses list filters and rejects invalid query values before reading tasks',async()=>{
    const workbench=service(),{request}=await start(workbench)
    expect((await request('/v1/workbench?q=%20report%20&archived=all&limit=25&cursor=opaque')).status).toBe(200)
    expect(workbench.list).toHaveBeenCalledWith({q:'report',archived:'all',limit:25,cursor:'opaque'})
    workbench.list.mockClear()
    for(const query of ['limit=0','limit=101','limit=1.5','limit=1e1','limit=','archived=no','q='+ 'x'.repeat(201),'cursor='+ 'x'.repeat(1025),'limit=5&limit=6']) {
      const response=await request('/v1/workbench?'+query)
      expect(response.status).toBe(400)
    }
    expect(workbench.list).not.toHaveBeenCalled()
  })

  it('allows desktop archive and restore, denies agent credentials, and rejects malformed bodies',async()=>{
    const workbench=service(),{request,operatorToken,trustedToken}=await start(workbench)
    const agentToken=api!.mintSessionToken('trusted','claude/default/agent')
    for(const token of [trustedToken,agentToken]) {
      expect((await request('/v1/workbench/archive',{method:'POST',body:JSON.stringify({id:'deadbeef',archived:true})},token)).status).toBe(403)
    }
    expect(workbench.setArchived).not.toHaveBeenCalled()
    for(const archived of [true,false]) {
      const response=await request('/v1/workbench/archive',{method:'POST',body:JSON.stringify({id:'deadbeef',archived})},operatorToken)
      expect(response.status).toBe(200);expect(await response.json()).toMatchObject({task:{id:'deadbeef',canArchive:true}})
      expect(workbench.setArchived).toHaveBeenCalledWith('deadbeef',archived)
    }
    for(const body of [{id:'deadbeef'},{id:'bad',archived:true},{id:'deadbeef',archived:'true'}])expect((await request('/v1/workbench/archive',{method:'POST',body:JSON.stringify(body)})).status).toBe(400)
  })

  it.each([['invalid_cursor',400],['workbench_archived',409]])('maps list/archive errors %s to %i',async(code,status)=>{
    const {request}=await start(service({list:()=>{throw new Error(code)}}))
    const response=await request('/v1/workbench')
    expect(response.status).toBe(status);expect(await response.json()).toEqual({error:code})
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
  it('requires owner routes for import and closure preparation and forwards native tokens separately',async()=>{
    const importNativeHistory=vi.fn(async()=>({task:TASK,source:{id:'source'},created:true})),prepareNativeResume=vi.fn(async()=>({token:'a'.repeat(64)})),continueNativeTask=vi.fn(async()=>TASK)
    const workbench=service({importNativeHistory,prepareNativeResume,continueNativeTask}),{request,operatorToken,trustedToken}=await start(workbench)
    const key=Buffer.from(JSON.stringify({v:1,providerId:'claude',nativeId:'native'})).toString('base64url'),input={key,pages:[{limit:100,cursor:null,sourceFingerprint:'b'.repeat(64)}],messageIds:['u']}
    for(const [path,body] of [['/v1/workbench/import',input],['/v1/workbench/prepare-resume',{id:TASK.id}] ] as const){
      expect(minTierFor('POST '+path)).toBe('admin')
      expect((await request(path,{method:'POST',body:JSON.stringify(body)},trustedToken)).status).toBe(403)
      expect((await request(path,{method:'POST',body:JSON.stringify(body)},operatorToken)).status).toBe(200)
      expect((await request(path+'/extra',{method:'POST',body:JSON.stringify(body)},operatorToken)).status).toBe(404)
    }
    expect(importNativeHistory).toHaveBeenCalledWith(input);expect(prepareNativeResume).toHaveBeenCalledWith(TASK.id,'native_resume')
    const response=await request('/v1/workbench/continue',{method:'POST',body:JSON.stringify({id:TASK.id,text:'next',sourceClosedToken:'a'.repeat(64)})},operatorToken)
    expect(response.status).toBe(202);expect(continueNativeTask).toHaveBeenCalledWith(TASK.id,'next','a'.repeat(64),undefined);expect(workbench.continueTask).not.toHaveBeenCalled()
    expect((await request('/v1/workbench/import',{method:'POST',body:JSON.stringify({...input,pages:[]})},operatorToken)).status).toBe(400)
    expect((await request('/v1/workbench/continue',{method:'POST',body:JSON.stringify({id:TASK.id,text:'next',sourceClosedToken:'bad'})},operatorToken)).status).toBe(400)
  })

})

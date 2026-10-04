import {afterEach, beforeEach, expect, it, vi} from 'vitest'

// The existing dialog tests use this small DOM surface; events drive the real module.
class Dialog {
  className = ''; innerHTML = ''; open = false; removed = false
  listeners: Record<string, (event: any) => void> = {}
  controls = new Map<string, any>()
  setAttribute() {}
  addEventListener(name: string, fn: (event: any) => void) { this.listeners[name] = fn }
  querySelector(selector: string) {
    if (!this.controls.has(selector)) this.controls.set(selector, {focus() {}, addEventListener() {}, disabled: false})
    return this.controls.get(selector)
  }
  querySelectorAll() { return [] }
  showModal() { this.open = true }
  close() { this.open = false; this.listeners.close?.({}) }
  remove() { this.removed = true }
  event(type: string, target: Record<string, unknown> = {}) {
    this.listeners[type]?.({preventDefault() {}, target: {...target, closest() { return this }}})
  }
  edit(name: string, value: string) { this.event('input', {name, value}) }
  choose(name: string, value: string) { this.event('change', {name, value}) }
  click(action: string) { this.event('click', {dataset: {entryAction: action}}) }
  submit() { this.event('submit') }
}
let dialog: Dialog
let memory: Map<string, string>
const storage = {getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => {memory.set(key, value)}, removeItem: (key: string) => {memory.delete(key)}}
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }
const capabilities = {version: 1, permissions: 'task', configuration: 'task-policy', completion: 'native', stop: 'confirmed', background: 'tracked', features: {nativeResume: true, attachments: true, executionSettings: true, modelCatalog: true}}
const options = () => ({status: 'ready', defaultProviderId: 'codex', providers: [{id: 'codex', displayName: 'Codex', available: true, capabilities}], projects: [{id: 'p-0123456789abcdef0123', name: '同名项目', path: '/projects/example', providerId: 'codex'}]})
const result = (requestId: string) => ({receipt: {requestId, taskId: 'aabbccdd', matterId: 'aabbccdd', runId: 'RUN', acceptedAt: 10}, task: {id: 'aabbccdd'}})
const drafts: Array<Record<string, any>> = []
function api(override?: (method: string, path: string, body?: Record<string, any>) => Promise<unknown>) {
  return async (method: 'GET'|'POST', path: string, body?: Record<string, any>) => {
    if (override) { const response = await override(method, path, body); if (response !== undefined) return response }
    if (path === '/v1/workbench/entry-options') return options()
    if (path.startsWith('/v1/workbench/entry-receipt?')) throw Error('entry_not_found')
    if (path === '/v1/workbench/create-entry') { drafts.push(structuredClone(body!)); return result(body!.requestId) }
    throw Error(`Unexpected API ${method} ${path}`)
  }
}
beforeEach(() => {
  memory = new Map(); drafts.length = 0
  vi.stubGlobal('document', {activeElement: null, body: {append() {}}, createElement() { dialog = new Dialog(); return dialog }})
})
afterEach(() => vi.unstubAllGlobals())

it('opens a managed preview without starting work or selecting private discussion', async () => {
  const {createTaskEntry} = await import('./task-entry.js')
  const entry = createTaskEntry({invokeWorkbenchApi: api(), storage})
  const pending = entry.open({text: '<要求>', visibleMessages: [{role: 'user', text: '私聊'}, {role: 'cc', text: '回复'}]})
  expect(entry.open({text: '重复点击不能替换原稿'})).toBe(pending)
  await settle()
  expect(dialog.innerHTML).toContain('&lt;要求&gt;')
  expect(dialog.innerHTML).toContain('随手交办')
  expect(dialog.innerHTML).not.toMatch(/type="checkbox"[^>]* checked/)
  expect(storage.getItem('cc.task-entry.window.v1')).not.toContain('私聊')
  expect(drafts).toEqual([])
  dialog.submit(); await settle()
  expect((await pending)?.receipt.taskId).toBe('aabbccdd')
  expect(drafts[0]).toMatchObject({text: '<要求>', target: {kind: 'managed'}})
  expect(drafts[0]).not.toHaveProperty('context')
})

it('only submits selected real recent messages, with cc mapped to assistant', async () => {
  const {createTaskEntry} = await import('./task-entry.js')
  const messages = Array.from({length: 12}, (_, index) => ({role: index % 2 ? 'cc' : 'user', text: `公开 ${index}`}))
  const entry = createTaskEntry({invokeWorkbenchApi: api(), storage})
  const pending = entry.open({text: '整理', visibleMessages: [...messages, {role: 'system', text: '系统'}, {role: 'error', text: '错误'}, {role: 'cc', text: '尚未完成', pending: true}] as any})
  await settle(); dialog.click('recent'); dialog.event('change', {name: 'excerpt', value: '0', checked: false}); dialog.submit(); await settle()
  await pending
  expect(drafts[0]?.context).toEqual({source: 'owner-chat', excerpts: messages.slice(3).map(m => ({role: m.role === 'cc' ? 'assistant' : 'user', text: m.text}))})
  expect(dialog.innerHTML).not.toContain('尚未完成')
})

it('uses the options catalog ID and retains canceled edited requirements', async () => {
  const {createTaskEntry} = await import('./task-entry.js')
  const entry = createTaskEntry({invokeWorkbenchApi: api(), storage})
  let pending = entry.open({text: '原稿'}); await settle()
  dialog.edit('text', '更明确的要求'); dialog.choose('project', 'p-0123456789abcdef0123'); dialog.click('cancel')
  expect(await pending).toBeNull()
  pending = entry.open({text: '原稿'}); await settle()
  expect(dialog.innerHTML).toContain('更明确的要求')
  dialog.submit(); await settle(); await pending
  expect(drafts[0]).toMatchObject({text: '更明确的要求', target: {kind: 'project', projectId: 'p-0123456789abcdef0123'}})
  expect(drafts[0]).not.toHaveProperty('path')
})

it('keeps a newer edited draft when the previous request is accepted', async () => {
  const {createTaskEntry} = await import('./task-entry.js')
  let finish!: (value: unknown) => void
  const onAccepted = vi.fn(async () => {})
  const entry = createTaskEntry({invokeWorkbenchApi: api(async (_method, path, body) => {
    if (path === '/v1/workbench/create-entry') { drafts.push(structuredClone(body!)); return await new Promise(resolve => {finish = resolve}) }
  }), storage, onAccepted})
  const pending = entry.open({text: '第一份'}); await settle(); dialog.submit(); await settle()
  dialog.edit('text', '再补一份要求'); dialog.submit(); await settle()
  expect(drafts).toHaveLength(1)
  finish(result(drafts[0]!.requestId)); await settle()
  expect(dialog.open).toBe(true)
  expect(dialog.innerHTML).toContain('再补一份要求')
  dialog.click('accepted'); expect(await pending).toBeNull()
  expect(onAccepted).toHaveBeenCalledExactlyOnceWith(result(drafts[0]!.requestId))
  const reopened = entry.open({text: ''}); await settle()
  expect(dialog.innerHTML).toContain('再补一份要求')
  dialog.click('cancel'); await reopened
})

it('recovers an unknown submission after reload before consulting changed options', async () => {
  const {createTaskEntry} = await import('./task-entry.js')
  const entry = createTaskEntry({invokeWorkbenchApi: api(async (_method, path, body) => {
    if (path === '/v1/workbench/create-entry') { drafts.push(structuredClone(body!)); throw Error('network disconnected') }
  }), storage})
  const first = entry.open({text: '不会重复'}); await settle(); dialog.submit(); await settle(); dialog.click('cancel'); await first
  let optionsRead = false
  const restored = createTaskEntry({storage, invokeWorkbenchApi: api(async (_method, path) => {
    if (path.startsWith('/v1/workbench/entry-receipt?')) return result(drafts[0]!.requestId)
    if (path === '/v1/workbench/entry-options') {optionsRead = true; throw Error('unavailable')}
  })})
  const second = restored.open({text: '不会重复'}); await settle()
  expect((await second)?.receipt.requestId).toBe(drafts[0]!.requestId)
  expect(optionsRead).toBe(false)
  expect(drafts).toHaveLength(1)
})

it('retries the immutable unknown request with its original UUID even after editing', async () => {
  const {createTaskEntry} = await import('./task-entry.js')
  const entry = createTaskEntry({storage, invokeWorkbenchApi: api(async (_method, path, body) => {
    if (path === '/v1/workbench/create-entry') {
      drafts.push(structuredClone(body!))
      if (drafts.length === 1) throw Error('offline')
      return result(body!.requestId)
    }
  })})
  const pending = entry.open({text: '已送出的要求'}); await settle(); dialog.submit(); await settle()
  dialog.edit('text', '稍后另做'); dialog.submit(); await settle()
  expect(drafts).toHaveLength(2)
  expect(drafts[1]).toEqual(drafts[0])
  expect(drafts[0]!.requestId).toMatch(/^[a-f0-9-]{14}4[a-f0-9-]{21}$/)
  expect(dialog.innerHTML).toContain('稍后另做')
  dialog.click('cancel'); await pending
})

it('rejects mismatched receipts and keeps requirements when no executor is available', async () => {
  const {createTaskEntry} = await import('./task-entry.js')
  const entry = createTaskEntry({storage, invokeWorkbenchApi: api(async (_method, path) => {
    if (path === '/v1/workbench/entry-options') return {...options(), status: 'needs_connection', defaultProviderId: null, providers: [], reason: {code: 'unavailable_provider', message: '先连接一个执行者'}}
  })})
  const pending = entry.open({text: '保留要求'}); await settle(); dialog.submit(); await settle()
  expect(drafts).toHaveLength(0); expect(dialog.innerHTML).toContain('先连接一个执行者')
  dialog.click('cancel'); await pending
  const second = createTaskEntry({storage, invokeWorkbenchApi: api(async (_method, path) => {
    if (path === '/v1/workbench/create-entry') return result('wrong-request')
  })})
  const next = second.open({text: '保留要求'}); await settle(); dialog.submit(); await settle()
  expect(dialog.open).toBe(true); expect(dialog.innerHTML).toContain('保留要求')
  dialog.click('cancel'); expect(await next).toBeNull()
})

it('does not resurrect a request when its closed preview finishes after recovery', async () => {
  const {createTaskEntry} = await import('./task-entry.js')
  let finish!: (value: unknown) => void, accepted = false
  const entry = createTaskEntry({storage, invokeWorkbenchApi: api(async (_method, path, body) => {
    if (path === '/v1/workbench/create-entry') {drafts.push(structuredClone(body!)); return new Promise(resolve => {finish = resolve})}
    if (path.startsWith('/v1/workbench/entry-receipt?') && accepted) return result(drafts[0]!.requestId)
  })})
  const first = entry.open({text: '同一件事'}); await settle(); dialog.submit(); await settle(); dialog.click('cancel'); await first
  accepted = true
  const recovered = entry.open({text: '同一件事'}); await settle(); await recovered
  finish(result(drafts[0]!.requestId)); await settle()
  expect(storage.getItem('cc.task-entry.window.v1')).toBeNull()
})

it('reserves uploaded materials across unknown results and submits only ready metadata', async () => {
  const {createTaskEntry} = await import('./task-entry.js')
  const {createWorkbenchAttachments} = await import('./workbench-attachments.js')
  let attachments!: ReturnType<typeof createWorkbenchAttachments>
  const discarded: string[] = []
  const entry = createTaskEntry({storage, createAttachments: deps => (attachments = createWorkbenchAttachments({...deps, encode: async () => 'aGVsbG8='})), invokeWorkbenchApi: api(async (_method, path, body) => {
    if (path === '/v1/workbench/attachment') return {attachment: {id: body!.id, name: body!.name, mime: body!.mime, size: 5, sha256: 'a'.repeat(64)}}
    if (path === '/v1/workbench/discard-attachment') {discarded.push(body!.id); return {ok: true}}
    if (path === '/v1/workbench/create-entry') {drafts.push(structuredClone(body!)); throw Error('offline')}
  })})
  const first = entry.open({text: ''}); await settle()
  const state = JSON.parse(storage.getItem('cc.task-entry.window.v1')!)
  await attachments.add(`entry:${state.draftId}`, [new File(['hello'], 'notes.txt', {type: 'text/plain'})]); await settle()
  dialog.submit(); await settle()
  expect(drafts[0]?.attachmentIds).toHaveLength(1)
  expect(drafts[0]?.draftId).toBe(state.draftId)
  dialog.click('cancel'); await first
  const second = entry.open({text: ''}); await settle()
  attachments.remove(`entry:${state.draftId}`, drafts[0]!.attachmentIds[0]); await settle()
  expect(discarded).toEqual([])
  dialog.click('cancel'); await second
})

it('rejects oversized selected material without sending or silently truncating it', async () => {
  const {createTaskEntry} = await import('./task-entry.js')
  const entry = createTaskEntry({storage, invokeWorkbenchApi: api()})
  const pending = entry.open({text: '要求', visibleMessages: [{role: 'user', text: '长'.repeat(8001)}]})
  await settle(); dialog.click('recent'); dialog.submit(); await settle()
  expect(drafts).toHaveLength(0)
  expect(dialog.innerHTML).toContain('长'.repeat(8001))
  dialog.click('cancel'); await pending
})

it('uses the shared composed prompt boundary, including selected context labels, before creating',async()=>{
  const {createTaskEntry}=await import('./task-entry.js')
  const {composeEntryPrompt,ENTRY_LIMITS}=await import('../shared/task-entry-contract.js')
  const context={excerpts:[{role:'user' as const,text:'x'.repeat(8000)}]}
  const remaining=ENTRY_LIMITS.text-composeEntryPrompt({text:'',context}).length
  const entry=createTaskEntry({storage,invokeWorkbenchApi:api()})
  const pending=entry.open({text:'y'.repeat(remaining+1),visibleMessages:[{role:'user',text:context.excerpts[0]!.text}]})
  await settle();dialog.click('recent');dialog.submit();await settle()
  expect(drafts).toHaveLength(0)
  expect(dialog.innerHTML).toContain('合计过长')
  dialog.edit('text','y'.repeat(remaining));dialog.submit();await settle();await pending
  expect(drafts).toHaveLength(1)
  expect(composeEntryPrompt(drafts[0] as any)).toHaveLength(20_000)
})

it.each(['invalid_text', 'project_stale', 'attachment_changed'])('lets a request rejected with %s be corrected without reusing its payload identity', async rejection => {
  const {createTaskEntry} = await import('./task-entry.js')
  const entry = createTaskEntry({storage, invokeWorkbenchApi: api(async (_method, path, body) => {
    if (path === '/v1/workbench/create-entry') {
      drafts.push(structuredClone(body!))
      if (drafts.length === 1) throw Error(rejection)
      return result(body!.requestId)
    }
  })})
  const pending = entry.open({text: '旧稿'}); await settle(); dialog.submit(); await settle()
  dialog.edit('text', '已修正要求'); dialog.submit(); await settle()
  expect(drafts[1]?.text).toBe('已修正要求')
  expect(drafts[1]?.requestId).not.toBe(drafts[0]?.requestId)
  await pending
})

it.each(['creation_conflict','unavailable_provider'])('preserves an unknown identity after POST %s even when the current draft is edited',async code=>{
  const {createTaskEntry}=await import('./task-entry.js')
  const entry=createTaskEntry({storage,invokeWorkbenchApi:api(async(_method,path,body)=>{
    if(path==='/v1/workbench/create-entry'){
      drafts.push(structuredClone(body!))
      if(drafts.length===1)throw Error(code)
      return result(body!.requestId)
    }
  })})
  const pending=entry.open({text:'已送出的旧要求'});await settle();dialog.submit();await settle()
  dialog.edit('text','尚未交办的新要求');dialog.submit();await settle()
  expect(drafts[1]).toEqual(drafts[0])
  expect(dialog.innerHTML).toContain('尚未交办的新要求')
  dialog.click('cancel');await pending
})

it('blocks incomplete attachments and then sends the ready attachment identity', async () => {
  const {createTaskEntry} = await import('./task-entry.js')
  const {createWorkbenchAttachments} = await import('./workbench-attachments.js')
  let attachments!: ReturnType<typeof createWorkbenchAttachments>, finish!: () => void
  const entry = createTaskEntry({storage, createAttachments: deps => (attachments = createWorkbenchAttachments({...deps, encode: async () => 'aGVsbG8='})), invokeWorkbenchApi: api(async (_method, path, body) => {
    if (path === '/v1/workbench/attachment') {await new Promise<void>(resolve => {finish = resolve}); return {attachment: {id: body!.id, name: body!.name, mime: body!.mime, size: 5, sha256: 'b'.repeat(64)}}}
  })})
  const pending = entry.open({text: '一起处理文件'}); await settle()
  const state = JSON.parse(storage.getItem('cc.task-entry.window.v1')!)
  const upload = attachments.add(`entry:${state.draftId}`, [new File(['hello'], 'notes.txt', {type: 'text/plain'})]); await settle()
  dialog.submit(); await settle(); expect(drafts).toHaveLength(0)
  finish(); await upload; dialog.submit(); await settle(); await pending
  expect(drafts[0]?.attachmentIds).toHaveLength(1)
})

it('inherits the chosen catalog project executor and preserves explicit execution choices', async () => {
  const {createTaskEntry} = await import('./task-entry.js')
  const entry = createTaskEntry({storage, invokeWorkbenchApi: api(async (_method, path) => {
    if (path === '/v1/workbench/entry-options') return {...options(), providers: [...options().providers, {id: 'claude', displayName: 'Claude', available: true, capabilities}], projects: [{...options().projects[0], providerId: 'claude'}]}
  })})
  const pending = entry.open({text: '在项目里处理'}); await settle()
  dialog.choose('project', 'p-0123456789abcdef0123'); dialog.choose('defaults', 'native')
  dialog.event('change', {id: 'task-entry-model', value: 'provided-model'})
  dialog.event('change', {id: 'task-entry-effort', value: 'high'})
  dialog.submit(); await settle(); await pending
  expect(drafts[0]).toMatchObject({providerId: 'claude', execution: {defaults: 'native', model: 'provided-model', reasoningEffort: 'high'}})
})
it('keeps requirements after a definitively expired request and allocates a new ID only on the next explicit submit',async()=>{
  const {createTaskEntry}=await import('./task-entry.js')
  const entry=createTaskEntry({storage,invokeWorkbenchApi:api(async(_method,path,body)=>{
    if(path==='/v1/workbench/create-entry'){drafts.push(structuredClone(body!));if(drafts.length===1)throw Error('entry_expired');return result(body!.requestId)}
  })})
  const pending=entry.open({text:'保留这份要求'});await settle();dialog.submit();await settle()
  expect(drafts).toHaveLength(1);expect(dialog.innerHTML).toContain('保留这份要求')
  dialog.submit();await settle()
  expect(drafts).toHaveLength(2);expect(drafts[1]?.requestId).not.toBe(drafts[0]?.requestId)
  expect(drafts[1]?.text).toBe('保留这份要求');await pending
})


it('preselects a project by its path, inherits its executor, and submits only the catalog ID', async () => {
  const {createTaskEntry} = await import('./task-entry.js')
  const entry = createTaskEntry({storage, invokeWorkbenchApi: api(async (_method, path) => {
    if (path === '/v1/workbench/entry-options') return {...options(), providers: [...options().providers, {id: 'claude', displayName: 'Claude', available: true, capabilities}], projects: [{...options().projects[0], providerId: 'claude'}]}
  })})
  const pending = entry.open({text: '在当前项目处理', projectPath: '/projects/example'}); await settle()
  expect(dialog.innerHTML).toContain('项目：同名项目')
  expect(JSON.parse(storage.getItem('cc.task-entry.window.v1')!)).toMatchObject({target: {kind: 'project', projectId: 'p-0123456789abcdef0123'}, providerId: 'claude'})
  dialog.submit(); await settle(); await pending
  expect(drafts[0]).toMatchObject({target: {kind: 'project', projectId: 'p-0123456789abcdef0123'}, providerId: 'claude'})
  expect(drafts[0]).not.toHaveProperty('projectPath')
  expect(drafts[0]).not.toHaveProperty('path')
})

it('retains edited requirements, attachments, and execution when reopening the same project', async () => {
  const {createTaskEntry} = await import('./task-entry.js')
  const {createWorkbenchAttachments} = await import('./workbench-attachments.js')
  let attachments!: ReturnType<typeof createWorkbenchAttachments>
  const entry = createTaskEntry({storage, createAttachments: deps => (attachments = createWorkbenchAttachments({...deps, encode: async () => 'aGVsbG8='})), invokeWorkbenchApi: api(async (_method, path, body) => {
    if (path === '/v1/workbench/attachment') return {attachment: {id: body!.id, name: body!.name, mime: body!.mime, size: 5, sha256: 'a'.repeat(64)}}
  })})
  const first = entry.open({text: '原稿', projectPath: '/projects/example'}); await settle()
  dialog.edit('text', '编辑后保留'); dialog.choose('defaults', 'native')
  dialog.event('change', {id: 'task-entry-model', value: 'selected-model'})
  const state = JSON.parse(storage.getItem('cc.task-entry.window.v1')!)
  await attachments.add(`entry:${state.draftId}`, [new File(['hello'], 'notes.txt', {type: 'text/plain'})]); await settle()
  dialog.click('cancel'); await first
  const second = entry.open({text: '', projectPath: '/projects/example'}); await settle()
  dialog.choose('project', 'p-0123456789abcdef0123')
  expect(dialog.innerHTML).toContain('编辑后保留')
  expect(dialog.innerHTML).toContain('notes.txt')
  expect(JSON.parse(storage.getItem('cc.task-entry.window.v1')!)).toMatchObject({draftId: state.draftId, execution: {defaults: 'native', model: 'selected-model', reasoningEffort: null}})
  dialog.submit(); await settle(); await second
  expect(drafts[0]).toMatchObject({text: '编辑后保留', draftId: state.draftId, execution: {defaults: 'native', model: 'selected-model', reasoningEffort: null}})
  expect(drafts[0]?.attachmentIds).toHaveLength(1)
})

it('keeps requirements and materials when changing the hinted project but resets execution for the new destination', async () => {
  const {createTaskEntry} = await import('./task-entry.js')
  const {createWorkbenchAttachments} = await import('./workbench-attachments.js')
  let attachments!: ReturnType<typeof createWorkbenchAttachments>
  const entry = createTaskEntry({storage, createAttachments: deps => (attachments = createWorkbenchAttachments({...deps, encode: async () => 'aGVsbG8='})), invokeWorkbenchApi: api(async (_method, path, body) => {
    if (path === '/v1/workbench/entry-options') return {...options(), providers: [...options().providers, {id: 'claude', displayName: 'Claude', available: true, capabilities}], projects: [...options().projects, {id: 'p-11111111111111111111', name: '第二项目', path: '/projects/second', providerId: 'claude'}]}
    if (path === '/v1/workbench/attachment') return {attachment: {id: body!.id, name: body!.name, mime: body!.mime, size: 5, sha256: 'b'.repeat(64)}}
  })})
  const first = entry.open({text: '原稿', projectPath: '/projects/example'}); await settle()
  dialog.edit('text', '已有要求'); dialog.choose('defaults', 'native')
  dialog.event('change', {id: 'task-entry-model', value: 'old-project-model'})
  const state = JSON.parse(storage.getItem('cc.task-entry.window.v1')!)
  await attachments.add(`entry:${state.draftId}`, [new File(['hello'], 'notes.txt', {type: 'text/plain'})]); await settle()
  dialog.click('cancel'); await first
  const second = entry.open({text: '不同来源文本', projectPath: '/projects/second'}); await settle()
  expect(dialog.innerHTML).toContain('已有要求')
  expect(dialog.innerHTML).toContain('notes.txt')
  expect(dialog.innerHTML).toContain('项目：第二项目')
  expect(JSON.parse(storage.getItem('cc.task-entry.window.v1')!)).toMatchObject({draftId: state.draftId, providerId: 'claude', execution: {defaults: 'provider', model: null, reasoningEffort: null}})
  dialog.submit(); await settle(); await second
  expect(drafts[0]).toMatchObject({text: '已有要求', draftId: state.draftId, target: {kind: 'project', projectId: 'p-11111111111111111111'}, providerId: 'claude'})
  expect(drafts[0]?.attachmentIds).toHaveLength(1)
})

it('blocks a missing hinted project until the owner explicitly chooses another destination', async () => {
  const {createTaskEntry} = await import('./task-entry.js')
  const entry = createTaskEntry({storage, invokeWorkbenchApi: api()})
  const pending = entry.open({text: '保留要求', projectPath: '/projects/missing'}); await settle()
  expect(dialog.innerHTML).toContain('所选项目暂不可用，请在更多设置里重新选择。')
  expect(dialog.innerHTML).toContain('<option value="" selected disabled>')
  expect(dialog.innerHTML).toContain('type="submit" disabled')
  dialog.submit(); await settle(); expect(drafts).toHaveLength(0)
  dialog.choose('project', 'managed'); dialog.submit(); await settle(); await pending
  expect(drafts[0]).toMatchObject({text: '保留要求', target: {kind: 'managed'}})
})

it('keeps the explicitly chosen destination when project options finish loading later', async () => {
  const {createTaskEntry} = await import('./task-entry.js')
  let finish!: (value: unknown) => void
  const entry = createTaskEntry({storage, invokeWorkbenchApi: api(async (_method, path) => {
    if (path === '/v1/workbench/entry-options') return await new Promise(resolve => {finish = resolve})
  })})
  const pending = entry.open({text: '手动选择优先', projectPath: '/projects/example'}); await settle()
  dialog.choose('project', 'managed')
  finish(options()); await settle()
  expect(JSON.parse(storage.getItem('cc.task-entry.window.v1')!).target).toEqual({kind: 'managed'})
  dialog.submit(); await settle(); await pending
  expect(drafts[0]?.target).toEqual({kind: 'managed'})
})

it.each(['offline', 'invalid_text'])('does not redirect a pending %s request when opening from another project', async failure => {
  const {createTaskEntry} = await import('./task-entry.js')
  const entry = createTaskEntry({storage, invokeWorkbenchApi: api(async (_method, path, body) => {
    if (path === '/v1/workbench/create-entry') {
      drafts.push(structuredClone(body!))
      if (drafts.length === 1) throw Error(failure)
      return result(body!.requestId)
    }
  })})
  const first = entry.open({text: '待确认的原稿', projectPath: '/projects/example'}); await settle()
  dialog.choose('defaults', 'native'); dialog.event('change', {id: 'task-entry-model', value: 'original-model'})
  dialog.submit(); await settle(); dialog.click('cancel'); await first
  const frozen = JSON.parse(storage.getItem('cc.task-entry.window.v1')!).pending.input
  const second = entry.open({text: '不能覆盖待确认要求', projectPath: '/projects/missing'}); await settle()
  const restored = JSON.parse(storage.getItem('cc.task-entry.window.v1')!)
  expect(restored).toMatchObject({text: '待确认的原稿', target: frozen.target, providerId: frozen.providerId, execution: frozen.execution})
  expect(restored.pending.input).toEqual(frozen)
  expect(dialog.innerHTML).toContain('上一份交办仍需确认')
  expect(dialog.innerHTML).not.toContain('所选项目暂不可用，请在更多设置里重新选择。')
  dialog.submit(); await settle(); await second
  expect(drafts[1]).toEqual(drafts[0])
})

it('requires an explicit executor change when the hinted project executor is unavailable', async () => {
  const {createTaskEntry} = await import('./task-entry.js')
  const entry = createTaskEntry({storage, invokeWorkbenchApi: api(async (_method, path) => {
    if (path === '/v1/workbench/entry-options') return {...options(), providers: [...options().providers, {id: 'claude', displayName: 'Claude', available: false, unavailableReason: {code: 'quota_exhausted', message: 'Claude 额度暂不可用'}, capabilities}], projects: [{...options().projects[0], providerId: 'claude'}]}
  })})
  const pending = entry.open({text: '沿用项目执行者', projectPath: '/projects/example'}); await settle()
  expect(dialog.innerHTML).toContain('Claude 额度暂不可用')
  expect(JSON.parse(storage.getItem('cc.task-entry.window.v1')!).providerId).toBe('claude')
  dialog.submit(); await settle(); expect(drafts).toHaveLength(0)
  dialog.choose('provider', 'codex'); dialog.submit(); await settle(); await pending
  expect(drafts[0]?.providerId).toBe('codex')
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { readMobileSource } from './sources'

type Response = { status: number; json: () => Promise<any> }
type Api = (path: string, opts?: { method?: string; body?: string }) => Promise<Response>
const ready = { ok: true, status: 'ready', defaultProviderId: 'codex', providers: [
  { id: 'codex', displayName: 'Codex', available: true },
  { id: 'claude', displayName: 'Claude', available: true },
  { id: 'offline', displayName: 'Unavailable', available: false },
], projects: [] }
const response = (body: unknown, status = 200): Response => ({ status, json: async () => body })
const accepted = (requestId: string, taskId = 'abcdef12') => ({ ok: true, receipt: {
  requestId, taskId, matterId: taskId, runId: 'd20dfbe1-9e10-4b3e-ad3c-9b4a61e2cb95', acceptedAt: 1234,
}, task: { id: taskId } })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}
function element() {
  const handlers: Record<string, (event?: any) => void> = {}
  return { value: '', innerHTML: '', textContent: '', hidden: false, disabled: false,
    dataset: {} as Record<string, string>, handlers, focus: vi.fn(), scrollIntoView: vi.fn(),
    classList: { contains: () => true },
    addEventListener: (name: string, fn: (event?: any) => void) => { handlers[name] = fn },
    setAttribute: vi.fn(),
  }
}
function load(api: Api, storage = new Map<string, string>(), transport?: { fetch: Api; send: Api }) {
  const els: Record<string, ReturnType<typeof element>> = {}
  const get = (id: string) => (els[id] ??= element())
  const nav = element()
  const documentEvents: Record<string, () => void> = {}, windowEvents: Record<string, () => void> = {}
  const doc = { getElementById: get, querySelectorAll: () => [nav], hidden: false,
    addEventListener: (name: string, fn: () => void) => { documentEvents[name] = fn } }
  const mobilePane = vi.fn(), openMatter = vi.fn()
  const env = { document: doc, window: { addEventListener: (name: string, fn: () => void) => { windowEvents[name] = fn } },
    REMOTE: { id: 'test-daemon', relay: 'wss://example.invalid' }, location: { host: 'localhost' },
    localStorage: { getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => { storage.set(k, v) }, removeItem: (k: string) => { storage.delete(k) } },
    api, mobilePane, openMatter, mUuid: () => crypto.randomUUID(), crypto, Uint8Array, setTimeout, clearTimeout, AbortController, btoa,
    mSha256: async (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex'), URL: { createObjectURL: () => 'blob:entry-preview', revokeObjectURL: vi.fn() },
    fetch: transport?.fetch, tunnelSend: transport?.send, q: (p: string) => p,
    esc: (s: unknown) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
  }
  const transportSource = transport ? readMobileSource('transport.js') + '\ntunnel = function(){ return Promise.resolve(tunnelSend) }\n' : ''
  const fns = new Function(...Object.keys(env), `var mCurrent = null, mSeq = 0;\n${transportSource}\n${readMobileSource('attachments.js')}\n${readMobileSource('entry.js')}
    return {openEntry, submitEntry, restoreEntry, leave: function(){mCurrent='12345678';mSeq++}, state:function(){return JSON.parse(JSON.stringify(eState))}, materials:function(){return eAttachments}}`)(...Object.values(env)) as {
      openEntry: () => Promise<void>; submitEntry: () => Promise<void>; restoreEntry: () => Promise<void>;
      leave: () => void; state: () => any; materials: () => {select: (files: File[]) => Promise<void>; readyIds: () => string[]; items: () => any[]; remove: (id: string) => Promise<void>};
    }
  const edit = (text: string) => { get('entry-text').value = text; get('entry-text').handlers.input!() }
  return { ...fns, edit, els, get, storage, nav, documentEvents, windowEvents, doc, mobilePane, openMatter }
}
afterEach(() => vi.useRealTimers())

describe('phone task entry', () => {
  it('starts without a project and sends only the managed input after a matching receipt', async () => {
    const api = vi.fn<Api>(async (path, opts) => path.endsWith('/options') ? response(ready) : response(accepted(JSON.parse(opts!.body!).requestId)))
    const phone = load(api)
    await phone.openEntry()
    phone.edit('帮我整理周末出游清单')
    await phone.submitEntry()
    const input = JSON.parse(api.mock.calls.find(([p]) => p === '/m/api/matter/create')![1]!.body!)
    expect(input).toEqual({ text: '帮我整理周末出游清单', target: { kind: 'managed' }, requestId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/) })
    expect(phone.get('entry-text').value).toBe('')
    expect(phone.openMatter).toHaveBeenCalledWith('abcdef12')
  })

  it('keeps its draft separate from matter continuation drafts and restores text without opening a task', async () => {
    const storage = new Map([['cc.phone.matter.v1:test-daemon:abcdef12:say', '{"text":"任务补充"}']])
    const api: Api = async () => response(ready)
    const first = load(api, storage)
    await first.openEntry(); first.edit('想做一份菜单')
    const refreshed = load(api, storage)
    await refreshed.restoreEntry()
    expect(refreshed.get('entry-text').value).toBe('想做一份菜单')
    expect(storage.get('cc.phone.matter.v1:test-daemon:abcdef12:say')).toBe('{"text":"任务补充"}')
    expect(refreshed.openMatter).not.toHaveBeenCalled()
  })

  it('offers server projects and available providers, preserving an omitted default provider', async () => {
    const project = { id: 'p-1234567890abcdef1234', name: '<周末>', path: '/private/work', providerId: 'claude' }
    const api = vi.fn<Api>(async (path, opts) => path.endsWith('/options') ? response({ ...ready, projects: [project] }) : response(accepted(JSON.parse(opts!.body!).requestId)))
    const phone = load(api)
    await phone.openEntry()
    expect(phone.get('entry-provider').innerHTML).toContain('Codex')
    expect(phone.get('entry-provider').innerHTML).not.toContain('Unavailable')
    expect(phone.get('entry-project').innerHTML).toContain('&lt;周末&gt;')
    expect(phone.get('entry-project').innerHTML).not.toContain('/private/work')
    phone.get('entry-project').value = project.id; phone.get('entry-project').handlers.change!({ target: phone.get('entry-project') })
    phone.get('entry-provider').value = 'claude'; phone.get('entry-provider').handlers.change!({ target: phone.get('entry-provider') })
    phone.edit('整理这个项目')
    await phone.submitEntry()
    expect(JSON.parse(api.mock.calls.find(([p]) => p.endsWith('/create'))![1]!.body!)).toMatchObject({ target: { kind: 'project', projectId: project.id }, providerId: 'claude' })
  })

  it('saves text and explains how to connect when no executor is available', async () => {
    const api = vi.fn<Api>(async () => response({ ...ready, status: 'needs_connection', defaultProviderId: null, providers: [] }))
    const phone = load(api)
    await phone.openEntry(); phone.edit('先记着这件事'); await phone.submitEntry()
    expect(api.mock.calls.every(([p]) => p.endsWith('/options'))).toBe(true)
    expect(phone.get('entry-notice').textContent).toContain('桌面')
    expect(phone.get('entry-text').value).toBe('先记着这件事')
  })

  it('allows an explicit available provider when the configured default needs connection', async () => {
    const api = vi.fn<Api>(async (path, opts) => path.endsWith('/options')
      ? response({ ...ready, status: 'needs_connection', defaultProviderId: null })
      : response(accepted(JSON.parse(opts!.body!).requestId)))
    const phone = load(api)
    await phone.openEntry(); phone.edit('我选已连接的这一位')
    phone.get('entry-provider').value = 'claude'; phone.get('entry-provider').handlers.change!({ target: phone.get('entry-provider') })
    expect(phone.get('entry-submit').disabled).toBe(false)
    await phone.submitEntry()
    expect(JSON.parse(api.mock.calls.find(([p]) => p.endsWith('/create'))![1]!.body!).providerId).toBe('claude')
  })

  it('explains the missing owner condition separately from executor connection', async () => {
    const phone = load(async () => response({ ...ready, status: 'needs_connection', providers: [], defaultProviderId: null,
      reason: { code: 'invalid_entry_owner', message: '请先在电脑上配置主人身份。' } }))
    await phone.openEntry()
    expect(phone.get('entry-notice').textContent).toContain('主人身份')
  })

  it('does not silently replace a saved project or provider that is no longer offered', async () => {
    let options: any = { ...ready, projects: [{ id: 'p-1234567890abcdef1234', name: '旧项目' }] }
    const api = vi.fn<Api>(async () => response(options)), first = load(api)
    await first.openEntry()
    first.get('entry-project').value = 'p-1234567890abcdef1234'; first.get('entry-project').handlers.change!({ target: first.get('entry-project') })
    first.get('entry-provider').value = 'claude'; first.get('entry-provider').handlers.change!({ target: first.get('entry-provider') })
    first.edit('保留我的选择')
    options = { ...ready, providers: [ready.providers[0]] }
    const refreshed = load(api, first.storage)
    await refreshed.restoreEntry(); await refreshed.submitEntry()
    expect(refreshed.state().draft.target.projectId).toBe('p-1234567890abcdef1234')
    expect(refreshed.state().draft.providerId).toBe('claude')
    expect(api.mock.calls.some(([p]) => p.endsWith('/create'))).toBe(false)
    expect(refreshed.get('entry-notice').textContent).toContain('重新选择')
  })

  it('keeps an unknown submission and refreshes by querying its original request ID', async () => {
    const api = vi.fn<Api>(async (path) => { if (path.endsWith('/options')) return response(ready); throw Error('offline') })
    const phone = load(api)
    await phone.openEntry(); phone.edit('别弄丢这句'); await phone.submitEntry()
    const submitted = phone.state().pending[0].input
    expect(phone.get('entry-notice').textContent).toContain('正在确认是否收到')
    expect(phone.get('entry-text').value).toBe('别弄丢这句')
    const recover = vi.fn<Api>(async path => path.endsWith('/options') ? response(ready) : response(accepted(submitted.requestId)))
    const refreshed = load(recover, phone.storage)
    await refreshed.restoreEntry()
    expect(recover).toHaveBeenCalledWith('/m/api/matter/create-receipt?requestId=' + submitted.requestId, undefined)
    expect(recover.mock.calls.some(([p]) => p.endsWith('/create'))).toBe(false)
    expect(refreshed.get('entry-text').value).toBe('')
    expect(refreshed.openMatter).not.toHaveBeenCalled()
    expect(refreshed.get('entry-history').innerHTML).toContain('查看这件事')
  })

  it('a missing receipt causes only an explicit retry with the same ID and frozen input', async () => {
    let posts = 0
    const api = vi.fn<Api>(async (path, opts) => {
      if (path.endsWith('/options')) return response(ready)
      if (path.includes('create-receipt')) return response({ ok: false, error: 'not_found' }, 404)
      if (++posts === 1) throw Error('offline')
      return response(accepted(JSON.parse(opts!.body!).requestId))
    })
    const phone = load(api)
    await phone.openEntry(); phone.edit('一个事项'); await phone.submitEntry()
    await phone.restoreEntry()
    expect(posts).toBe(1)
    await phone.submitEntry()
    const payloads = api.mock.calls.filter(([p]) => p.endsWith('/create')).map(([, opts]) => opts!.body)
    expect(payloads).toHaveLength(2)
    expect(payloads[0]).toBe(payloads[1])
  })

  it('the real transport resends the accepted LAN input over the tunnel with one identity', async () => {
    const matters = new Map<string, unknown>(), received: string[] = []
    const server: Api = async (path, opts) => {
      if (path.endsWith('/options')) return response(ready)
      const input = JSON.parse(opts!.body!); received.push(input.requestId)
      if (!matters.has(input.requestId)) matters.set(input.requestId, accepted(input.requestId))
      return response(matters.get(input.requestId))
    }
    const fetch: Api = async (path, opts) => {
      const result = await server(path, opts)
      if (path.endsWith('/create')) throw Error('response lost after acceptance')
      return result
    }
    const phone = load(server, undefined, { fetch, send: server })
    await phone.openEntry(); phone.edit('同一件'); await phone.submitEntry()
    expect(received).toHaveLength(2)
    expect(new Set(received).size).toBe(1)
    expect(matters.size).toBe(1)
    expect(phone.openMatter).toHaveBeenCalledTimes(1)
  })

  it('a late receipt cannot clear newer text or pull the user away from that draft', async () => {
    const pending = deferred<Response>()
    let requestId = ''
    const phone = load(async (path, opts) => {
      if (path.endsWith('/options')) return response(ready)
      requestId = JSON.parse(opts!.body!).requestId; return pending.promise
    })
    await phone.openEntry(); phone.edit('第一件'); const sending = phone.submitEntry()
    await Promise.resolve()
    expect(requestId).not.toBe('')
    phone.edit('后来写的新想法')
    pending.resolve(response(accepted(requestId))); await sending
    expect(phone.get('entry-text').value).toBe('后来写的新想法')
    expect(phone.state().pending).toHaveLength(0)
    expect(phone.state().last.receipt.requestId).toBe(requestId)
    expect(phone.openMatter).not.toHaveBeenCalled()
  })

  it.each(['matter', 'nav', 'hidden', 'offline'] as const)('a late receipt cannot navigate after leaving via %s', async kind => {
    const pending = deferred<Response>(); let requestId = ''
    const phone = load(async (path, opts) => {
      if (path.endsWith('/options')) return response(ready)
      requestId = JSON.parse(opts!.body!).requestId; return pending.promise
    })
    await phone.openEntry(); phone.edit('交办'); const sending = phone.submitEntry()
    await Promise.resolve()
    expect(requestId).not.toBe('')
    if (kind === 'matter') phone.leave()
    if (kind === 'nav') phone.nav.handlers.click!()
    if (kind === 'hidden') { phone.doc.hidden = true; phone.documentEvents.visibilitychange!(); phone.doc.hidden = false }
    if (kind === 'offline') phone.windowEvents.offline!()
    pending.resolve(response(accepted(requestId))); await sending
    expect(phone.state().pending).toHaveLength(0)
    expect(phone.openMatter).not.toHaveBeenCalled()
  })

  it('allocates a new ID only on an explicit new submission and keeps the unknown older one', async () => {
    const phone = load(async path => { if (path.endsWith('/options')) return response(ready); throw Error('offline') })
    await phone.openEntry(); phone.edit('上一件'); await phone.submitEntry()
    const original = phone.state().pending[0].input
    phone.edit('新的一件')
    expect(phone.state().draft.requestId).toBe(original.requestId)
    expect(phone.get('entry-submit').textContent).toBe('交办这件新事')
    await phone.submitEntry()
    expect(phone.state().pending.map((p: any) => p.input.text)).toEqual(['上一件', '新的一件'])
    expect(phone.state().pending[1].input.requestId).not.toBe(original.requestId)
  })

  it('rejects mismatched receipts without clearing the draft or navigating', async () => {
    const phone = load(async path => path.endsWith('/options') ? response(ready) : response(accepted('wrong-id')))
    await phone.openEntry(); phone.edit('还没确认'); await phone.submitEntry()
    expect(phone.get('entry-text').value).toBe('还没确认')
    expect(phone.state().pending).toHaveLength(1)
    expect(phone.openMatter).not.toHaveBeenCalled()
    expect(phone.get('entry-notice').textContent).toContain('正在确认是否收到')
  })

  it('does not truncate an overlong requirement or submit a whitespace-only one', async () => {
    const api = vi.fn<Api>(async () => response(ready)), phone = load(api)
    await phone.openEntry(); phone.edit('x'.repeat(20001)); await phone.submitEntry()
    expect(phone.get('entry-text').value).toHaveLength(20001)
    phone.edit(' \n '); await phone.submitEntry()
    expect(api.mock.calls.some(([p]) => p.endsWith('/create'))).toBe(false)
  })

  it('does not clear a newer draft revision even when the user edits back to the same text', async () => {
    const pending = deferred<Response>(); let requestId = ''
    const phone = load(async (path, opts) => {
      if (path.endsWith('/options')) return response(ready)
      requestId = JSON.parse(opts!.body!).requestId; return pending.promise
    })
    await phone.openEntry(); phone.edit('同一段文字'); const sending = phone.submitEntry()
    await Promise.resolve()
    phone.edit('修改中'); phone.edit('同一段文字')
    pending.resolve(response(accepted(requestId))); await sending
    expect(phone.state().pending).toHaveLength(0)
    expect(phone.get('entry-text').value).toBe('同一段文字')
    expect(phone.openMatter).not.toHaveBeenCalled()
  })

  it('repeated clicks while sending do not send another create request', async () => {
    const pending = deferred<Response>(); let requestId = ''
    const api = vi.fn<Api>(async (path, opts) => {
      if (path.endsWith('/options')) return response(ready)
      requestId = JSON.parse(opts!.body!).requestId; return pending.promise
    })
    const phone = load(api)
    await phone.openEntry(); phone.edit('只交办一次'); const sending = phone.submitEntry()
    await phone.submitEntry()
    pending.resolve(response(accepted(requestId))); await sending
    expect(api.mock.calls.filter(([p]) => p.endsWith('/create'))).toHaveLength(1)
  })

  it('a timeout preserves the persisted identity and says receipt is still unknown', async () => {
    vi.useFakeTimers()
    const phone = load(async path => path.endsWith('/options') ? response(ready) : new Promise(() => {}))
    await phone.openEntry(); phone.edit('网络慢也只办一件'); const sending = phone.submitEntry()
    await vi.advanceTimersByTimeAsync(15001); await sending
    expect(phone.state().pending).toHaveLength(1)
    expect(phone.get('entry-text').value).toBe('网络慢也只办一件')
    expect(phone.get('entry-notice').textContent).toContain('正在确认是否收到')
  })

  it('does not send when the browser cannot durably save the request identity', async () => {
    class FullStorage extends Map<string, string> { override set(): this { throw Error('quota exceeded') } }
    const api = vi.fn<Api>(async () => response(ready)), phone = load(api, new FullStorage())
    await phone.openEntry(); phone.edit('不能悄悄丢稿'); await phone.submitEntry()
    expect(api.mock.calls.some(([p]) => p.endsWith('/create'))).toBe(false)
    expect(phone.get('entry-notice').textContent).toContain('无法保存')
    expect(phone.get('entry-text').value).toBe('不能悄悄丢稿')
  })

  it('bounds unknown requests without removing the oldest snapshot', async () => {
    const api = vi.fn<Api>(async path => { if (path.endsWith('/options')) return response(ready); throw Error('offline') })
    const phone = load(api)
    await phone.openEntry()
    for (let i = 0; i < 9; i++) { phone.edit('事情 ' + i); await phone.submitEntry() }
    expect(api.mock.calls.filter(([p]) => p.endsWith('/create'))).toHaveLength(8)
    expect(phone.state().pending[0].input.text).toBe('事情 0')
    expect(phone.get('entry-text').value).toBe('事情 8')
    expect(phone.get('entry-notice').textContent).toContain('先确认一件')
  })

  it('accepts image-only entry after upload ready, freezes its snapshot, and acknowledges without discard', async () => {
    const create = deferred<Response>(); let sent: any
    const api = vi.fn<Api>(async (path, opts) => {
      if (path.endsWith('/options')) return response(ready)
      const body = JSON.parse(opts!.body!)
      if (path.endsWith('/chunk')) return response({ok:true,...body,taskId:null,nextOffset:body.size,status:'ready',attachment:{id:body.id,name:body.name,mime:body.mime,size:body.size,sha256:body.sha256}})
      sent = body; return create.promise
    })
    const phone = load(api); await phone.openEntry()
    await phone.materials().select([new File(['photo'],'photo.png',{type:'image/png'})])
    const ids = phone.materials().readyIds()
    expect(phone.get('entry-submit').disabled).toBe(false)
    const submitting = phone.submitEntry(); await Promise.resolve()
    expect(sent).toMatchObject({text:'',draftId:expect.any(String),attachmentIds:ids,target:{kind:'managed'}})
    await expect(phone.materials().remove(ids[0]!)).rejects.toThrow('attachment_frozen')
    expect(phone.state().pending[0].materials[0]).toMatchObject({id:ids[0],sha256:expect.any(String),size:5})
    create.resolve(response(accepted(sent.requestId))); await submitting
    expect(phone.materials().items()).toEqual([])
    expect(api.mock.calls.some(([p]) => p.endsWith('/discard'))).toBe(false)
    expect(phone.openMatter).toHaveBeenCalledWith('abcdef12')
  })

  it('keeps edited draft materials separate from a late receipt for the frozen old photo', async () => {
    const create = deferred<Response>(); let sent: any
    const api: Api = async (path, opts) => {
      if (path.endsWith('/options')) return response(ready)
      const body = JSON.parse(opts!.body!)
      if (path.endsWith('/chunk')) return response({ok:true,...body,taskId:null,nextOffset:body.size,status:'ready',attachment:{id:body.id,name:body.name,mime:body.mime,size:body.size,sha256:body.sha256}})
      sent = body; return create.promise
    }
    const phone = load(api); await phone.openEntry()
    await phone.materials().select([new File(['old'],'old.png',{type:'image/png'})])
    const submitting = phone.submitEntry(); await Promise.resolve()
    phone.edit('新的一件事')
    expect(phone.get('entry-notice').textContent).toContain('上一提交')
    expect(phone.materials().readyIds()).toEqual([])
    await phone.materials().select([new File(['new'],'new.png',{type:'image/png'})])
    const newer = phone.materials().readyIds()
    create.resolve(response(accepted(sent.requestId))); await submitting
    expect(phone.get('entry-text').value).toBe('新的一件事')
    expect(phone.materials().readyIds()).toEqual(newer)
    expect(phone.openMatter).not.toHaveBeenCalled()
  })

  it('does not submit partially uploaded materials alongside text', async () => {
    const uploading = deferred<Response>(),api = vi.fn<Api>(async path => path.endsWith('/options') ? response(ready) : uploading.promise)
    const phone = load(api); await phone.openEntry(); phone.edit('看这张图')
    const selected = phone.materials().select([new File(['x'],'photo.png',{type:'image/png'})])
    await vi.waitFor(() => expect(api.mock.calls.some(([p]) => p.endsWith('/chunk'))).toBe(true))
    await phone.submitEntry()
    expect(api.mock.calls.some(([p]) => p.endsWith('/create'))).toBe(false)
    const body = JSON.parse(api.mock.calls.find(([p]) => p.endsWith('/chunk'))![1]!.body!)
    uploading.resolve(response({ok:true,...body,taskId:null,nextOffset:body.size,status:'ready',attachment:{id:body.id,name:body.name,mime:body.mime,size:body.size,sha256:body.sha256}}));await selected
  })

  it('a changed project cannot reuse frozen materials belonging to the earlier submitted task', async () => {
    const api: Api = async (path, opts) => {
      if (path.endsWith('/options')) return response({...ready,projects:[{id:'p-1234567890abcdef1234',name:'项目'}]})
      const body = JSON.parse(opts!.body!)
      if (path.endsWith('/chunk')) return response({ok:true,...body,taskId:null,nextOffset:body.size,status:'ready',attachment:{id:body.id,name:body.name,mime:body.mime,size:body.size,sha256:body.sha256}})
      throw Error('offline')
    }
    const phone=load(api);await phone.openEntry();phone.edit('第一件')
    await phone.materials().select([new File(['old'],'old.png',{type:'image/png'})]);await phone.submitEntry()
    const original=phone.state().draft.draftId
    phone.get('entry-project').value='p-1234567890abcdef1234';phone.get('entry-project').handlers.change!({target:phone.get('entry-project')})
    expect(phone.state().draft.draftId).not.toBe(original)
    expect(phone.materials().readyIds()).toEqual([])
    expect(phone.state().pending[0].input.attachmentIds).toHaveLength(1)
    expect(phone.get('entry-notice').textContent).toContain('上一提交')
  })

  it('recovers a lost image-only receipt after refresh without uploading or discarding its frozen materials', async () => {
    const firstApi: Api = async (path,opts) => {
      if(path.endsWith('/options'))return response(ready)
      const body=JSON.parse(opts!.body!)
      if(path.endsWith('/chunk'))return response({ok:true,...body,taskId:null,nextOffset:body.size,status:'ready',attachment:{id:body.id,name:body.name,mime:body.mime,size:body.size,sha256:body.sha256}})
      throw Error('offline')
    }
    const first=load(firstApi);await first.openEntry();await first.materials().select([new File(['photo'],'photo.png',{type:'image/png'})]);await first.submitEntry()
    const snapshot=first.state().pending[0]
    expect(snapshot.materialSignature).toContain(snapshot.materials[0].sha256)
    const api=vi.fn<Api>(async path => path.endsWith('/options')?response(ready):response(accepted(snapshot.input.requestId)))
    const refreshed=load(api,first.storage);await refreshed.restoreEntry()
    expect(refreshed.state().pending).toEqual([]);expect(refreshed.materials().items()).toEqual([])
    expect(api.mock.calls.every(([p])=>p.endsWith('/options')||p.includes('/create-receipt?'))).toBe(true)
    expect(refreshed.openMatter).not.toHaveBeenCalled()
  })

  it('a definitive expired reservation preserves the requirement and requires fresh materials and an explicit new submit', async () => {
    let expire=true
    const api=vi.fn<Api>(async(path,opts)=>{
      if(path.endsWith('/options'))return response(ready)
      const body=JSON.parse(opts!.body!)
      if(path.endsWith('/chunk'))return response({ok:true,...body,taskId:null,nextOffset:body.size,status:'ready',attachment:{id:body.id,name:body.name,mime:body.mime,size:body.size,sha256:body.sha256}})
      return expire?response({ok:false,error:'entry_expired'},410):response(accepted(body.requestId))
    })
    const phone=load(api);await phone.openEntry();phone.edit('到期后也要留着的要求')
    await phone.materials().select([new File(['old'],'old.png',{type:'image/png'})]);const oldDraft=phone.state().draft.draftId
    await phone.submitEntry()
    const original=JSON.parse(api.mock.calls.find(([p])=>p.endsWith('/create'))![1]!.body!)
    expect(phone.state().pending).toEqual([])
    expect(phone.state().expired[0].input).toEqual(original)
    expect(phone.get('entry-text').value).toBe('到期后也要留着的要求')
    expect(phone.state().draft.draftId).not.toBe(oldDraft)
    expect(phone.materials().readyIds()).toEqual([])
    expect(phone.get('entry-notice').textContent).toContain('重新选择材料')
    expect(api.mock.calls.filter(([p])=>p.endsWith('/create'))).toHaveLength(1)
    expire=false;await phone.submitEntry()
    const next=JSON.parse(api.mock.calls.filter(([p])=>p.endsWith('/create'))[1]![1]!.body!)
    expect(next.requestId).not.toBe(original.requestId)
    expect(next.attachmentIds).toBeUndefined()
  })

  it.each([401,404,503])('HTTP %s does not expire an unknown request or unlock its submitted materials',async status=>{
    const api:Api=async(path,opts)=>{
      if(path.endsWith('/options'))return response(ready)
      const body=JSON.parse(opts!.body!)
      if(path.endsWith('/chunk'))return response({ok:true,...body,taskId:null,nextOffset:body.size,status:'ready',attachment:{id:body.id,name:body.name,mime:body.mime,size:body.size,sha256:body.sha256}})
      return response({ok:false,error:'unavailable'},status)
    }
    const phone=load(api);await phone.openEntry();await phone.materials().select([new File(['x'],'a.png',{type:'image/png'})]);await phone.submitEntry()
    expect(phone.state().pending).toHaveLength(1)
    expect(phone.materials().items()[0].frozen).toBe(true)
  })

  it('a late definitive expiry preserves the newer text and its separately uploaded materials',async()=>{
    const expired=deferred<Response>()
    const api:Api=async(path,opts)=>{
      if(path.endsWith('/options'))return response(ready)
      const body=JSON.parse(opts!.body!)
      if(path.endsWith('/chunk'))return response({ok:true,...body,taskId:null,nextOffset:body.size,status:'ready',attachment:{id:body.id,name:body.name,mime:body.mime,size:body.size,sha256:body.sha256}})
      return expired.promise
    }
    const phone=load(api);await phone.openEntry();phone.edit('旧要求')
    await phone.materials().select([new File(['old'],'old.png',{type:'image/png'})]);const sending=phone.submitEntry()
    phone.edit('已经写的新要求');await phone.materials().select([new File(['new'],'new.png',{type:'image/png'})])
    const latestDraft=phone.state().draft.draftId,latestIds=phone.materials().readyIds()
    expired.resolve(response({ok:false,error:'entry_expired'},410));await sending
    expect(phone.get('entry-text').value).toBe('已经写的新要求')
    expect(phone.state().draft.draftId).toBe(latestDraft)
    expect(phone.materials().readyIds()).toEqual(latestIds)
    expect(phone.state().pending).toEqual([])
    expect(phone.state().expired[0].input.text).toBe('旧要求')
    expect(phone.openMatter).not.toHaveBeenCalled()
  })

  it('known preflight rejection frees pending capacity while preserving each original requirement and material name',async()=>{
    let reject=true
    const api=vi.fn<Api>(async(path,opts)=>{
      if(path.endsWith('/options'))return response(ready)
      const body=JSON.parse(opts!.body!)
      if(path.endsWith('/chunk'))return response({ok:true,...body,taskId:null,nextOffset:body.size,status:'ready',attachment:{id:body.id,name:body.name,mime:body.mime,size:body.size,sha256:body.sha256}})
      return reject?response({ok:false,error:'api_task_attachment_unsupported'},422):response(accepted(body.requestId))
    })
    const phone=load(api);await phone.openEntry()
    for(let i=0;i<9;i++){
      phone.edit('请处理文件 '+i)
      await phone.materials().select([new File(['x'],'unsupported-'+i+'.pdf',{type:'application/pdf'})])
      await phone.submitEntry()
      expect(phone.state().pending).toEqual([])
      expect(phone.get('entry-text').value).toBe('请处理文件 '+i)
      expect(phone.get('entry-notice').textContent).toContain('重新选择材料')
      expect(phone.get('entry-submit').disabled).toBe(false)
    }
    expect(phone.state().rejected).toHaveLength(9)
    expect(phone.get('entry-history').innerHTML).toContain('unsupported-0.pdf')
    expect(phone.get('entry-history').innerHTML).toContain('unsupported-8.pdf')
    const originals=api.mock.calls.filter(([p])=>p.endsWith('/create')).map(([,opts])=>JSON.parse(opts!.body!))
    expect(new Set(originals.map(p=>p.requestId)).size).toBe(9)
    const refreshed=load(api,phone.storage);await refreshed.restoreEntry()
    expect(refreshed.get('entry-history').innerHTML).toContain('unsupported-0.pdf')
    expect(api.mock.calls.filter(([p])=>p.includes('create-receipt'))).toHaveLength(0)
    reject=false;await refreshed.submitEntry()
    const last=JSON.parse(api.mock.calls.filter(([p])=>p.endsWith('/create')).at(-1)![1]!.body!)
    expect(last.requestId).not.toBe(originals.at(-1).requestId)
    expect(refreshed.openMatter).toHaveBeenCalledWith('abcdef12')
  })

  it.each([[400,'api_task_input_invalid'],[422,'workbench_execution_unsupported']])('known HTTP %s %s can be explicitly corrected and submitted with a new identity',async(status,code)=>{
    const phone=load(async path=>path.endsWith('/options')?response(ready):response({ok:false,error:code},status as number))
    await phone.openEntry();phone.edit('原要求需要调整');await phone.submitEntry()
    expect(phone.state().pending).toEqual([])
    expect(phone.state().rejected[0].input.text).toBe('原要求需要调整')
    expect(phone.state().draft.requestId).toBeNull()
    expect(phone.get('entry-submit').disabled).toBe(false)
  })

  it.each([[401,'api_task_attachment_unsupported'],[404,'api_task_input_invalid'],[503,'api_task_attachment_unsupported'],[409,'creation_conflict'],[400,'unknown_failure']])('HTTP %s %s remains unknown even when another status or code would be definitive',async(status,code)=>{
    const phone=load(async path=>path.endsWith('/options')?response(ready):response({ok:false,error:code},status as number))
    await phone.openEntry();phone.edit('不能丢掉待确认身份');await phone.submitEntry()
    expect(phone.state().pending).toHaveLength(1)
    expect(phone.state().draft.requestId).toBe(phone.state().pending[0].input.requestId)
  })

  it('a receipt lookup error never becomes a definitive creation rejection',async()=>{
    const api:Api=async path=>{
      if(path.endsWith('/options'))return response(ready)
      if(path.includes('create-receipt'))return response({ok:false,error:'api_task_input_invalid'},400)
      throw Error('offline')
    }
    const phone=load(api);await phone.openEntry();phone.edit('可能已经收到的要求');await phone.submitEntry()
    const original=phone.state().pending[0].input
    await phone.submitEntry();await phone.restoreEntry()
    expect(phone.state().pending[0].input).toEqual(original)
    expect(phone.state().rejected).toEqual([])
  })

  it('recovers and removes a rejected original only on explicit history actions',async()=>{
    const api=vi.fn<Api>(async path=>path.endsWith('/options')?response(ready):response({ok:false,error:'api_task_input_invalid'},400))
    const phone=load(api);await phone.openEntry();phone.edit('请保留原要求');await phone.submitEntry()
    const original=phone.state().rejected[0].input
    phone.edit('')
    phone.get('entry-history').handlers.click!({target:{closest:()=>({dataset:{entryRecover:original.requestId}})}})
    expect(phone.get('entry-text').value).toBe('请保留原要求')
    expect(phone.state().draft.requestId).toBeNull()
    expect(api.mock.calls.filter(([p])=>p.endsWith('/create'))).toHaveLength(1)
    phone.get('entry-history').handlers.click!({target:{closest:()=>({dataset:{entryForget:original.requestId}})}})
    expect(phone.state().rejected).toEqual([])
    expect(phone.get('entry-text').value).toBe('请保留原要求')
  })

  it('late preflight rejection leaves a newer material draft intact and provides recovery for the original',async()=>{
    const rejected=deferred<Response>()
    const api:Api=async(path,opts)=>{
      if(path.endsWith('/options'))return response(ready)
      const body=JSON.parse(opts!.body!)
      if(path.endsWith('/chunk'))return response({ok:true,...body,taskId:null,nextOffset:body.size,status:'ready',attachment:{id:body.id,name:body.name,mime:body.mime,size:body.size,sha256:body.sha256}})
      return rejected.promise
    }
    const phone=load(api);await phone.openEntry();phone.edit('旧要求')
    await phone.materials().select([new File(['old'],'old.pdf',{type:'application/pdf'})]);const sending=phone.submitEntry()
    phone.edit('新草稿');await phone.materials().select([new File(['new'],'new.png',{type:'image/png'})])
    const latest=phone.state().draft,ids=phone.materials().readyIds()
    rejected.resolve(response({ok:false,error:'api_task_attachment_unsupported'},422));await sending
    expect(phone.get('entry-text').value).toBe('新草稿')
    expect(phone.state().draft.draftId).toBe(latest.draftId)
    expect(phone.materials().readyIds()).toEqual(ids)
    const old=phone.state().rejected[0]
    phone.get('entry-history').handlers.click!({target:{closest:()=>({dataset:{entryRecover:old.input.requestId}})}})
    expect(phone.get('entry-text').value).toBe('新草稿')
    expect(phone.get('entry-notice').textContent).toContain('当前还有新草稿')
    expect(phone.openMatter).not.toHaveBeenCalled()
  })

  it('reads the provider feature capability before allowing attached materials to be submitted',async()=>{
    const api=vi.fn<Api>(async(path,opts)=>{
      if(path.endsWith('/options'))return response({...ready,providers:[{...ready.providers[0],capabilities:{features:{attachments:false}}}]})
      const body=JSON.parse(opts!.body!)
      return response({ok:true,...body,taskId:null,nextOffset:body.size,status:'ready',attachment:{id:body.id,name:body.name,mime:body.mime,size:body.size,sha256:body.sha256}})
    })
    const phone=load(api);await phone.openEntry();phone.edit('带文件的要求')
    await phone.materials().select([new File(['x'],'a.png',{type:'image/png'})]);await phone.submitEntry()
    expect(phone.get('entry-submit').disabled).toBe(true)
    expect(api.mock.calls.some(([p])=>p.endsWith('/create'))).toBe(false)
    expect(phone.materials().readyIds()).toHaveLength(1)
    expect(phone.get('entry-notice').textContent).toContain('不能接收材料')
  })
})

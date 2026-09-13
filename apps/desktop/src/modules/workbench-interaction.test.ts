import { describe, expect, it, vi } from 'vitest'

const storage = () => {
  const values = new Map<string, string>()
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } }
}
const request = { id: 'request-A', taskId: 'A', createdAt: 1, questions: [
  { id: 'choice', header: 'Plan', question: 'Choose <script>', options: [{ label: 'Small', description: '<safe>' }, { label: 'Large', description: 'More' }], allowOther: true },
  { id: 'notes', header: 'Notes', question: 'Anything else?', options: [] },
] }

describe('workbench live interactions', () => {
  it('sends attachment-only supplements and binds retry identities and receipts to their files',async()=>{
    const {createWorkbenchInteractions}=await import('./workbench-interaction.js')
    const saved=storage(),a={id:crypto.randomUUID(),name:'image.png',mime:'image/png',size:3,sha256:'a'.repeat(64)},b={...a,id:crypto.randomUUID()},draftId=crypto.randomUUID()
    const bodies:any[]=[]
    const invoke=async(_method:string,_path:string,body:any)=>{bodies.push(body);throw Error('timeout')}
    const first=createWorkbenchInteractions({storage:saved,invokeWorkbenchApi:invoke})
    await first.sendInput('A','run-A','',{attachments:[a],draftId})
    expect(bodies[0]).toMatchObject({text:'',attachmentIds:[a.id],draftId})
    const reloaded=createWorkbenchInteractions({storage:saved,invokeWorkbenchApi:invoke})
    await reloaded.sendInput('A','run-A','',{attachments:[a],draftId})
    expect(bodies[1].requestId).toBe(bodies[0].requestId)
    await reloaded.sendInput('A','run-A','',{attachments:[b],draftId})
    expect(bodies[2].requestId).not.toBe(bodies[0].requestId)
    const receipt={id:bodies[2].requestId,taskId:'A',runId:'run-A',text:'',attachments:[a],status:'delivered' as const,createdAt:1,error:null}
    expect(reloaded.acknowledgedInputDraft('A',[receipt],[b])).toBeNull()
    expect(reloaded.acknowledgedInputDraft('A',[{...receipt,attachments:[b]}],[b])).toBe('')
  })
  it('persists terminal continuation identity across reload and binds it to task, text and ordered files',async()=>{
    const {createWorkbenchInteractions}=await import('./workbench-interaction.js')
    const saved=storage(),a={id:crypto.randomUUID(),name:'notes.txt',mime:'text/plain',size:3,sha256:'a'.repeat(64)},b={...a,id:crypto.randomUUID()}
    const first=createWorkbenchInteractions({storage:saved,invokeWorkbenchApi:vi.fn()})
    const requestId=first.continuationRequest('A','  original ',[a,b])
    const reloaded=createWorkbenchInteractions({storage:saved,invokeWorkbenchApi:vi.fn()})
    expect(reloaded.continuationRequest('A','original',[a,b])).toBe(requestId)
    expect(reloaded.continuationRequest('B','original',[a,b])).not.toBe(requestId)
    expect(reloaded.continuationRequest('A','original',[b,a])).not.toBe(requestId)
    expect(reloaded.continuationRequest('A','changed',[a,b])).not.toBe(requestId)
  })

  it('reconciles a lost terminal response only against its own durable continuation receipt',async()=>{
    const {createWorkbenchInteractions}=await import('./workbench-interaction.js')
    const saved=storage(),a={id:crypto.randomUUID(),name:'image.png',mime:'image/png',size:3,sha256:'a'.repeat(64)}
    const first=createWorkbenchInteractions({storage:saved,invokeWorkbenchApi:vi.fn()})
    const id=first.continuationRequest('A','',[a])
    const reloaded=createWorkbenchInteractions({storage:saved,invokeWorkbenchApi:vi.fn()})
    const receipt={id,taskId:'A',runId:'assigned-by-service',text:'',attachments:[a],status:'delivered' as const,createdAt:1,error:null}
    expect(reloaded.acknowledgedInputDraft('A',[{...receipt,taskId:'B'}],[a])).toBeNull()
    expect(reloaded.acknowledgedInputDraft('A',[{...receipt,attachments:[]}],[a])).toBeNull()
    expect(reloaded.acknowledgedInputDraft('A',[receipt],[])).toBeNull()
    expect(reloaded.acknowledgedInputDraft('A',[receipt],[a])).toBe('')
    reloaded.editInputDraft('A','',[a])
    expect(reloaded.continuationRequest('A','',[a])).not.toBe(id)
  })

  it('keeps an uncertain terminal request identity when its composer becomes a running-task supplement',async()=>{
    const {createWorkbenchInteractions}=await import('./workbench-interaction.js')
    const saved=storage(),a={id:crypto.randomUUID(),name:'notes.txt',mime:'text/plain',size:3,sha256:'a'.repeat(64)},sent:any[]=[]
    const first=createWorkbenchInteractions({storage:saved,invokeWorkbenchApi:vi.fn()})
    const id=first.continuationRequest('A','',[a])
    const reloaded=createWorkbenchInteractions({storage:saved,invokeWorkbenchApi:async(_method,_path,body)=>{
      sent.push(body);return{input:{id,taskId:'A',runId:'assigned-by-service',text:'',attachments:[a],status:'delivered',createdAt:1,error:null}}
    }})
    expect((await reloaded.sendInput('A','assigned-by-service','',{attachments:[a],draftId:crypto.randomUUID()}))?.id).toBe(id)
    expect(sent[0].requestId).toBe(id)
  })

  it('preserves an uncertain continuation after a cross-run input conflict and reconciles its original receipt',async()=>{
    const {createWorkbenchInteractions}=await import('./workbench-interaction.js')
    const saved=storage(),a={id:crypto.randomUUID(),name:'notes.txt',mime:'text/plain',size:3,sha256:'a'.repeat(64)},sent:any[]=[]
    const first=createWorkbenchInteractions({storage:saved,invokeWorkbenchApi:vi.fn()})
    const id=first.continuationRequest('A','',[a])
    const advanced=createWorkbenchInteractions({storage:saved,invokeWorkbenchApi:async(_method,_path,body)=>{sent.push(body);throw Error('input_conflict')}})
    expect(await advanced.sendInput('A','run-B','',{attachments:[a],draftId:crypto.randomUUID()})).toBeNull()
    expect(sent[0].requestId).toBe(id)
    const reloaded=createWorkbenchInteractions({storage:saved,invokeWorkbenchApi:vi.fn()})
    const receipt={id,taskId:'A',runId:'run-A',text:'',attachments:[a],status:'delivered' as const,createdAt:1,error:null}
    expect(reloaded.acknowledgedInputDraft('A',[receipt],[a])).toBe('')
    expect(reloaded.continuationRequest('A','',[a])).toBe(id)
    reloaded.editInputDraft('A','New request',[a])
    expect(reloaded.continuationRequest('A','New request',[a])).not.toBe(id)
  })

  it('retains answer drafts over reload but isolates tasks and replaced requests', async () => {
    const { createWorkbenchInteractions } = await import('./workbench-interaction.js')
    const saved = storage()
    const ui = createWorkbenchInteractions({ invokeWorkbenchApi: vi.fn(), storage: saved })
    ui.setDraft('A', 'request-A', { choice: { selected: ['Small'], other: '' }, notes: { selected: [], other: 'My answer' } })
    const reloaded = createWorkbenchInteractions({ invokeWorkbenchApi: vi.fn(), storage: saved })
    expect(reloaded.getDraft('A', 'request-A').notes?.other).toBe('My answer')
    expect(reloaded.getDraft('B', 'request-A')).toEqual({})
    expect(reloaded.getDraft('A', 'request-B')).toEqual({})
    expect([...saved.values.values()].join('')).not.toContain('Choose <script>')
  })

  it('uses one immutable supplement identity for duplicate clicks and unchanged retries, including reload', async () => {
    const { createWorkbenchInteractions } = await import('./workbench-interaction.js')
    const saved = storage(), sent: any[] = []
    let reject!: (reason: unknown) => void
    const api = vi.fn((_method, _path, body) => { sent.push(body); return new Promise((_resolve, fail) => { reject = fail }) })
    const ui = createWorkbenchInteractions({ invokeWorkbenchApi: api, storage: saved })
    const first = ui.sendInput('A', 'run-1', 'original')
    await ui.sendInput('A', 'run-1', 'original')
    expect(sent).toHaveLength(1)
    reject(new Error('offline')); expect(await first).toBeNull()
    expect(ui.inputState('A').error).toBeTruthy()
    const retryApi = vi.fn(async (_method, _path, body) => { sent.push(body); return { input: { id: body.requestId, taskId: body.id, runId: body.runId, text: body.text, status: 'pending', createdAt: 1, error: null } } })
    const retry = createWorkbenchInteractions({ invokeWorkbenchApi: retryApi, storage: saved })
    expect((await retry.sendInput('A', 'run-1', 'original'))?.status).toBe('pending')
    expect(sent[1]).toEqual(sent[0])
    await retry.sendInput('A', 'run-2', 'original')
    expect(sent[2].requestId).not.toBe(sent[0].requestId)
    expect(sent[2].runId).toBe('run-2')
  })

  it('keeps concurrent task failures and receipts separate and never invents delivered status', async () => {
    const { createWorkbenchInteractions } = await import('./workbench-interaction.js')
    const replies = new Map<string, (value: unknown) => void>()
    const ui = createWorkbenchInteractions({ invokeWorkbenchApi: async (_method, _path, body) => new Promise(resolve => replies.set(String(body?.id), resolve)) })
    const a = ui.sendInput('A', 'run-A', 'For A'), b = ui.sendInput('B', 'run-B', 'For B')
    expect(ui.inputState('A').busy).toBe(true); expect(ui.inputState('B').busy).toBe(true)
    replies.get('B')!({ input: { id: 'wrong', taskId: 'A', runId: 'run-A', text: 'For A', status: 'delivered' } })
    expect(await b).toBeNull()
    expect(ui.inputState('B').error).toBeTruthy(); expect(ui.inputState('A').error).toBe('')
    replies.get('A')!({})
    expect(await a).toBeNull()
  })

  it('normalizes supplement whitespace for dispatch, receipts and retries across reload', async () => {
    const { createWorkbenchInteractions } = await import('./workbench-interaction.js')
    const saved = storage(), sent: any[] = []
    const failing = createWorkbenchInteractions({ storage: saved, invokeWorkbenchApi: async (_method, _path, body) => { sent.push(body); throw new Error('offline') } })
    expect(await failing.sendInput('A', 'run-A', ' \n  First line\nSecond line\t ')).toBeNull()
    const reloaded = createWorkbenchInteractions({ storage: saved, invokeWorkbenchApi: async (_method, _path, body) => {
      sent.push(body)
      return { input: { id: body!.requestId, taskId: 'A', runId: 'run-A', text: 'First line\nSecond line', status: 'delivered', createdAt: 1, error: null } }
    } })
    const receipt = await reloaded.sendInput('A', 'run-A', '\tFirst line\nSecond line\n')
    expect(receipt?.status).toBe('delivered')
    expect(sent[0].text).toBe('First line\nSecond line')
    expect(sent[1]).toEqual(sent[0])
    expect(reloaded.inputState('A').error).toBe('')
  })

  it('retains a retry UUID saved before input whitespace normalization', async () => {
    const { createWorkbenchInteractions } = await import('./workbench-interaction.js')
    const saved = storage(), sent: any[] = []
    saved.setItem('cc.workbench.interaction.v1:input:A', JSON.stringify({ id: 'existing-request', runId: 'run-A', text: '  Original\n' }))
    const ui = createWorkbenchInteractions({ storage: saved, invokeWorkbenchApi: async (_method, _path, body) => {
      sent.push(body)
      return { input: { id: 'existing-request', taskId: 'A', runId: 'run-A', text: 'Original', status: 'delivered', createdAt: 1, error: null } }
    } })
    expect((await ui.sendInput('A', 'run-A', 'Original'))?.status).toBe('delivered')
    expect(sent).toEqual([{ id: 'A', runId: 'run-A', requestId: 'existing-request', text: 'Original' }])
  })

  it('reuses an acknowledged UUID after remount until the supplement content or run changes', async () => {
    const { createWorkbenchInteractions } = await import('./workbench-interaction.js')
    const saved = storage(), sent: any[] = []
    const api = async (_method: string, _path: string, body?: Record<string, unknown>) => {
      sent.push(body)
      return { input: { id: body!.requestId, taskId: body!.id, runId: body!.runId, text: body!.text, status: 'delivered', createdAt: 1, error: null } }
    }
    const old = createWorkbenchInteractions({ storage: saved, invokeWorkbenchApi: api })
    await old.sendInput('A', 'run-A', ' \n Original ')
    const mounted = createWorkbenchInteractions({ storage: saved, invokeWorkbenchApi: api })
    await mounted.sendInput('A', 'run-A', ' \n Original ')
    expect(sent[1].requestId).toBe(sent[0].requestId)
    await mounted.sendInput('A', 'run-A', 'Changed')
    expect(sent[2].requestId).not.toBe(sent[0].requestId)
  })

  it('keeps retries stable for whitespace edits but permits a newly composed supplement', async () => {
    const { createWorkbenchInteractions } = await import('./workbench-interaction.js')
    const sent: any[] = []
    const ui = createWorkbenchInteractions({ invokeWorkbenchApi: async (_method, _path, body) => {
      sent.push(body)
      if (sent.length === 1) throw new Error('offline')
      return { input: { id: body!.requestId, taskId: body!.id, runId: body!.runId, text: body!.text, status: 'delivered', createdAt: 1, error: null } }
    } })
    await ui.sendInput('A', 'run-A', 'Original')
    ui.editInputDraft('A', '\nOriginal ')
    await ui.sendInput('A', 'run-A', '\nOriginal ')
    expect(sent[1].requestId).toBe(sent[0].requestId)
    ui.editInputDraft('A', 'Original')
    await ui.sendInput('A', 'run-A', 'Original')
    expect(sent[2].requestId).not.toBe(sent[0].requestId)
  })

  it('binds answer and decline to the original task and request while blocking duplicates', async () => {
    const { createWorkbenchInteractions } = await import('./workbench-interaction.js')
    const sent: any[] = []; let finish!: () => void
    const ui = createWorkbenchInteractions({ invokeWorkbenchApi: async (method, path, body) => { sent.push({ method, path, body }); await new Promise<void>(resolve => { finish = resolve }); return { ok: true } } })
    ui.setDraft('A', request.id, { choice: { selected: ['Small'], other: '' }, notes: { selected: [], other: 'First answer' } })
    const pending = ui.answer(request)
    ui.setDraft('A', request.id, { choice: { selected: ['Large'], other: '' } })
    await ui.answer(request, true)
    expect(sent).toEqual([{ method: 'POST', path: '/v1/workbench/answer', body: { id: 'A', requestId: 'request-A', answers: { choice: ['Small'], notes: ['First answer'] } } }])
    finish(); expect(await pending).toBe(true)
    expect(ui.getDraft('A', request.id)).toEqual({})
    expect(ui.questionState('A', request.id).resolved).toBe(true)
    await ui.answer(request)
    expect(sent).toHaveLength(1)
    const declined = ui.answer({ ...request, id: 'request-B' }, true)
    expect(sent[1].body).toEqual({ id: 'A', requestId: 'request-B', answers: null })
    finish(); await declined
  })

  it('does not discard failed answers and validates missing or oversized text before sending', async () => {
    const { createWorkbenchInteractions } = await import('./workbench-interaction.js')
    const api = vi.fn(async () => { throw new Error('offline') })
    const ui = createWorkbenchInteractions({ invokeWorkbenchApi: api })
    expect(await ui.answer(request)).toBe(false); expect(api).not.toHaveBeenCalled()
    ui.setDraft('A', request.id, { choice: { selected: ['Small'], other: '' }, notes: { selected: [], other: 'saved' } })
    expect(await ui.answer(request)).toBe(false)
    expect(ui.getDraft('A', request.id).notes?.other).toBe('saved')
    expect(await ui.sendInput('A', 'run-A', 'x'.repeat(20001))).toBeNull()
    expect(api).toHaveBeenCalledTimes(1)
  })

  it('renders escaped, keyboard-native questions and truthful receipts without permission actions', async () => {
    const { renderWorkbenchQuestions, renderWorkbenchInputs } = await import('./workbench-interaction.js')
    const html = renderWorkbenchQuestions('A', [request, { ...request, id: 'other', taskId: 'B' }])
    expect(html).toContain('Choose &lt;script&gt;'); expect(html).not.toContain('Choose <script>')
    expect(html).toContain('<fieldset'); expect(html).toContain('<legend'); expect(html).toContain('type="radio"')
    expect(html).toContain('<textarea'); expect(html).toContain('type="submit"'); expect(html).toContain('data-action="decline-question"')
    const buttons = html.match(/<button[^>]+>/g) ?? []
    expect(buttons).toHaveLength(2)
    expect(buttons.every(button => / id="[^"]+"/.test(button))).toBe(true)
    expect(html).not.toContain('data-action="allow-permission"'); expect(html).not.toContain('data-request-id="other"')
    const receipts = renderWorkbenchInputs('A', ['pending', 'sending', 'held', 'withdrawn', 'delivered'].map((status, index) => ({ id: `input-${index}`, taskId: 'A', runId: 'run-A', text: `<${status}>`, status, createdAt: 1, error: null })) as any)
    expect(receipts).toContain('等待下一轮'); expect(receipts).toContain('等待交付确认'); expect(receipts).toContain('未发送'); expect(receipts).toContain('已撤回'); expect(receipts).toContain('已交付')
    expect(receipts.match(/data-action="withdraw-input"/g)).toHaveLength(1)
    expect(receipts.match(/data-action="copy-held-input"/g)).toHaveLength(1)
    expect(receipts).toContain('&lt;held&gt;')
  })

  it('switches single-choice answers between text and options without discarding multi-choice additions', async () => {
    const { syncWorkbenchQuestionChoice } = await import('./workbench-interaction.js')
    const radio = { type: 'radio', checked: true }, other = { value: 'My alternative' }
    const fieldset = { querySelector: () => other, querySelectorAll: () => [radio] }
    const textField = { dataset: { questionOther: '' }, value: 'My alternative', closest: () => fieldset }
    syncWorkbenchQuestionChoice(textField as any)
    expect(radio.checked).toBe(false)
    radio.checked = true
    syncWorkbenchQuestionChoice({ type: 'radio', checked: true, dataset: {}, closest: () => fieldset } as any)
    expect(other.value).toBe('')
    other.value = 'An extra note'
    syncWorkbenchQuestionChoice({ type: 'checkbox', checked: true, dataset: {}, closest: () => fieldset } as any)
    expect(other.value).toBe('An extra note')
  })

  it('distinguishes uncertain native delivery from unsent held inputs without exposing provider errors', async () => {
    const { renderWorkbenchInputs } = await import('./workbench-interaction.js')
    const html = renderWorkbenchInputs('A', [
      { id: 'uncertain', taskId: 'A', runId: 'run-A', text: 'Check this', status: 'held', createdAt: 1, error: '未确认执行者收到，请检查当前对话后再决定是否重发。 private provider detail' },
      { id: 'stopped', taskId: 'A', runId: 'run-A', text: 'Stopped draft', status: 'held', createdAt: 1, error: 'cancelled' },
    ])
    expect(html).toContain('未确认交付')
    expect(html).toContain('请先检查当前对话，再决定是否重发')
    expect(html).toContain('未发送')
    expect(html).not.toContain('private provider detail')
    expect(html).not.toContain('cancelled')
  })
})

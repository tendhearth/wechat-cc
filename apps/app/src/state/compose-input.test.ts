// @vitest-environment happy-dom
import { createHash } from 'node:crypto'
import { act, createElement, type ReactNode } from 'react'
import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PHONE_API_SCHEMAS, type ClientOpts, type ProtocolClient, type ProtocolRequest } from '@wechat-cc/protocol'
import { makeLiveBackend } from '../backend/live'
import { DETAIL, ID, OPTIONS, RUN, WB_TASK, RECEIPT } from '../backend/fixtures'
import type { Backend, MatterInputT } from '../backend/types'
import { clearDrafts, getDraft, getDraftImages, getEntrySettings, setDraft, setEntrySettings } from '../state/drafts'
import { makeStore, type Store } from '../state/store'
import { watchConnection } from '../state/wiring'
import { makeInputJournal } from './input-journal'
import { matterInputState, matterInputs } from '../state/matter-inputs'
import Compose from '../app/compose'
import Matter from '../app/matter/[id]'

type Root = { render(node: ReactNode): void; unmount(): void }
const createRoot = createRequire(import.meta.url)('react-dom/client').createRoot as (container: Element) => Root
const roots: Root[] = []
const disposers: Array<() => void> = []
const host = vi.hoisted(() => ({ ctx: null as unknown as { backend: Backend; store: Store }, params: {} as Record<string, string>, back: vi.fn(), push: vi.fn(), replace: vi.fn(), pickerGate: null as null | Promise<any>, sources: [] as { text: unknown; selectable?: boolean; id?: string }[] }))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

// 只替换原生宿主、路由与 provider 取值;真实请求、缓存、订阅、文本与回执组件一起执行。
vi.mock('react-native', async () => {
  const { createElement, forwardRef } = await import('react')
  const View = ({ children, testID, accessibilityLabel }: any) => createElement('div', { 'data-testid': testID, 'aria-label': accessibilityLabel }, children)
  const Text = ({ children, onPress, testID, accessibilityRole, selectable }: any) => {
    host.sources.push({ text: children, selectable, id: testID })
    return createElement('span', { 'data-testid': testID, role: accessibilityRole, onClick: onPress }, children)
  }
  const TextInput = forwardRef<any, any>(({ value, onChangeText, testID, accessibilityLabel }: any, ref) => createElement('textarea', {
    value, 'data-testid': testID, 'aria-label': accessibilityLabel, ref,
    onInput: (event: any) => onChangeText(event.currentTarget.value),
  }))
  const Pressable = ({ children, onPress, disabled, testID, accessibilityLabel, accessibilityRole, accessibilityState }: any) => createElement('button', {
    onClick: onPress, disabled, 'data-testid': testID, 'aria-label': accessibilityLabel, role: accessibilityRole,
    'aria-expanded': accessibilityState?.expanded, 'aria-disabled': accessibilityState?.disabled,
  }, children)
  const Modal = ({ children, visible }: any) => visible ? createElement('div', null, children) : null
  return { View, Image: View, Text, TextInput, Pressable, Modal, ScrollView: View, KeyboardAvoidingView: View, ActivityIndicator: View, Linking: { openURL: vi.fn() }, Platform: { OS: 'ios', select: (options: any) => options.ios ?? options.default } }
})
vi.mock('react-native-safe-area-context', async () => {
  const { createElement } = await import('react')
  return { SafeAreaView: ({ children }: any) => createElement('main', null, children) }
})
vi.mock('expo-router', () => ({ useLocalSearchParams: () => host.params, useRouter: () => ({ canGoBack: () => true, back: host.back, push: host.push, replace: host.replace }), Redirect: () => null }))
vi.mock('../i18n/useLang', () => ({ useLang: () => 'zh-Hans' }))
vi.mock('../state/BackendProvider', () => ({ useBackendCtx: () => host.ctx }))
vi.mock('../state/session', () => ({ useSession: () => ({ pairing: null, inputScope: matterInputState.recovery().scope }) }))
vi.mock('../ui/TopBar', () => ({ TopBar: () => null }))
vi.mock('../net/image-pick', () => ({ pickImages: async () => host.pickerGate ?? ({images:[{id:'22222222-2222-4222-8222-222222222222',name:'photo.png',mime:'image/png',size:3,sha256:'a'.repeat(64),bytes:new Uint8Array([1,2,3]),uri:'test://image'}],skipped:null}) }))

type Reply = { status: number; json: unknown } | Error
const ok = (json: unknown, status = 200): Reply => ({ status, json })
type Request = { path: string; method: string; body: any; retry?: boolean }
function harness() {
  let detail: any = structuredClone(DETAIL)
  let entryOptions: any = structuredClone(OPTIONS)
  let say: (request: Request) => Reply | Promise<Reply> = request => {
    const input: MatterInputT = { id: request.body.requestId, taskId: ID, runId: request.body.runId ?? RUN, text: request.body.text, status: 'sending' }
    detail.inputs.push(input)
    return ok({ ok: true, result: { kind: 'task', task: WB_TASK, input } })
  }
  let create: (request: Request) => Reply | Promise<Reply> = () => ok({ ok: true, receipt: RECEIPT, task: WB_TASK }, 202)
  let read: (() => Reply | Promise<Reply>) | undefined
  const requests: Request[] = []
  const clients: Array<{ opts: ClientOpts; subs: Map<string, (d: unknown) => void> }> = []
  const makeClient = (opts: ClientOpts): ProtocolClient => {
    const client = { opts, subs: new Map<string, (d: unknown) => void>() }; clients.push(client)
    return {
      version: () => 2,
      async request(req: ProtocolRequest) {
        const request = { path: req.path, method: req.method, body: typeof req.body === 'string' ? JSON.parse(req.body) : undefined, retry: req.retry }
        requests.push(request)
        const path = req.path.split('?')[0]
        let reply: Reply
        if (path === '/m/api/matter') reply = read ? await read() : ok({ ok: true, ...detail })
        else if (path === '/m/api/matter/input-receipt') {
          const id = new URLSearchParams(req.path.split('?')[1]).get('requestId')
          const input = detail.inputs.find((row: MatterInputT) => row.id === id)
          reply = input ? ok({ ok: true, input }) : ok({ ok: false, error: 'not_found' }, 404)
        }
        else if (path === '/m/api/matter/say') reply = await say(request)
        else if (path === '/m/api/matter/create') reply = await create(request)
        else if (path === '/m/api/entry/options') reply = ok({ ok: true, ...entryOptions })
        else if (path === '/m/api/entry/models') reply = ok({ok:true,catalog:{source:'native',defaultModel:'test-model',models:[{id:'test-model',displayName:'Test model',reasoningEfforts:['low','high']}]}})
        else if (path === '/m/api/attachment/upload') { const q=new URLSearchParams(req.path.split('?')[1]); reply=ok({ok:true,id:q.get('id'),draftId:q.get('draftId'),taskId:null,size:3,sha256:'a'.repeat(64),nextOffset:3,status:'ready'}) }
        else if (path === '/m/api/matter/insight') reply = ok({ ok: true, explanations: {}, progress: null })
        else if (path === '/m/api/matter/changes') reply = ok({ ok: true, turn: null })
        else throw new Error(`unexpected route ${path}`)
        if (reply instanceof Error) throw reply
        const schema = PHONE_API_SCHEMAS[`${req.method} ${path}`]
        if (reply.status < 400) expect(schema?.safeParse(reply.json).success, path).toBe(true)
        const text = JSON.stringify(reply.json)
        return { status: reply.status, headers: {}, body: new TextEncoder().encode(text), text: () => text, json: <T,>() => JSON.parse(text) as T }
      },
      subscribe(topic, callback) { client.subs.set(topic, data => callback(data, { epoch: 'test', seq: 1 })); return () => { client.subs.delete(topic) } },
      close() {},
    }
  }
  const backend = makeLiveBackend({ open: () => { throw new Error('no network') }, token: 'test-only', makeClient })
  const store = makeStore(backend, { lang: 'zh-Hans' })
  const stop = watchConnection(backend, store, () => {})
  disposers.push(() => { stop(); backend.dispose() })
  const status = (state: 'ready' | 'down' | 'connecting') => clients.at(-1)!.opts.onStatus?.(state)
  status('ready')
  host.ctx = { backend, store }
  host.params = { matter: ID, id: ID }
  return {
    backend, store, requests, status,
    posts: () => requests.filter(request => request.path === '/m/api/matter/say'),
    detail: () => detail,
    setOptions: (next: any) => { entryOptions=next },
    setDetail: (next: any) => { detail = next },
    setSay: (next: typeof say) => { say = next },
    setCreate: (next: typeof create) => { create = next },
    setRead: (next: typeof read) => { read = next },
    version: (version: number) => clients.at(-1)!.subs.get(`matter/${ID}`)?.({ found: true, kind: 'task', version, phase: 'working' }),
  }
}
beforeEach(async () => {
  host.pickerGate=null; clearDrafts(); host.back.mockClear(); host.push.mockClear(); host.replace.mockClear(); host.sources.length = 0
  const disk = new Map<string,string>()
  matterInputState.configure(makeInputJournal({ getItemAsync: async k => disk.get(k) ?? null, setItemAsync: async (k,v) => { disk.set(k,v) }, deleteItemAsync: async k => { disk.delete(k) } }, async s => createHash('sha256').update(s).digest('hex')))
  await matterInputState.activate({ v: 1, relayHost: 'test', relayUrl: 'wss://test', daemonId: 'test', deviceId: 'test', deviceToken: 'private-test-token', pairedAt: 1 })
})
afterEach(async () => {
  await act(() => { for (const root of roots.splice(0)) root.unmount() })
  for (const dispose of disposers.splice(0)) dispose()
  await act(async () => { matterInputState.configure(undefined); await matterInputState.clear() })
  document.body.innerHTML = ''
})
async function flush() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }) }
async function mount(component = Compose) {
  const container = document.createElement('div'); document.body.appendChild(container)
  const root = createRoot(container); roots.push(root)
  await act(() => root.render(createElement(component)))
  await flush()
  const byId = <T extends Element = HTMLElement>(id: string) => container.querySelector<T>(`[data-testid="${id}"]`)!
  const type = async (text: string) => { await act(() => {
    const textarea = byId<HTMLTextAreaElement>('compose-input')
    textarea.value = text; textarea.dispatchEvent(new Event('input', { bubbles: true }))
  }) }
  const click = async (id: string) => { await act(() => byId<HTMLButtonElement>(id).click()); await flush() }
  return { container, root, byId, type, click }
}
function gate<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }

describe('real LiveBackend + native compose inputs', () => {
  it('sends a running steer supplement to the current run and displays its actual receipt without claiming completion', async () => {
    const h = harness()
    const ui = await mount()
    await ui.type('\n**把按钮放左边**\n')
    await ui.click('compose-send')
    const post = h.posts()[0]!
    expect(post.body).toEqual({ id: ID, runId: RUN, requestId: expect.any(String), text: '**把按钮放左边**' })
    expect(post.retry).toBe(false)
    expect(post.body).not.toHaveProperty('inputMode')
    expect(ui.byId(`input-status-${post.body.requestId}`).textContent).toBe('正在交给执行者。')
    expect(ui.container.textContent).toContain('补充这一轮的要求')
    expect(getDraft(ID)).toBe('')
    expect(host.back).not.toHaveBeenCalled()
    await ui.click('message-source-toggle')
    expect(ui.byId('message-source-text').textContent).toBe('\n**把按钮放左边**\n')
    expect(host.sources).toContainEqual({ text: '\n**把按钮放左边**\n', selectable: true, id: 'message-source-text' })
  })
  it.each(['pending', 'delivered', 'held', 'withdrawn'] as const)('renders the actual %s receipt; held/withdrawn retain the draft', async status => {
    const h = harness()
    h.detail().inputMode = 'queue'
    h.setSay(request => {
      const input = { id: request.body.requestId, taskId: ID, runId: RUN, text: request.body.text, status }
      h.detail().inputs = [input]
      return ok({ ok: true, result: { kind: 'task', task: WB_TASK, input } })
    })
    const ui = await mount()
    await ui.type('这一条补充'); await ui.click('compose-send')
    expect(ui.container.textContent).toContain('补充会排队接着做')
    const wording = { pending: '已排队，执行者会稍后接着处理。', delivered: '执行者已收到这条补充。', held: '保留了这条补充，查看进展再决定。', withdrawn: '这条补充已撤回，原文仍可取回。' }
    expect(ui.byId(`input-status-${h.posts()[0]!.body.requestId}`).textContent).toBe(wording[status])
    expect(getDraft(ID)).toBe(['held', 'withdrawn'].includes(status) ? '这一条补充' : '')
  })
  it('uses the existing run in idle/send mode; an imported first turn without a run keeps the continuation route', async () => {
    const h = harness()
    h.detail().inputMode = 'send'; h.detail().task.status = 'idle'
    const ui = await mount(); await ui.type('继续'); await ui.click('compose-send')
    expect(h.posts()[0]!.body.runId).toBe(RUN)
    await act(() => ui.root.unmount()); roots.splice(roots.indexOf(ui.root), 1)
    clearDrafts()
    delete h.detail().runId; h.detail().inputs = []
    const next = await mount(); await next.type('第一句'); await next.click('compose-send')
    expect(h.posts()[1]!.body).not.toHaveProperty('runId')
  })
  it.each(['input_stale', 'input_conflict'])('shows a known %s rejection and keeps the original draft', async error => {
    const h = harness(); h.setSay(() => ok({ ok: false, error }, 409))
    const ui = await mount(); await ui.type('保留我的要求'); await ui.click('compose-send')
    expect(getDraft(ID)).toBe('保留我的要求')
    expect(ui.byId(`input-status-${h.posts()[0]!.body.requestId}`).textContent).toContain(error === 'input_stale' ? '进展已变' : '记录需要核对')
    expect(ui.container.textContent).not.toContain('已排队')
    expect(ui.container.querySelector('[data-testid^="input-retry-"]')).toBeNull()
  })
  it('retries an uncertain request with its fixed id/run/body even after the run and draft have changed', async () => {
    const h = harness(); const sent = gate<Reply>()
    h.setSay(() => sent.promise)
    const ui = await mount(); await ui.type('  第一条 **要求**\n')
    await act(() => ui.byId<HTMLButtonElement>('compose-send').click())
    await flush()
    const original = h.posts()[0]!.body
    await ui.type('后来写的另一条要求')
    await act(() => sent.resolve(new Error('timeout'))); await flush()
    expect(ui.byId(`input-status-${original.requestId}`).textContent).toContain('还没确认')
    expect(getDraft(ID)).toBe('后来写的另一条要求')
    h.setDetail({ ...h.detail(), runId: '7f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b', inputs: [] })
    h.setSay(request => {
      const input = { id: original.requestId, taskId: ID, runId: RUN, text: original.text, status: 'delivered' }
      h.detail().inputs = [input]
      return ok({ ok: true, result: { kind: 'task', task: WB_TASK, input } })
    })
    await act(() => { h.status('down'); h.status('ready') }); await flush()
    expect(h.posts()).toHaveLength(1)
    await ui.click(`input-retry-${original.requestId}`)
    expect(h.posts()[1]!.body).toEqual(original)
    expect(getDraft(ID)).toBe('后来写的另一条要求')
    await ui.click(`input-restore-${original.requestId}`)
    expect(ui.byId('compose-input-notice').textContent).toContain('输入框中有新的补充')
    expect(getDraft(ID)).toBe('后来写的另一条要求')
    await ui.type(''); await ui.click(`input-restore-${original.requestId}`)
    expect(getDraft(ID)).toBe('  第一条 **要求**\n')
    expect(ui.byId<HTMLTextAreaElement>('compose-input').value).toBe('  第一条 **要求**\n')
  })
  it('reconciles after leaving/reopening and reconnecting with exact remote receipts, without replaying POST', async () => {
    const h = harness(); h.setSay(() => new Error('timeout'))
    let ui = await mount(); await ui.type('原稿'); await ui.click('compose-send')
    const request = h.posts()[0]!.body
    await act(() => ui.root.unmount()); roots.splice(roots.indexOf(ui.root), 1)
    h.detail().inputs = [{ id: request.requestId, taskId: ID, runId: RUN, text: request.text, status: 'delivered' }]
    ui = await mount()
    expect(ui.byId(`input-status-${request.requestId}`).textContent).toContain('已收到')
    expect(getDraft(ID)).toBe('')
    expect(h.posts()).toHaveLength(1)
    await ui.type('新稿')
    await act(() => { h.status('down'); h.status('ready') }); await flush()
    expect(getDraft(ID)).toBe('新稿')
    expect(h.posts()).toHaveLength(1)
  })
  it('keeps an uncertain first continuation without runId on the same route when later detail has a run', async () => {
    const h = harness(); delete h.detail().runId; h.setSay(() => new Error('timeout'))
    const ui = await mount(); await ui.type('第一次接着做'); await ui.click('compose-send')
    const original = h.posts()[0]!.body
    expect(original).not.toHaveProperty('runId')
    h.detail().runId = RUN
    await act(() => { h.status('down'); h.status('ready') }); await flush()
    h.setSay(request => {
      const input = { id: original.requestId, taskId: ID, runId: RUN, text: original.text, status: 'delivered' }
      h.detail().inputs = [input]
      return ok({ ok: true, result: { kind: 'task', task: WB_TASK, input } })
    })
    await ui.click(`input-retry-${original.requestId}`)
    expect(h.posts()[1]!.body).toEqual(original)
    expect(getDraft(ID)).toBe('')
  })
  it('does not mistake a same-id receipt from another run for delivery', async () => {
    const h = harness(); h.setSay(request => ok({ ok: true, result: { kind: 'task', task: WB_TASK, input: { id: request.body.requestId, taskId: ID, runId: '7f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b', text: request.body.text, status: 'delivered' } } }))
    const ui = await mount(); await ui.type('别误认'); await ui.click('compose-send')
    expect(getDraft(ID)).toBe('别误认')
    expect(ui.byId(`input-status-${h.posts()[0]!.body.requestId}`).textContent).toContain('需要核对')
  })
  it('holds the first send until a fresh detail arrives and preserves drafts if that read fails', async () => {
    const h = harness(); const read = gate<Reply>()
    await h.store.query(`matter:${ID}`, () => h.backend.matter(ID, 'zh-Hans')).refresh()
    setDraft(ID, '草稿')
    h.setRead(() => read.promise)
    const ui = await mount()
    expect(ui.byId<HTMLButtonElement>('compose-send').disabled).toBe(true)
    await act(() => read.resolve(new Error('daemon_offline'))); await flush()
    expect(ui.byId('compose-detail-state').textContent).toContain('没能核对')
    expect(getDraft(ID)).toBe('草稿')
    expect(h.posts()).toHaveLength(0)
    h.setRead(undefined)
    await ui.click('compose-detail-reload')
    expect(ui.byId<HTMLButtonElement>('compose-send').disabled).toBe(false)
  })
  it('updates delivery through the matter version subscription', async () => {
    const h = harness(); const ui = await mount()
    await act(() => h.version(1)); await ui.type('要看更新'); await ui.click('compose-send')
    const request = h.posts()[0]!.body
    h.detail().inputs[0].status = 'delivered'
    await act(() => h.version(2)); await flush()
    expect(ui.byId(`input-status-${request.requestId}`).textContent).toBe('执行者已收到这条补充。')
    expect(h.posts()).toHaveLength(1)
  })
  it.each(['held', 'withdrawn'] as const)('a late pending POST response cannot overwrite a newer %s subscription receipt or clear the original', async status => {
    const h = harness(), sent = gate<Reply>(), refresh = gate<Reply>(), raw = '\r\n  **保留这一条原文**\r\n'
    h.setSay(() => sent.promise)
    const ui = await mount(); await act(() => h.version(1)); await ui.type(raw)
    await act(() => ui.byId<HTMLButtonElement>('compose-send').click()); await flush()
    const request = h.posts()[0]!.body
    const newer = { id: request.requestId, taskId: ID, runId: RUN, text: request.text, status }
    h.detail().inputs = [newer]; await act(() => h.version(2)); await flush()
    expect(matterInputs(ID)[0]?.status).toBe(status); expect(getDraft(ID)).toBe(raw)
    // Keep the post-response detail read pending so it cannot hide a transient wrong update.
    h.setRead(() => refresh.promise)
    await act(() => sent.resolve(ok({ ok: true, result: { kind: 'task', task: WB_TASK, input: { ...newer, status: 'pending' } } }))); await flush()
    expect(matterInputs(ID)[0]?.status).toBe(status); expect(getDraft(ID)).toBe(raw)
    expect(ui.byId<HTMLTextAreaElement>('compose-input').value).toBe(raw)
    expect(h.posts()).toHaveLength(1)
    await act(() => refresh.resolve(ok({ ok: true, ...h.detail() }))); await flush()
  })
  it('keeps old chat say and create routes compatible, including a draft edited during a successful create', async () => {
    const h = harness(); h.detail().matter.kind = 'chat'; h.detail().task = null; h.detail().inputs = []
    h.setSay(() => ok({ ok: true, result: { kind: 'chat', reply: '好' } }))
    const ui = await mount(); await ui.type('聊天'); await ui.click('compose-send')
    expect(h.posts()[0]!.body).not.toHaveProperty('runId')
    expect(host.back).toHaveBeenCalledOnce()
    await act(() => ui.root.unmount()); roots.splice(roots.indexOf(ui.root), 1)
    host.params = {}; const create = gate<Reply>(); h.setCreate(() => create.promise)
    const next = await mount(); await next.type('交办')
    await act(() => next.byId<HTMLButtonElement>('compose-send').click()); await flush()
    await next.type('另一件事草稿')
    await act(() => create.resolve(ok({ ok: true, receipt: RECEIPT, task: WB_TASK }, 202))); await flush()
    expect(getDraft('new')).toBe('另一件事草稿')
    expect(host.replace).not.toHaveBeenCalled()
    expect(next.byId('compose-accepted-draft').textContent).toContain('已接下')
    await next.click('compose-accepted-progress')
    expect(host.push).toHaveBeenCalledWith(`/matter/${ID}`)
  })
  it('shows the same receipts on the real matter page and restores the exact original without overwriting a newer draft', async () => {
    const h = harness(); const ui = await mount(); await ui.type('\n**要求**\n'); await ui.click('compose-send')
    const request = h.posts()[0]!.body
    await act(() => ui.root.unmount()); roots.splice(roots.indexOf(ui.root), 1)
    const progress = await mount(Matter)
    expect(progress.byId(`input-status-${request.requestId}`).textContent).toBe('正在交给执行者。')
    setDraft(ID, '新稿')
    await progress.click(`input-restore-${request.requestId}`)
    expect(getDraft(ID)).toBe('新稿')
    expect(host.push).not.toHaveBeenCalled()
    setDraft(ID, '')
    await progress.click(`input-restore-${request.requestId}`)
    expect(getDraft(ID)).toBe('\n**要求**\n')
    expect(host.push).toHaveBeenCalledWith(`/compose?matter=${ID}`)
    expect(matterInputs(ID)[0]!.rawText).toBe('\n**要求**\n')
  })
})


describe('real Compose durable send boundary', () => {
  const rec = { v: 1 as const, relayHost: 'test', relayUrl: 'wss://test', daemonId: 'test', deviceId: 'test', deviceToken: 'private-test-token', pairedAt: 1 }
  const hash = async (text: string) => createHash('sha256').update(text).digest('hex')
  it('a Keychain failure happens before POST and leaves the exact original in the input and record', async () => {
    const h = harness(), disk = new Map<string, string>(); let failing = false
    const journal = makeInputJournal({
      getItemAsync: async k => disk.get(k) ?? null,
      setItemAsync: async (k, v) => { if (failing) throw new Error('keychain'); disk.set(k, v) },
      deleteItemAsync: async k => { disk.delete(k) },
    }, hash)
    matterInputState.configure(journal); await matterInputState.activate(rec)
    const ui = await mount(), raw = '\n  **尚未发送**\n'
    await ui.type(raw); failing = true; await ui.click('compose-send')
    expect(h.posts()).toHaveLength(0); expect(getDraft(ID)).toBe(raw)
    expect(matterInputs(ID)[0]).toMatchObject({ rawText: raw, status: 'failed', error: 'input_storage' })
    expect(ui.byId('compose-input-notice').textContent).toContain('尚未发送')
    expect(ui.byId<HTMLButtonElement>('compose-send').disabled).toBe(true)
    expect(ui.byId<HTMLButtonElement>(`input-retry-${matterInputs(ID)[0]!.requestId}`).disabled).toBe(true)
    failing = false
  })
  it('while startup recovery is suspended, sending/retry stay locked and no network writes are made', async () => {
    const h = harness(), read = gate<string | null>(), disk = new Map<string, string>(); let blocked = true
    const journal = makeInputJournal({ getItemAsync: async k => blocked ? read.promise : disk.get(k) ?? null, setItemAsync: async (k,v) => { disk.set(k,v) }, deleteItemAsync: async k => { disk.delete(k) } }, hash)
    matterInputState.configure(journal); const restoring = matterInputState.activate(rec)
    const ui = await mount(); await ui.type('恢复途中草稿')
    expect(ui.byId<HTMLButtonElement>('compose-send').disabled).toBe(true); await ui.click('compose-send'); expect(h.posts()).toHaveLength(0)
    blocked = false; await act(async () => { read.resolve(null); await restoring }); await flush()
    expect(ui.byId<HTMLButtonElement>('compose-send').disabled).toBe(false)
    expect(getDraft(ID)).toBe('恢复途中草稿'); expect(h.posts()).toHaveLength(0)
  })
  it('all eight unresolved originals remain visible, including the earliest beyond the old three-row slice', async () => {
    const h = harness(); h.setSay(() => new Error('timeout')); const ui = await mount()
    for (let i=0; i<8; i++) { await ui.type(`未确认-${i}`); await ui.click('compose-send') }
    expect(matterInputs(ID)).toHaveLength(8)
    expect(ui.container.querySelectorAll('[data-testid^="input-receipt-"]')).toHaveLength(8)
    expect(ui.byId(`input-restore-${h.posts()[0]!.body.requestId}`)).not.toBeNull()
  })
  it('raw model diagnostics are collapsed literal text, while account guidance is visible', async () => {
    const h = harness(), diagnostic = '**raw error**\r\nhttps://example.com\r\n'
    h.detail().task.error = 'execution_model_unsupported'
    h.detail().events = [{ kind: 'error', createdAt: 1, text: '账号暂不能用这个模型。', diagnostic, errorCode: 'execution_model_unsupported' }]
    const ui = await mount(Matter)
    expect(ui.byId('progress-model-guidance').textContent).toContain('账号可用的模型')
    expect(ui.byId('progress-error-raw-0')).toBeNull()
    await ui.click('progress-error-raw-toggle-0')
    expect(ui.byId('progress-error-raw-0').textContent).toBe(diagnostic)
    expect(ui.byId('progress-error-raw-0').querySelector('a,strong')).toBeNull()
  })
})

it('native project location survives remount, reuses a retry id, and mode changes create a new request without deleting text',async()=>{
 const h=harness();host.params={};h.setCreate(()=>ok({ok:false,error:'git_workspace_source_unsupported'},422))
 const ui=await mount();await ui.type('保留要求');await ui.click('compose-adjust')
 await act(()=>ui.container.querySelector<HTMLButtonElement>('[aria-label="原目录"]')!.click());await flush()
 await ui.click('compose-send');await ui.click('compose-send')
 let posts=h.requests.filter(r=>r.path==='/m/api/matter/create')
 expect(posts[0]!.body.executionMode).toBe('project');expect(posts[1]!.body.requestId).toBe(posts[0]!.body.requestId)
 expect(getDraft('new')).toBe('保留要求');expect(ui.byId('compose-input-notice').textContent).toContain('当前无法准备独立副本')
 await act(()=>ui.root.unmount());roots.splice(roots.indexOf(ui.root),1)
 const reopened=await mount();await reopened.click('compose-send')
 posts=h.requests.filter(r=>r.path==='/m/api/matter/create');expect(posts[2]!.body).toEqual(posts[0]!.body)
 await reopened.click('compose-adjust');await act(()=>reopened.container.querySelector<HTMLButtonElement>('[aria-label="独立副本（Git 项目默认）"]')!.click());await flush()
 await reopened.click('compose-send');posts=h.requests.filter(r=>r.path==='/m/api/matter/create')
 expect(posts[3]!.body.executionMode).toBe('auto');expect(posts[3]!.body.requestId).not.toBe(posts[0]!.body.requestId)
 expect(getDraft('new')).toBe('保留要求')
})

it('native model and selected image payload survive an uncertain creation remount with the same identity',async()=>{
 const h=harness();host.params={}
 h.setOptions({...OPTIONS,providers:OPTIONS.providers.map(p=>({...p,capabilities:{...p.capabilities,features:{...p.capabilities.features,modelCatalog:true}}}))})
 h.setCreate(()=>new Error('timeout'))
 const ui=await mount();await ui.type('带图和模型');await ui.click('compose-adjust')
 await act(()=>ui.container.querySelector<HTMLButtonElement>('[aria-label="Claude"]')!.click());await flush()
 await act(()=>ui.container.querySelector<HTMLButtonElement>('[aria-label="Test model"]')!.click());await flush()
 await act(()=>ui.container.querySelector<HTMLButtonElement>('[aria-label="高"]')!.click());await flush()
 await ui.click('compose-add-image');await ui.click('compose-send')
 const first=h.requests.find(r=>r.path==='/m/api/matter/create')!
 expect(first.body).toMatchObject({executionMode:'auto',execution:{model:'test-model',reasoningEffort:'high'},attachmentIds:['22222222-2222-4222-8222-222222222222']})
 await act(()=>ui.root.unmount());roots.splice(roots.indexOf(ui.root),1)
 h.store.revalidateAll();h.setOptions({...OPTIONS,projects:[],providers:[]})
 const reopened=await mount();await reopened.click('compose-send')
 const posts=h.requests.filter(r=>r.path==='/m/api/matter/create')
 expect(posts).toHaveLength(2);expect(posts[1]!.body).toEqual(first.body)
 expect(getDraft('new')).toBe('带图和模型')
})

// Mutable entry options must not change an already-submitted creation attempt.
it.each(['default-project', 'missing-project', 'missing-provider', 'default-provider'] as const)('uncertain creation freezes the full input across %s refresh and remount', async drift => {
 const h=harness();host.params={};h.setCreate(()=>new Error('timeout'))
 if(drift==='missing-project')setEntrySettings('new',{projectId:OPTIONS.projects[0]!.id,providerId:null,executionMode:'auto'})
 if(drift==='missing-provider')setEntrySettings('new',{projectId:null,providerId:'claude',executionMode:'auto'})
 const ui=await mount();await ui.type('原项目要求');await ui.click('compose-send')
 const before=h.requests.find(r=>r.path==='/m/api/matter/create')!.body
 expect(before).toMatchObject({text:'原项目要求',target:{kind:'project',projectId:'p-0123456789abcdef0123'},executionMode:'auto'})
 await act(()=>ui.root.unmount());roots.splice(roots.indexOf(ui.root),1)
 h.store.revalidateAll()
 h.setOptions({...OPTIONS,defaultProviderId:'codex',providers:drift==='missing-provider'?[]:OPTIONS.providers,projects:['default-project','missing-project'].includes(drift)?[{...OPTIONS.projects[0]!,id:'p-1111111111111111111',name:'New default',path:'/another'},...(drift==='missing-project'?[]:OPTIONS.projects)]:OPTIONS.projects})
 const reopened=await mount();await reopened.click('compose-send')
 const posts=h.requests.filter(r=>r.path==='/m/api/matter/create')
 expect(posts).toHaveLength(2);expect(posts[1]!.body).toEqual(before)
 // An intentional edit, including retyping the same body, is a new attempt.
 await reopened.type('改过的要求');await reopened.type('原项目要求');await reopened.click('compose-send')
 const edited=h.requests.filter(r=>r.path==='/m/api/matter/create').at(-1)!.body
 expect(edited.requestId).not.toBe(before.requestId)
 expect(edited.target.projectId).toBe(['default-project','missing-project'].includes(drift)?'p-1111111111111111111':'p-0123456789abcdef0123')
})


const forkParams = { fork: ID, project: OPTIONS.projects[0]!.id, exclude: 'claude' }
const forkOptions = {...OPTIONS,providers:[...OPTIONS.providers,{...OPTIONS.providers[0]!,id:'codex',displayName:'Codex'}]}
const choice = async (ui: Awaited<ReturnType<typeof mount>>, label: string) => {
 await act(()=>ui.container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click());await flush()
}
const unmount = async (ui: Awaited<ReturnType<typeof mount>>) => { await act(()=>ui.root.unmount());roots.splice(roots.indexOf(ui.root),1) }
const creations = (h: ReturnType<typeof harness>) => h.requests.filter(r=>r.path==='/m/api/matter/create')

it('fork starts in source project with an available alternative and explicitly isolated mode',async()=>{
 const h=harness();host.params=forkParams;h.setOptions(forkOptions);h.setCreate(()=>new Error('timeout'))
 const ui=await mount();await ui.type('另做一份');await ui.click('compose-send')
 expect(creations(h)[0]!.body).toMatchObject({target:{kind:'project',projectId:forkParams.project},executionMode:'isolated',providerId:'codex'})
 expect(getEntrySettings('new')).toEqual({projectId:null,providerId:null,executionMode:'auto'})
 expect(getDraft(`fork:${ID}`)).toBe('另做一份')
})

it.each([null,'codex'])('fork preserves deliberate provider %s, location, model and images through remount and catalog loss',async providerId=>{
 const h=harness();host.params=forkParams;h.setOptions(forkOptions);h.setCreate(()=>new Error('timeout'))
 setEntrySettings(`fork:${ID}`,{projectId:forkParams.project,providerId,executionMode:'project',modelId:'saved-model',effort:'high'})
 const ui=await mount();await ui.type('保留分叉选择');await ui.click('compose-add-image');await ui.click('compose-send')
 const first=creations(h)[0]!.body
 expect(first).toMatchObject({target:{kind:'project',projectId:forkParams.project},executionMode:'project',execution:{model:'saved-model',reasoningEffort:'high'},attachmentIds:['22222222-2222-4222-8222-222222222222']})
 if(providerId)expect(first.providerId).toBe(providerId);else expect(first).not.toHaveProperty('providerId')
 await unmount(ui);h.store.revalidateAll();h.setOptions({...OPTIONS,projects:[],providers:[]})
 const reopened=await mount();await reopened.click('compose-send')
 expect(creations(h)[1]!.body).toEqual(first);expect(getDraftImages(`fork:${ID}`)).toHaveLength(1)
 expect(getEntrySettings(`fork:${ID}`).modelId).toBe('saved-model')
})

it('choosing CC arrangements in fork stays null across catalog refresh and remount',async()=>{
 const h=harness();host.params=forkParams;h.setOptions(forkOptions);h.setCreate(()=>new Error('timeout'))
 const ui=await mount();await ui.type('由 CC 安排');await choice(ui,'CC 安排执行');await ui.click('compose-send')
 expect(creations(h)[0]!.body).not.toHaveProperty('providerId')
 await unmount(ui);h.store.revalidateAll();h.setOptions({...forkOptions,providers:[...forkOptions.providers,{...OPTIONS.providers[0]!,id:'cursor',displayName:'Cursor'}]})
 const reopened=await mount();await reopened.click('compose-send')
 expect(creations(h)[1]!.body).toEqual(creations(h)[0]!.body);expect(getEntrySettings(`fork:${ID}`).providerId).toBeNull()
})

it('missing fork source is sent as original id for known rejection without a fallback',async()=>{
 const h=harness();host.params={...forkParams,project:'p-missing-source'};h.setOptions(forkOptions)
 h.setCreate(()=>ok({ok:false,error:'project_not_found'},400))
 const ui=await mount();await ui.type('原项目要求');await ui.click('compose-send')
 expect(creations(h)[0]!.body).toMatchObject({target:{kind:'project',projectId:'p-missing-source'},executionMode:'isolated'})
 expect(ui.container.querySelector<HTMLButtonElement>('[aria-label="Portfolio"]')!.textContent).not.toContain('✓');expect(getDraft(`fork:${ID}`)).toBe('原项目要求');expect(host.replace).not.toHaveBeenCalled()
})

it('fork without available alternative keeps honest CC arrangements after catalog changes',async()=>{
 const h=harness();host.params=forkParams;h.setCreate(()=>new Error('timeout'))
 const ui=await mount();await ui.type('还未选择执行者');await ui.click('compose-send')
 const first=creations(h)[0]!.body;expect(first).not.toHaveProperty('providerId')
 await unmount(ui);h.store.revalidateAll();h.setOptions(forkOptions)
 const reopened=await mount();await reopened.click('compose-send')
 expect(creations(h)[1]!.body).toEqual(first);expect(getEntrySettings(`fork:${ID}`).providerId).toBeNull()
})

it('changing compose route swaps whole draft and ignores old fork late receipt',async()=>{
 const h=harness();host.params=forkParams;h.setOptions(forkOptions);const sent=gate<Reply>();h.setCreate(()=>sent.promise)
 const ui=await mount();await ui.type('旧分叉');await ui.click('compose-add-image')
 await act(()=>ui.byId<HTMLButtonElement>('compose-send').click());await flush()
 setDraft('fork:deadbeef','另一份草稿');setEntrySettings('fork:deadbeef',{projectId:forkParams.project,providerId:null,executionMode:'project'})
 host.params={...forkParams,fork:'deadbeef'};await act(()=>ui.root.render(createElement(Compose)));await flush()
 expect(ui.byId<HTMLTextAreaElement>('compose-input').value).toBe('另一份草稿');expect(getDraftImages('fork:deadbeef')).toEqual([])
 expect(getDraftImages(`fork:${ID}`)).toHaveLength(1);expect(getEntrySettings('fork:deadbeef').executionMode).toBe('project')
 await act(()=>sent.resolve(ok({ok:true,receipt:RECEIPT,task:WB_TASK},202)));await flush()
 expect(getDraft('fork:deadbeef')).toBe('另一份草稿');expect(host.replace).not.toHaveBeenCalled()
})


it('managed UUID matter offers fork with source project and text while hiding source merge',async()=>{
 const h=harness()
 const workspace={id:'cc730ffd-1192-4a75-b99e-b6fc3e23d105',mode:'isolated',sourcePath:'/p',executionPath:'/copies/p',branch:'codex/cc-task-cc730ffd-1192-4a75-b99e-b6fc3e23d105',baseCommit:'a'.repeat(40)}
 h.setDetail({...DETAIL,task:{...DETAIL.task,path:workspace.executionPath,sourcePath:workspace.sourcePath,workspace,worktree:{branch:workspace.branch,removed:false,projectId:forkParams.project}},events:[{kind:'user',text:'原来的文字',createdAt:1,attachments:[{id:'image',name:'old.png',mime:'image/png',size:3,sha256:'a'.repeat(64)}]}]})
 const ui=await mount(Matter)
 expect(ui.byId('progress-wt-merge')).toBeNull();expect(ui.byId('progress-wt-fork')).not.toBeNull()
 await ui.click('progress-wt-fork')
 expect(host.push).toHaveBeenCalledWith(`/compose?fork=${ID}&project=${forkParams.project}&exclude=claude`)
 expect(getDraft(`fork:${ID}`)).toBe('原来的文字');expect(getDraftImages(`fork:${ID}`)).toEqual([])
 setDraft(`fork:${ID}`,'后来的草稿');await ui.click('progress-wt-fork');expect(getDraft(`fork:${ID}`)).toBe('后来的草稿')
 await unmount(ui);host.params=forkParams;const compose=await mount()
 expect(compose.container.textContent).toContain('原来的图片不会自动带过来')
})


it.each(['provider','location','project','model','text','same-text edit'] as const)('late fork success preserves the full draft after a %s edit and offers the accepted task',async edit=>{
 const h=harness();host.params=forkParams
 h.setOptions({...forkOptions,projects:[...forkOptions.projects,{...OPTIONS.projects[0]!,id:'p-11111111111111111111',name:'Another project'}],providers:forkOptions.providers.map(p=>({...p,capabilities:{...p.capabilities,features:{...p.capabilities.features,modelCatalog:true}}}))})
 const sent=gate<Reply>();h.setCreate(()=>sent.promise)
 const ui=await mount();await ui.type('fork intent')
 await act(()=>ui.byId<HTMLButtonElement>('compose-send').click());await flush()
 const submitted=creations(h)[0]!.body
 if(edit==='provider')await choice(ui,'CC 安排执行')
 if(edit==='location')await choice(ui,'原目录')
 if(edit==='project')await choice(ui,'Another project')
 if(edit==='model')await choice(ui,'Test model')
 if(edit==='text')await ui.type('later intent')
 if(edit==='same-text edit'){await ui.type('temporary text');await ui.type('fork intent')}
 const settings=getEntrySettings(`fork:${ID}`)
 await act(()=>sent.resolve(ok({ok:true,receipt:RECEIPT,task:WB_TASK},202)));await flush()
 expect(getDraft(`fork:${ID}`)).toBe(edit==='text'?'later intent':'fork intent')
 expect(getEntrySettings(`fork:${ID}`)).toEqual(settings)
 expect(host.replace).not.toHaveBeenCalled();expect(ui.byId('compose-accepted-draft').textContent).toContain('已接下')
 expect(ui.byId('compose-refused')).toBeNull()
 await ui.click('compose-accepted-progress')
 expect(host.push).toHaveBeenCalledWith(`/matter/${ID}`)
 // Only an explicit new submit creates the later intent; a deliberate edit gets a new request.
 expect(creations(h)).toHaveLength(1)
 h.setCreate(()=>new Error('timeout'));await ui.click('compose-send')
 expect(creations(h)[1]!.body.requestId).not.toBe(submitted.requestId)
})

it('pre-opened picker result remains in the fork draft after an accepted creation',async()=>{
 const h=harness();host.params=forkParams;h.setOptions(forkOptions)
 const sent=gate<Reply>();h.setCreate(()=>sent.promise)
 const picked=gate<any>();host.pickerGate=picked.promise
 const ui=await mount();await ui.type('fork intent');await ui.click('compose-add-image')
 await act(()=>ui.byId<HTMLButtonElement>('compose-send').click());await flush()
 const submitted=creations(h)[0]!.body
 await act(()=>picked.resolve({images:[{id:'33333333-3333-4333-8333-333333333333',name:'new.png',mime:'image/png',size:3,sha256:'a'.repeat(64),bytes:new Uint8Array([1,2,3]),uri:'test://new'}],skipped:null}));await flush()
 expect(getDraftImages(`fork:${ID}`)).toHaveLength(1)
 await act(()=>sent.resolve(ok({ok:true,receipt:RECEIPT,task:WB_TASK},202)));await flush()
 expect(getDraftImages(`fork:${ID}`)).toHaveLength(1);expect(getDraft(`fork:${ID}`)).toBe('fork intent');expect(host.replace).not.toHaveBeenCalled()
 expect(ui.byId('compose-accepted-progress')).not.toBeNull();expect(creations(h)).toHaveLength(1)
 h.setCreate(()=>new Error('timeout'));await ui.click('compose-send')
 expect(creations(h)[1]!.body.requestId).not.toBe(submitted.requestId)
 expect(creations(h)[1]!.body.attachmentIds).toEqual(['33333333-3333-4333-8333-333333333333'])
})

it('unchanged complete fork draft is cleared and opened after its accepted creation',async()=>{
 const h=harness();host.params=forkParams;h.setOptions(forkOptions)
 const ui=await mount();await ui.type('fork intent');await ui.click('compose-add-image');await ui.click('compose-send')
 expect(getDraft(`fork:${ID}`)).toBe('');expect(getDraftImages(`fork:${ID}`)).toEqual([])
 expect(getEntrySettings(`fork:${ID}`)).toEqual({projectId:null,providerId:null,executionMode:'auto'})
 expect(host.replace).toHaveBeenCalledWith(`/matter/${ID}`);expect(ui.byId('compose-accepted-progress')).toBeNull()
})


it('acceptance while the native picker is still open preserves the draft for its later result',async()=>{
 const h=harness();host.params=forkParams;h.setOptions(forkOptions)
 const picked=gate<any>();host.pickerGate=picked.promise
 const ui=await mount();await ui.type('fork intent');await ui.click('compose-add-image');await ui.click('compose-send')
 expect(getDraft(`fork:${ID}`)).toBe('fork intent');expect(host.replace).not.toHaveBeenCalled()
 expect(ui.byId('compose-accepted-progress')).not.toBeNull()
 await act(()=>picked.resolve({images:[{id:'33333333-3333-4333-8333-333333333333',name:'new.png',mime:'image/png',size:3,sha256:'a'.repeat(64),bytes:new Uint8Array([1,2,3]),uri:'test://new'}],skipped:null}));await flush()
 expect(getDraftImages(`fork:${ID}`)).toHaveLength(1)
 expect(creations(h)).toHaveLength(1)
})

it.each(['route','pairing'] as const)('picker result after a %s ownership change cannot mutate either draft',async change=>{
 const h=harness();host.params=forkParams;h.setOptions(forkOptions)
 const picked=gate<any>();host.pickerGate=picked.promise
 const ui=await mount();await ui.type('old intent');await ui.click('compose-add-image')
 if(change==='route'){
  host.params={...forkParams,fork:'deadbeef'};await act(()=>ui.root.render(createElement(Compose)));await flush()
 }else clearDrafts()
 await act(()=>picked.resolve({images:[{id:'33333333-3333-4333-8333-333333333333',name:'new.png',mime:'image/png',size:3,sha256:'a'.repeat(64),bytes:new Uint8Array([1,2,3]),uri:'test://new'}],skipped:null}));await flush()
 expect(getDraftImages(`fork:${ID}`)).toEqual([]);expect(getDraftImages('fork:deadbeef')).toEqual([])
 expect(creations(h)).toHaveLength(0)
})


it('accepted edited draft replaces an earlier creation rejection notice with its actual acceptance',async()=>{
 const h=harness();host.params=forkParams;h.setOptions(forkOptions)
 h.setCreate(()=>ok({ok:false,error:'git_workspace_source_unsupported'},409))
 const ui=await mount();await ui.type('fork intent');await ui.click('compose-send')
 expect(ui.byId('compose-input-notice').textContent).toContain('当前无法准备独立副本')
 const sent=gate<Reply>();h.setCreate(()=>sent.promise)
 await act(()=>ui.byId<HTMLButtonElement>('compose-send').click());await flush()
 await choice(ui,'CC 安排执行')
 await act(()=>sent.resolve(ok({ok:true,receipt:RECEIPT,task:WB_TASK},202)));await flush()
 expect(ui.byId('compose-accepted-draft').textContent).toContain('已接下')
 expect(ui.byId('compose-input-notice')).toBeNull();expect(ui.byId('compose-refused')).toBeNull()
})

it.each(['new','fork'] as const)('retains an explicit saved branch in unknown %s creation across missing-project remount',async kind=>{
 const h=harness();host.params=kind==='fork'?forkParams:{};h.setCreate(()=>new Error('timeout'))
 setEntrySettings(kind==='fork'?`fork:${ID}`:'new',{projectId:OPTIONS.projects[0]!.id,providerId:null,executionMode:'isolated',base:'cc/retained',...(kind==='fork'?{forkProviderPending:true}:{})})
 const ui=await mount();await ui.type('保留分支要求');await ui.click('compose-send')
 const first=creations(h)[0]!.body
 expect(first.target).toMatchObject({kind:'project',projectId:OPTIONS.projects[0]!.id,isolation:'worktree',base:'cc/retained'})
 await act(()=>ui.root.unmount());roots.splice(roots.indexOf(ui.root),1);h.store.revalidateAll();h.setOptions({...OPTIONS,projects:[]})
 const reopened=await mount();await reopened.click('compose-send')
 expect(creations(h)[1]!.body).toEqual(first)
})

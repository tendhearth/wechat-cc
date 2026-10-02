// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from 'react'
import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PHONE_API_SCHEMAS, type ClientOpts, type ProtocolClient, type ProtocolRequest } from '@wechat-cc/protocol'
import { makeLiveBackend } from '../backend/live'
import { DETAIL, ID, OPTIONS, RUN, WB_TASK, RECEIPT } from '../backend/fixtures'
import type { Backend, MatterInputT } from '../backend/types'
import { clearDrafts, getDraft, setDraft } from '../state/drafts'
import { makeStore, type Store } from '../state/store'
import { watchConnection } from '../state/wiring'
import { matterInputs } from '../state/matter-inputs'
import Compose from '../app/compose'
import Matter from '../app/matter/[id]'

type Root = { render(node: ReactNode): void; unmount(): void }
const createRoot = createRequire(import.meta.url)('react-dom/client').createRoot as (container: Element) => Root
const roots: Root[] = []
const disposers: Array<() => void> = []
const host = vi.hoisted(() => ({ ctx: null as unknown as { backend: Backend; store: Store }, params: {} as Record<string, string>, back: vi.fn(), push: vi.fn(), replace: vi.fn(), sources: [] as { text: unknown; selectable?: boolean; id?: string }[] }))
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
  return { View, Text, TextInput, Pressable, Modal, ScrollView: View, KeyboardAvoidingView: View, ActivityIndicator: View, Linking: { openURL: vi.fn() }, Platform: { OS: 'ios', select: (options: any) => options.ios ?? options.default } }
})
vi.mock('react-native-safe-area-context', async () => {
  const { createElement } = await import('react')
  return { SafeAreaView: ({ children }: any) => createElement('main', null, children) }
})
vi.mock('expo-router', () => ({ useLocalSearchParams: () => host.params, useRouter: () => ({ canGoBack: () => true, back: host.back, push: host.push, replace: host.replace }), Redirect: () => null }))
vi.mock('../i18n/useLang', () => ({ useLang: () => 'zh-Hans' }))
vi.mock('../state/BackendProvider', () => ({ useBackendCtx: () => host.ctx }))
vi.mock('../ui/TopBar', () => ({ TopBar: () => null }))

type Reply = { status: number; json: unknown } | Error
const ok = (json: unknown, status = 200): Reply => ({ status, json })
type Request = { path: string; method: string; body: any; retry?: boolean }
function harness() {
  let detail: any = structuredClone(DETAIL)
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
        else if (path === '/m/api/matter/say') reply = await say(request)
        else if (path === '/m/api/matter/create') reply = await create(request)
        else if (path === '/m/api/entry/options') reply = ok({ ok: true, ...OPTIONS })
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
    setDetail: (next: any) => { detail = next },
    setSay: (next: typeof say) => { say = next },
    setCreate: (next: typeof create) => { create = next },
    setRead: (next: typeof read) => { read = next },
    version: (version: number) => clients.at(-1)!.subs.get(`matter/${ID}`)?.({ found: true, kind: 'task', version, phase: 'working' }),
  }
}
beforeEach(() => { clearDrafts(); host.back.mockClear(); host.push.mockClear(); host.replace.mockClear(); host.sources.length = 0 })
afterEach(async () => {
  await act(() => { for (const root of roots.splice(0)) root.unmount() })
  for (const dispose of disposers.splice(0)) dispose()
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
    expect(post.retry).toBe(true)
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
    expect(host.replace).toHaveBeenCalledWith(`/matter/${ID}`)
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

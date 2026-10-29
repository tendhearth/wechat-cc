// @vitest-environment happy-dom
import { createHash } from 'node:crypto'
import { act, createElement, type ReactNode } from 'react'
import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '../ui/native-motion.test-support'
import { PHONE_API_SCHEMAS, type ClientOpts, type ProtocolClient, type ProtocolRequest } from '@wechat-cc/protocol'
import { makeLiveBackend } from '../backend/live'
import { DETAIL, ID, OPTIONS, RUN, WB_TASK, RECEIPT } from '../backend/fixtures'
import type { Backend, MatterInputT } from '../backend/types'
import { clearDrafts, getDraft, setDraft } from '../state/drafts'
import { withProviders, type TestCtx } from './providers.test-support'
import { makeInputJournal } from './input-journal'
import { matterInputState, matterInputs } from '../state/matter-inputs'
import Compose from '../app/compose'
import Matter from '../app/matter/[id]'
import Approval from '../app/approval/[id]'

type Root = { render(node: ReactNode): void; unmount(): void }
const createRoot = createRequire(import.meta.url)('react-dom/client').createRoot as (container: Element) => Root
const roots: Root[] = []
const host = vi.hoisted(() => ({ backend: null as unknown as Backend, params: {} as Record<string, string>, back: vi.fn(), push: vi.fn(), replace: vi.fn(), dismissTo: vi.fn(), sources: [] as { text: unknown; selectable?: boolean; id?: string }[] }))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

// 只替换原生宿主、路由与会话(钥匙串那层);真 BackendProvider、真实请求、缓存、订阅、文本与回执组件一起执行。
vi.mock('react-native', async () => {
  const native = (await import('../ui/native-motion.test-support')).nativeBoundary()
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
  return { ...native, View, Image: () => null, Text, TextInput, Pressable, Modal, ScrollView: View, KeyboardAvoidingView: View, ActivityIndicator: View, Linking: { openURL: vi.fn() }, Platform: { OS: 'ios', select: (options: any) => options.ios ?? options.default } }
})
vi.mock('expo-localization', () => ({ getLocales: () => [] }))
vi.mock('react-native-safe-area-context', async () => {
  const { createElement } = await import('react')
  return { SafeAreaProvider: ({ children }: any) => children, SafeAreaView: ({ children }: any) => createElement('main', null, children) }
})
vi.mock('expo-router', async () => ({ ...(await (await import('../ui/native-motion.test-support')).routerBoundary()), useLocalSearchParams: () => host.params, useRouter: () => ({ canGoBack: () => true, back: host.back, push: host.push, replace: host.replace, dismissTo: host.dismissTo }), Redirect: () => null }))
vi.mock('../state/session', () => ({ useSession: () => ({ pairing: null, inputScope: matterInputState.recovery().scope }) }))

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
  let permission: () => Reply | Promise<Reply> = () => ok({ ok: true })
  let insight: any = { explanations: {}, progress: null }
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
        else if (path === '/m/api/entry/options') reply = ok({ ok: true, ...OPTIONS })
        else if (path === '/m/api/matter/insight') reply = ok({ ok: true, ...insight })
        else if (path === '/m/api/matter/permission') reply = await permission()
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
  // store、重连重验(watchConnection)、卸载时 dispose 都由真 BackendProvider 做(见下面的 shell)。
  const status = (state: 'ready' | 'down' | 'connecting') => clients.at(-1)!.opts.onStatus?.(state)
  status('ready')
  host.backend = backend
  host.params = { matter: ID, id: ID }
  return {
    backend, requests, status,
    posts: () => requests.filter(request => request.path === '/m/api/matter/say'),
    detail: () => detail,
    setDetail: (next: any) => { detail = next },
    setSay: (next: typeof say) => { say = next },
    setCreate: (next: typeof create) => { create = next },
    setRead: (next: typeof read) => { read = next },
    setInsight: (next: typeof insight) => { insight = next },
    setPermission: (next: typeof permission) => { permission = next },
    version: (version: number) => clients.at(-1)!.subs.get(`matter/${ID}`)?.({ found: true, kind: 'task', version, phase: 'working' }),
  }
}
beforeEach(async () => {
  clearDrafts(); host.back.mockClear(); host.push.mockClear(); host.replace.mockClear(); host.dismissTo.mockClear(); host.sources.length = 0
  const disk = new Map<string,string>()
  matterInputState.configure(makeInputJournal({ getItemAsync: async k => disk.get(k) ?? null, setItemAsync: async (k,v) => { disk.set(k,v) }, deleteItemAsync: async k => { disk.delete(k) } }, async s => createHash('sha256').update(s).digest('hex')))
  await matterInputState.activate({ v: 1, relayHost: 'test', relayUrl: 'wss://test', daemonId: 'test', deviceId: 'test', deviceToken: 'private-test-token', pairedAt: 1 })
})
afterEach(async () => {
  await act(() => { for (const root of roots.splice(0)) root.unmount() })
  shell = null
  await act(async () => { matterInputState.configure(undefined); await matterInputState.clear() })
  document.body.innerHTML = ''
})
async function flush() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }) }
// 一个测试一棵树:BackendProvider 常驻(跟 app 里一样,离开页面不会拆掉后端和 store),页面在它里面换。
type Shell = { root: Root; container: HTMLElement; ctx: TestCtx | null; show(component: (() => ReactNode) | null): Promise<void> }
let shell: Shell | null = null
async function providers() {
  if (!shell) {
    const container = document.createElement('div'); document.body.appendChild(container)
    const root = createRoot(container); roots.push(root)
    const s: Shell = { root, container, ctx: null, show: async component => {
      await act(() => root.render(withProviders(component ? createElement(component) : null, { backend: host.backend, inputScope: matterInputState.recovery().scope, onCtx: ctx => { s.ctx = ctx } })))
    } }
    shell = s
    await s.show(null)
  }
  return shell
}
async function mount(component: () => ReactNode = Compose) {
  const s = await providers(), { root, container } = s
  await s.show(component)
  await flush()
  const byId = <T extends Element = HTMLElement>(id: string) => container.querySelector<T>(`[data-testid="${id}"]`)!
  const type = async (text: string) => { await act(() => {
    const textarea = byId<HTMLTextAreaElement>('compose-input')
    textarea.value = text; textarea.dispatchEvent(new Event('input', { bubbles: true }))
  }) }
  const click = async (id: string) => { await act(() => byId<HTMLButtonElement>(id).click()); await flush() }
  const statusText = async (id: string) => {
    await click(id)
    const text = byId(`${id}-description`).textContent
    await click(`${id}-close`)
    return text
  }
  /** 离开这页(页面卸载,Provider 还在)。 */
  const leave = async () => { await s.show(null) }
  return { container, root, leave, byId, type, click, statusText }
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
    expect(await ui.statusText(`input-status-${post.body.requestId}`)).toBe('正在交给执行者。')
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
    expect(await ui.statusText(`input-status-${h.posts()[0]!.body.requestId}`)).toBe(wording[status])
    expect(getDraft(ID)).toBe(['held', 'withdrawn'].includes(status) ? '这一条补充' : '')
  })
  it('uses the existing run in idle/send mode; an imported first turn without a run keeps the continuation route', async () => {
    const h = harness()
    h.detail().inputMode = 'send'; h.detail().task.status = 'idle'
    const ui = await mount(); await ui.type('继续'); await ui.click('compose-send')
    expect(h.posts()[0]!.body.runId).toBe(RUN)
    await ui.leave()
    clearDrafts()
    delete h.detail().runId; h.detail().inputs = []
    const next = await mount(); await next.type('第一句'); await next.click('compose-send')
    expect(h.posts()[1]!.body).not.toHaveProperty('runId')
  })
  it.each(['input_stale', 'input_conflict'])('shows a known %s rejection and keeps the original draft', async error => {
    const h = harness(); h.setSay(() => ok({ ok: false, error }, 409))
    const ui = await mount(); await ui.type('保留我的要求'); await ui.click('compose-send')
    expect(getDraft(ID)).toBe('保留我的要求')
    expect(await ui.statusText(`input-status-${h.posts()[0]!.body.requestId}`)).toContain(error === 'input_stale' ? '进展已变' : '记录需要核对')
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
    expect(await ui.statusText(`input-status-${original.requestId}`)).toContain('还没确认')
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
    await ui.leave()
    h.detail().inputs = [{ id: request.requestId, taskId: ID, runId: RUN, text: request.text, status: 'delivered' }]
    ui = await mount()
    expect(await ui.statusText(`input-status-${request.requestId}`)).toContain('已收到')
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
    expect(await ui.statusText(`input-status-${h.posts()[0]!.body.requestId}`)).toContain('需要核对')
  })
  it('holds the first send until a fresh detail arrives and preserves drafts if that read fails', async () => {
    const h = harness(); const read = gate<Reply>()
    await (await providers()).ctx!.store.query(`matter:${ID}`, () => h.backend.matter(ID, 'zh-Hans')).refresh()
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
    expect(await ui.statusText(`input-status-${request.requestId}`)).toBe('执行者已收到这条补充。')
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
    await ui.leave()
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
    await ui.leave()
    const progress = await mount(Matter)
    expect(await progress.statusText(`input-status-${request.requestId}`)).toBe('正在交给执行者。')
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


describe('work-first matter details', () => {
  it('keeps a model explanation beside the original operation and waits for the decision result before leaving', async () => {
    const h = harness(), result = gate<Reply>(), requestId = h.detail().permissions[0].id
    h.detail().permissions[0].description = 'npm test\nsecond command'
    h.setInsight({ progress: null, explanations: { [requestId]: { title: '检查项目', what: '模型的说明', scope: '当前项目', effect: '运行检查', source: 'model' } } })
    h.setPermission(() => result.promise)
    const ui = await mount(Approval)
    expect(ui.byId('approval-raw-inline').textContent).toContain('npm test')
    expect(ui.byId('approval-raw-inline').textContent).toContain('/p')
    expect(ui.container.textContent).toContain('只对这一次请求')
    expect(ui.container.textContent).toContain('当前项目')
    await ui.click('approval-allow')
    await ui.click('approval-deny')
    const decisions = h.requests.filter(r => r.path === '/m/api/matter/permission')
    expect(decisions).toHaveLength(1)
    expect(decisions[0]!.body).toEqual({ id: ID, runId: RUN, requestId, decision: 'allow' })
    expect(ui.byId<HTMLButtonElement>('approval-allow').disabled).toBe(true)
    expect(ui.byId<HTMLButtonElement>('approval-deny').disabled).toBe(true)
    expect(host.dismissTo).not.toHaveBeenCalled()
    h.detail().permissions = []
    await act(() => result.resolve(ok({ ok: true }))); await flush()
    expect(host.dismissTo).toHaveBeenCalledWith(`/matter/${ID}`)
    await ui.leave()
    const matter = await mount(Matter)
    expect(matter.byId('progress-status').textContent).toContain('在做')
    expect(matter.byId('progress-request-0')).toBeNull()
  })

  it('opens the concrete pending request without a write and keeps executor controls behind details', async () => {
    const h = harness(), ui = await mount(Matter)
    expect(ui.byId('progress-execution-details')).toBeNull()
    const request = ui.byId('progress-request-0')
    expect(request.textContent).toContain('npm test')
    await ui.click('progress-request-0')
    expect(host.push).toHaveBeenCalledWith(`/approval/${ID}?request=${DETAIL.permissions[0]!.id}`)
    expect(h.requests.filter(r => r.method === 'POST')).toHaveLength(0)
    await ui.click('progress-process')
    expect(ui.byId('progress-execution-details').textContent).toContain('/p')
    expect(h.requests.filter(r => r.method === 'POST')).toHaveLength(0)
    expect(ui.byId('progress-status').textContent).not.toContain('完成')
  })

  it('shows real outputs before summary and process, and opening the summary only reads', async () => {
    const h = harness()
    h.detail().artifacts = [{ id: 'out-1', taskId: ID, name: 'preview.html', mime: 'text/html', size: 12, sha256: 'a'.repeat(64), createdAt: 3, approvedAt: null }]
    const ui = await mount(Matter)
    expect(ui.byId('artifact-0')?.textContent).toContain('preview.html')
    expect(ui.byId('progress-summary')).toBeNull()
    const controls = [...ui.container.querySelectorAll('[data-testid]')].map(x => x.getAttribute('data-testid'))
    expect(controls.indexOf('progress-request-0')).toBeLessThan(controls.indexOf('artifact-0'))
    expect(controls.indexOf('artifact-0')).toBeLessThan(controls.indexOf('progress-summary-toggle'))
    await ui.click('progress-summary-toggle')
    expect(ui.byId('progress-summary')).not.toBeNull()
    expect(h.requests.filter(r => r.method === 'POST')).toHaveLength(0)
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
    await ui.click('progress-process')
    await ui.click('progress-error-raw-toggle-0')
    expect(ui.byId('progress-error-raw-0').textContent).toBe(diagnostic)
    expect(ui.byId('progress-error-raw-0').querySelector('a,strong')).toBeNull()
  })
})

// 直到这条命令通过(2026-10-20,安全 6):提交前主屏整条等宽显示命令原文;带出去的就是这一条。
describe('compose until: full command shown before submit', () => {
  const setField = async (ui: Awaited<ReturnType<typeof mount>>, id: string, value: string) => { await act(() => {
    const el = ui.byId<HTMLTextAreaElement>(id); el.value = value; el.dispatchEvent(new Event('input', { bubbles: true }))
  }) }
  const creates = (h: ReturnType<typeof harness>) => h.requests.filter(r => r.path === '/m/api/matter/create')
  it('collapsed by default, only with a separate workspace; the 300-char command appears verbatim and is what gets sent', async () => {
    const h = harness(); host.params = {}
    const ui = await mount(); await ui.type('让测试通过')
    await ui.click('compose-adjust')
    expect(ui.byId('compose-until')).toBeNull()
    await ui.click('compose-isolation')
    expect(ui.byId('compose-until-section')).toBeNull()
    await ui.click('compose-until')
    expect(ui.byId('compose-until-section').textContent).toContain('没开放行规则时，执行者每一步照样要你点。')
    const head = 'cd pkg && bun run test -- --grep "a b" | tee out.log; '
    const cmd = head + 'x'.repeat(300 - head.length)
    await setField(ui, 'compose-until-command', cmd)
    await ui.click('compose-until-more')
    expect(ui.byId('compose-until-rounds').textContent).toBe('4 轮')
    expect(ui.byId('compose-until-confirm-command').textContent).toBe(cmd)
    expect(host.sources).toContainEqual({ text: cmd, selectable: true, id: 'compose-until-confirm-command' })
    expect(ui.byId('compose-until-confirm').textContent).toContain('最多 4 轮')
    await ui.click('compose-send')
    expect(creates(h)[0]?.body).toMatchObject({ target: { kind: 'project', isolation: 'worktree' }, until: { command: cmd, maxRounds: 4 } })
  })
  it('a bad command locks submit instead of silently dropping it; turning the workspace off hides it and sends none', async () => {
    const h = harness(); host.params = {}
    const ui = await mount(); await ui.type('让测试通过')
    await ui.click('compose-adjust'); await ui.click('compose-isolation'); await ui.click('compose-until')
    await setField(ui, 'compose-until-command', 'x'.repeat(301))
    expect(ui.byId('compose-until-error').textContent).toBe('命令最多 300 字。')
    expect(ui.byId('compose-until-confirm')).toBeNull()
    expect(ui.byId<HTMLButtonElement>('compose-send').disabled).toBe(true)
    await ui.click('compose-isolation')
    expect(ui.byId('compose-until')).toBeNull()
    expect(ui.byId<HTMLButtonElement>('compose-send').disabled).toBe(false)
    await ui.click('compose-send')
    expect(creates(h)[0]?.body).not.toHaveProperty('until')
  })
  it('until_requires_worktree ⇒ its own plain sentence', async () => {
    const h = harness(); host.params = {}
    h.setCreate(() => ok({ ok: false, error: 'until_requires_worktree' }, 422))
    const ui = await mount(); await ui.type('让测试通过')
    await ui.click('compose-adjust'); await ui.click('compose-isolation'); await ui.click('compose-until')
    await setField(ui, 'compose-until-command', 'bun run test')
    await ui.click('compose-send')
    expect(ui.byId('compose-untilNeedsWorktree').textContent).toContain('只能用在独立工作区里')
  })
})

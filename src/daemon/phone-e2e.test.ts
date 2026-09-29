/**
 * phone-e2e.test.ts — 手机协议 v2 的进程内端到端互通(spec 2026-09-29-phone-protocol-v2 §5 第 3 条)。
 *
 * 全是真的:`makeTunnelHub`(中继实现)+ 真面板 + 真工作台(只有执行者是假的)+ 真隧道客户端 +
 * 手机事件集线器(daemon 同一份接线 makePhoneEventsWiring)+ 协议包客户端 `makeProtocolClient`。
 * 线上只剩两只假 socket:daemon↔中继、手机↔中继,都是同步转发的内存管道。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeProtocolClient, type ProtocolClient, type ProtocolSocket } from '@wechat-cc/protocol'
import { openDb, type Db } from '../lib/db'
import { removeTempDir } from '../lib/test-temp'
import { createProviderRegistry } from '../core/provider-registry'
import { makeMatterStore } from '../core/matters/store'
import { makeMattersService } from '../core/matters/service'
import { makeWorkbenchStore } from '../core/workbench/store'
import { makeWorkbenchService, type WorkbenchService } from '../core/workbench/service'
import { MANAGED_NATIVE_CAPABILITIES } from '../core/workbench/executor-capabilities'
import { makeSettingsPanel, type SettingsPanel } from './settings-panel'
import { makeTunnelHub, type TunnelHub } from '../../relay/tunnel'
import { makeTunnelClient, type TunnelClient, type TunnelWS } from './tunnel-client'
import { makePhoneEventsWiring } from './phone-topic-sources'

const DAEMON = 'e2e-daemon'
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x10, 0x80])

let root: string, managedRoot: string, db: Db
let workbench: WorkbenchService, panel: SettingsPanel, hub: TunnelHub, tunnel: TunnelClient
let wiring: ReturnType<typeof makePhoneEventsWiring>
let store: ReturnType<typeof makeWorkbenchStore>, matters: ReturnType<typeof makeMatterStore>
let deviceToken: string
let seenValue: string | null
let handled: string[]
const gates: Array<{ path: string; finish: () => void }> = []
const clients: ProtocolClient[] = []

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-phone-e2e-')))
  managedRoot = realpathSync(mkdtempSync(join(tmpdir(), 'cc-phone-e2e-managed-')))
  db = openDb({ path: join(root, 'state.db') })
  matters = makeMatterStore(db); store = makeWorkbenchStore(db)
  gates.length = 0; handled = []; seenValue = null
  const registry = createProviderRegistry()
  // 假执行者:init ⇒(路径以 ask 结尾就先要一次权限)⇒ 等闸门 ⇒ 一段文字 ⇒ 收工。
  registry.register('claude', { async spawn(project, ctx) {
    let finish!: () => void
    const gate = new Promise<void>(r => { finish = r })
    gates.push({ path: project.path, finish })
    return {
      async *dispatch() {
        yield { kind: 'init' as const, sessionId: 'e2e-native' }
        if (project.path.endsWith('ask')) await ctx.requestPermission!({ tool: 'Bash', description: 'Remove the one scratch probe file' })
        await gate
        yield { kind: 'text' as const, text: '做完了' }
        yield { kind: 'result' as const, sessionId: 'e2e-native', numTurns: 1, durationMs: 1 }
      },
      async close() { finish() },
    }
  } }, { displayName: 'Claude', canResume: () => true, workbench: MANAGED_NATIVE_CAPABILITIES })
  workbench = makeWorkbenchService({ store, registry, stateDir: root, managedWorkspaceRoot: managedRoot, ownerChatId: () => 'owner', defaultProvider: 'claude', matters, retainedIdleCloseMs: 0, handoffGraceMs: 0 })
  const service = makeMattersService({ store: matters, workbench })
  mkdirSync(join(root, 'stickers'))
  writeFileSync(join(root, 'stickers', 'wave.png'), PNG)
  panel = makeSettingsPanel({
    stateDir: root, ownerChatId: () => 'owner', chatPrefs: { get: () => ({}), set: () => ({}) }, getUserName: () => null, setUserName: async () => {}, log: () => {},
    stickers: { list: () => [{ file: 'wave.png', tags: ['wave'] }], dir: join(root, 'stickers') },
    seen: { read: () => seenValue, write: iso => { seenValue = iso } },
    matters: { ...service, say: (id, text, input) => service.say(id, text, 'phone', input), seenOnPhone: id => { matters.bind(id, 'phone', 'pwa') } },
  })
  // 配对一台设备(与手机在家点「把 CC 带在身上」同一条路由),不起 HTTP 服务。
  const link = panel.issueToken()
  const paired = await (await panel.handleRequest(new Request(`http://127.0.0.1/set/api/pair?t=${link}`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }))).json() as { device_token: string }
  deviceToken = paired.device_token

  wiring = makePhoneEventsWiring({ workbench, matters, home: panel.home, changes: workbench.changes, pollMs: 40 })
  hub = makeTunnelHub()
  let incoming: ((ev: { data?: unknown }) => void) | undefined
  const daemonSocket: TunnelWS = {
    readyState: 1,
    send(raw) { hub.onDaemonFrame(DAEMON, raw) },
    close() {},
    addEventListener(type, handler) { if (type === 'message') incoming = handler },
  }
  hub.registerDaemon(DAEMON, { readyState: 1, send(raw) { incoming?.({ data: raw }) }, close() {} })
  tunnel = makeTunnelClient({
    daemonId: DAEMON,
    knownDeviceTokens: () => panel.deviceTokens(),
    activeLinkToken: () => panel.activeLinkToken(),
    handleRequest: req => { handled.push(`${req.method} ${new URL(req.url).pathname}`); return panel.handleRequest(req) },
    connect: () => daemonSocket,
    events: wiring.events,
    log: () => {},
  })
  tunnel.start()
})

afterEach(async () => {
  for (const c of clients.splice(0)) c.close()
  tunnel?.stop()
  wiring?.dispose()
  for (const g of gates) g.finish()
  await workbench?.shutdown()
  db?.close()
  removeTempDir(root); removeTempDir(managedRoot)
})

/** 一条手机 ↔ 中继的内存 WebSocket。`stripV`:把握手里的 `v` 两个方向都抹掉 = 对面是不认识 v 的老后台。 */
interface PhoneLine { sent: string[]; streamId: () => string; drop: () => void; handshakes: () => number }
function phoneLine(opts: { stripV?: boolean } = {}): { open: () => ProtocolSocket; line: PhoneLine } {
  const sent: string[] = []
  let current: { streamId: string; kill: () => void } | null = null
  let handshakes = 0
  const strip = (s: string): string => {
    if (!opts.stripV) return s
    const f = JSON.parse(s) as Record<string, unknown>
    if (typeof f.hs !== 'string') return s
    delete f.v
    return JSON.stringify(f)
  }
  const open = (): ProtocolSocket => {
    let onMsg: ((s: string) => void) | undefined, onClose: (() => void) | undefined, onOpen: (() => void) | undefined
    let dead = false
    const attached = hub.attachPhone(DAEMON, { readyState: 1, send(raw) { if (!dead) onMsg?.(strip(raw)) }, close() { kill() } })
    const streamId = attached.streamId!
    const kill = () => { if (dead) return; dead = true; hub.dropPhone(streamId); onClose?.() }
    current = { streamId, kill }
    setTimeout(() => { if (!dead) onOpen?.() }, 0)
    return {
      send(s) {
        if (dead) return
        const out = strip(s)
        if ((JSON.parse(out) as { hs?: unknown }).hs !== undefined) handshakes++
        sent.push(out)
        hub.onPhoneFrame(streamId, out)
      },
      close: kill,
      onOpen(cb) { onOpen = cb },
      onMessage(cb) { onMsg = cb },
      onClose(cb) { onClose = cb },
    }
  }
  return { open, line: { sent, streamId: () => current!.streamId, drop: () => current?.kill(), handshakes: () => handshakes } }
}

function phone(opts: { stripV?: boolean; token?: string } = {}) {
  const { open, line } = phoneLine(opts)
  const client = makeProtocolClient({ open, token: opts.token ?? deviceToken, requestTimeoutMs: 3000 })
  clients.push(client)
  return { client, line }
}

type Ev = { data: any; epoch: string; seq: number }
function collect(client: ProtocolClient, topic: string): Ev[] {
  const got: Ev[] = []
  client.subscribe(topic, (data, meta) => { got.push({ data, ...meta }) })
  return got
}

function createTask(name: string) {
  const path = join(root, name.split('#')[0]!)
  mkdirSync(path, { recursive: true })
  return workbench.create({ path, providerId: 'claude', text: name })
}
const release = (task: { path: string }) => { const i = gates.findIndex(g => g.path === task.path); gates.splice(i, 1)[0]!.finish() }
const utf8 = new TextEncoder()
const pause = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('手机协议 v2 进程内端到端', () => {
  it('请求 / 响应:JSON 带响应头,二进制正文原样往返,base64 请求正文 + 自带请求头交给面板', async () => {
    const { client } = phone()
    const home = await client.request({ method: 'GET', path: '/m/api/home?limit=1' })
    expect(client.version()).toBe(2)
    expect(home.status).toBe(200)
    expect(home.headers['content-type']).toContain('application/json')
    expect(home.json<{ ok: boolean; unread: number }>()).toMatchObject({ ok: true, unread: 0 })

    const png = await client.request({ method: 'GET', path: '/m/api/sticker/wave.png' })
    expect(png.status).toBe(200)
    expect(png.headers['content-type']).toBe('image/png')
    expect([...png.body]).toEqual([...PNG])

    const until = new Date(Date.now() - 60_000).toISOString()
    const seen = await client.request({ method: 'POST', path: '/m/api/seen', headers: { 'content-type': 'application/json', 'x-e2e': '1' }, body: utf8.encode(JSON.stringify({ until })) })
    expect(seen.status).toBe(200)
    expect(seen.json()).toEqual({ ok: true, seen_until: until })
    expect(seenValue).toBe(until)
  })

  it('订阅 agents:先收到当下状态,再看到任务从排队、在干到做完', async () => {
    const { client } = phone()
    const got = collect(client, 'agents')
    await expect.poll(() => got.length).toBe(1)
    expect(got[0]!.data).toEqual({ running: 0, waiting: 0, tasks: [] })

    // 同一个文件夹两件事:第一件占着文件夹在干,第二件只能排队(一个文件夹一个活会话)。
    const a = createTask('shared#a'), b = createTask('shared#b')
    const phaseOf = (id: string) => (got.at(-1)!.data.tasks as Array<{ id: string; phase: string }>).find(t => t.id === id)?.phase
    await expect.poll(() => [phaseOf(a.id), phaseOf(b.id)]).toEqual(['working', 'queued'])
    expect(got.at(-1)!.data).toMatchObject({ running: 1, waiting: 1 })
    expect(got.at(-1)!.data.tasks.map((t: { title: string }) => t.title)).toEqual(['shared#a', 'shared#b'])

    release(a)
    await expect.poll(() => phaseOf(b.id)).toBe('working')
    expect(phaseOf(a.id)).toBeUndefined()   // 做完 = 终态,离开 agents
    release(b)
    await expect.poll(() => got.at(-1)!.data).toEqual({ running: 0, waiting: 0, tasks: [] })
    // 同一纪元、seq 单调递增。
    expect(new Set(got.map(e => e.epoch)).size).toBe(1)
    for (let i = 1; i < got.length; i++) expect(got[i]!.seq).toBeGreaterThan(got[i - 1]!.seq)
    expect(store.get(a.id)!.status).toBe('completed')
  })

  it('approvals / matter/<id>:待批准的权限带一句摘要;经隧道批准后摘要消失、事项版本前进', async () => {
    const { client } = phone()
    const approvals = collect(client, 'approvals')
    await expect.poll(() => approvals.length).toBe(1)
    expect(approvals[0]!.data).toEqual([])

    const task = createTask('needs-ask')
    await expect.poll(() => approvals.at(-1)!.data.length).toBe(1)
    const pending = approvals.at(-1)!.data[0]
    expect(pending).toEqual({ taskId: task.id, kind: 'permission', id: expect.any(String), summary: 'Bash: Remove the one scratch probe file' })

    const matter = collect(client, `matter/${task.id}`)
    await expect.poll(() => matter.length).toBe(1)
    expect(matter[0]!.data).toMatchObject({ found: true, kind: 'task', phase: 'working' })
    const v0 = matter[0]!.data.version as number

    const runId = workbench.detail(task.id).runId!
    const res = await client.request({ method: 'POST', path: '/m/api/matter/permission', body: JSON.stringify({ id: task.id, runId, requestId: pending.id, decision: 'allow' }) })
    expect(res.status).toBe(200)
    await expect.poll(() => approvals.at(-1)!.data).toEqual([])
    await expect.poll(() => matter.at(-1)!.data.version).toBeGreaterThan(v0)

    // 事件只是摘要:不带详情里的事件 / 产物 / 权限正文。
    expect(Object.keys(matter.at(-1)!.data).sort()).toEqual(['found', 'kind', 'phase', 'version'])
    const missing = collect(client, 'matter/0000beef')
    await expect.poll(() => missing.length).toBe(1)
    expect(missing[0]!.data).toEqual({ found: false })
  })

  it('home:未读 / CC 状态 / 最新动态游标 三项摘要', async () => {
    const { client } = phone()
    const home = collect(client, 'home')
    await expect.poll(() => home.length).toBe(1)
    expect(home[0]!.data).toEqual({ unread: 0, presenceState: null, nextCursor: null })
  })

  it('断线后带 since 续上:同纪元不重发旧状态,之后的变化照常到达', async () => {
    const { client, line } = phone()
    // 另一台手机也订着 agents ⇒ 断线期间主题状态留在集线器里(没人订阅才会回收,见下一条用例)。
    const keeper = collect(phone().client, 'agents')
    const got = collect(client, 'agents')
    await expect.poll(() => [got.length, keeper.length]).toEqual([1, 1])
    line.drop()                                      // 中继断了这条手机连接
    await expect.poll(() => line.handshakes(), { timeout: 5000 }).toBe(2)
    await pause(200)                                 // 重新 sub 带 since,与当下 {epoch, seq} 相同 ⇒ 不重发
    expect(got).toHaveLength(1)

    const task = createTask('after-reconnect')
    await expect.poll(() => got.at(-1)!.data.tasks.map((t: { id: string }) => t.id)).toEqual([task.id])
    expect(got.at(-1)!.epoch).toBe(got[0]!.epoch)
    expect(got.at(-1)!.seq).toBeGreaterThan(got[0]!.seq)
    release(task)
  })

  it('断线期间主题被回收(唯一订阅者)⇒ 续上时补发一条当下状态:同纪元、seq 更大、内容不变', async () => {
    const { client, line } = phone()
    const got = collect(client, 'agents')
    await expect.poll(() => got.length).toBe(1)
    line.drop()
    await expect.poll(() => line.handshakes(), { timeout: 5000 }).toBe(2)
    await expect.poll(() => got.length).toBe(2)
    expect(got[1]!.data).toEqual(got[0]!.data)
    expect(got[1]!.epoch).toBe(got[0]!.epoch)
    expect(got[1]!.seq).toBeGreaterThan(got[0]!.seq)
  })

  it('重放旧帧被拒:同一个密封请求再注入一次,面板不会再处理,流照常可用', async () => {
    const { client, line } = phone()
    const until = new Date(Date.now() - 120_000).toISOString()
    expect((await client.request({ method: 'POST', path: '/m/api/seen', body: JSON.stringify({ until }) })).status).toBe(200)
    const reqFrame = line.sent.at(-1)!
    const before = handled.length
    hub.onPhoneFrame(line.streamId(), reqFrame)      // 中继(或路上的人)把旧帧重放一遍
    await pause(100)
    expect(handled.length).toBe(before)
    const again = await client.request({ method: 'GET', path: '/m/api/home?limit=1' })
    expect(again.status).toBe(200)
    expect(handled.slice(before)).toEqual(['GET /m/api/home'])
  })

  it('老后台(握手回包里没有 v)⇒ 退回 v1:一问一答照常,订阅与二进制正文明确拒绝', async () => {
    const { client } = phone({ stripV: true })
    const home = await client.request({ method: 'GET', path: '/m/api/home?limit=1' })
    expect(client.version()).toBe(1)
    expect(home.status).toBe(200)
    expect(home.headers).toEqual({})
    expect(home.json<{ ok: boolean }>().ok).toBe(true)
    expect(() => client.subscribe('agents', () => {})).toThrow('subscriptions_need_v2')
    await expect(client.request({ method: 'POST', path: '/m/api/seen', body: utf8.encode('{}') })).rejects.toThrow('binary_body_needs_v2')
  })

  it('撤销设备后连接立刻失效:下一条事件发出前关流,之后的请求都是 auth_failed', async () => {
    const { client } = phone()
    const got = collect(client, 'agents')
    await expect.poll(() => got.length).toBe(1)
    expect((await client.request({ method: 'GET', path: '/m/api/home?limit=1' })).status).toBe(200)

    expect((await panel.apply({ op: 'forget_devices' })).ok).toBe(true)
    const task = createTask('after-revoke')           // 有变化 ⇒ 集线器要发 ev ⇒ 发之前核对令牌
    await pause(200)
    expect(got).toHaveLength(1)                       // 撤销之后一条都没到
    await expect(client.request({ method: 'GET', path: '/m/api/home?limit=1' })).rejects.toThrow('auth_failed')
    // 重新连一条也不行:令牌已不在册。
    const { client: fresh } = phone()
    await expect(fresh.request({ method: 'GET', path: '/m/api/home?limit=1' })).rejects.toThrow('auth_failed')
    release(task)
  })

  it('同主题合并:快速连发多次变化,只到最新的一条', async () => {
    const task = createTask('burst')
    const { client } = phone()
    const got = collect(client, `matter/${task.id}`)
    await expect.poll(() => gates.length).toBe(1)    // 执行者已经在等闸门,不会再自己写库
    await expect.poll(() => got.at(-1)?.data.version).toBe(store.version(task.id))
    await pause(100)
    await expect.poll(() => got.at(-1)?.data.version).toBe(store.version(task.id))
    const settled = got.length
    for (let i = 0; i < 5; i++) { store.addEvent(task.id, 'text', `第 ${i} 段`); wiring.events.poke() }
    const final = store.version(task.id)
    await expect.poll(() => got.at(-1)!.data.version).toBe(final)
    await pause(150)
    expect(got.length - settled).toBe(1)
    release(task)
  })
})

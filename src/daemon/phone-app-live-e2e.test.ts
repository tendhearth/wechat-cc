/**
 * phone-app-live-e2e.test.ts — 手机 app 的 LiveBackend 与配对,对着进程内真 daemon 手机端跑
 * (计划 docs/superpowers/plans/2026-09-30-tendhearth-app-live.md Task 9)。
 *
 * 与 phone-e2e.test.ts 同一套真东西:中继实现 + 真面板 + 真工作台(执行者是假的)+ 真隧道客户端 + 手机事件集线器;
 * 手机这头是 apps/app/src 的纯 TS 模块(不引 RN)。线上只有同步转发的内存管道。
 * 这里不需要静态夹具:数据全是真 daemon 生成的(app 的形状夹具在 apps/app/src/backend/fixtures.ts,那边的单测用)。
 * 状态目录全在 mkdtemp 里,不碰真 state dir。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { makeProtocolClient, type ProtocolSocket } from '@wechat-cc/protocol'
import { openDb, type Db } from '../lib/db'
import { removeTempDir } from '../lib/test-temp'
import { createProviderRegistry } from '../core/provider-registry'
import { makeMatterStore, type MatterStore } from '../core/matters/store'
import { makeMessagesStore, type MessagesStore } from '../lib/messages-store'
import { makeMattersService } from '../core/matters/service'
import { makeSayReceipts } from '../core/matters/say-receipts'
import { makeWorkbenchStore } from '../core/workbench/store'
import { makeWorkbenchService, type WorkbenchService } from '../core/workbench/service'
import { encodeNativeHistoryKey, historyPreview, type NativeHistoryItem, type NativeHistoryReader } from '../core/workbench/native-history'
import { MANAGED_NATIVE_CAPABILITIES } from '../core/workbench/executor-capabilities'
import { makeSettingsPanel, SETTINGS_LINK_TTL_MS, type SettingsPanel } from './settings-panel'
import { makeTunnelHub, type TunnelHub } from '../../relay/tunnel'
import { makeTunnelClient, type TunnelClient, type TunnelWS } from './tunnel-client'
import { makePhoneEventsWiring } from './phone-topic-sources'
import { makePhoneOwner } from './mobile-chat'
import { makePhoneChat } from './phone-chat'
import { buildConnections } from './connections'
import { makeLiveBackend } from '../../apps/app/src/backend/live'
import type { Backend, ConnState } from '../../apps/app/src/backend/types'
import { parsePairLink, type ParsedLink } from '../../apps/app/src/net/link'
import { pairWithLink } from '../../apps/app/src/net/pairing'
import { makeCredentialStore, type CredentialStore } from '../../apps/app/src/net/credentials'

const DAEMON = 't' + 'a'.repeat(36)   // 老中继 id 的形状,好让 parsePairLink 认;内存中继只拿它当键

let root: string, managedRoot: string, db: Db
let nativeDir: string
let matters: MatterStore, messages: MessagesStore
/** 跟 CC 说:假 converse 收到的每句正文;releaseConverse(reply) 放行最早那句,并像 persistAppTurn 那样把一问一答写进 messages。 */
let conversed: string[]
let converseGates: Array<{ text: string; go: (reply: string) => void }>
let workbench: WorkbenchService, panel: SettingsPanel, hub: TunnelHub, tunnel: TunnelClient
let wiring: ReturnType<typeof makePhoneEventsWiring>
let deviceToken: string
let handled: string[]
/** 按「METHOD /path」扣住到达面板的请求,直到测试放行(在飞期间撤销 / 让提交超时)。 */
let holds: Map<string, { wait: Promise<void>; go: () => void }>
/** 手机这头往外的一切:开 socket 次数 + 发出的帧数(不管 socket 死活都算)。撤销后该一直不动 ——
 *  隧道对撤销的令牌在面板之前就拒了,光数面板收到的请求看不出手机还在不在发。 */
let phoneOut = 0
const gates: Array<{ path: string; finish: () => void }> = []
const backends: Backend[] = []
/** LiveBackend 的日志(只有错误码与路由键),失败时帮着看。 */
let logs: string[] = []
/** 面板时钟拨快多少(过期码用);其余用例为 0。 */
let skewMs = 0
const phones = new Set<() => void>()

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-app-live-')))
  managedRoot = realpathSync(mkdtempSync(join(tmpdir(), 'cc-app-live-managed-')))
  db = openDb({ path: join(root, 'state.db') })
  matters = makeMatterStore(db); messages = makeMessagesStore(db)
  const store = makeWorkbenchStore(db)
  conversed = []; converseGates = []
  gates.length = 0; handled = []; holds = new Map(); logs = []; skewMs = 0; phoneOut = 0
  // 电脑上的原生会话(spec 2026-10-01-tendhearth-continue-sessions):e2e-native 能接(nativeId 与假执行者 init 报的一致);
  // e2e-busy 看得见正在跑(observedState active)。两条都在 native 目录。
  nativeDir = join(root, 'native'); mkdirSync(nativeDir, { recursive: true })
  const nativeItem = (nativeId: string): NativeHistoryItem => ({ key: encodeNativeHistoryKey('claude', nativeId), providerId: 'claude', nativeId, title: `原会话 ${nativeId}`, titleSource: 'native_custom', cwd: nativeDir, updatedAt: 1, remote: false, observedState: nativeId === 'e2e-busy' ? 'active' : 'unknown' })
  const nativeItems = [nativeItem('e2e-native'), nativeItem('e2e-busy')]
  const nativeRead: NativeHistoryReader['read'] = async (key, page) => {
    const item = nativeItems.find(i => i.key === key)
    if (!item) throw new Error('native_history_unavailable')
    return historyPreview(item, 1, [{ id: 'u', role: 'user', text: '原来的要求', truncated: false }, { id: 'a', role: 'assistant', text: '原来的回答', truncated: false }], null, page)
  }
  const nativeReader: NativeHistoryReader = { list: async () => ({ items: nativeItems, nextCursor: null, coverage: 'native_supported_history' }), read: nativeRead, currentFingerprint: async (key, page = { limit: 100 }) => (await nativeRead(key, page)).sourceFingerprint }
  const registry = createProviderRegistry()
  // 假执行者:init ⇒(路径以 ask 结尾先要一次权限)⇒ 等闸门 ⇒ 一段文字 ⇒ 收工。与 phone-e2e.test.ts 相同。
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
  workbench = makeWorkbenchService({ store, registry, stateDir: root, managedWorkspaceRoot: managedRoot, ownerChatId: () => 'owner', defaultProvider: 'claude', matters, retainedIdleCloseMs: 0, handoffGraceMs: 0, nativeHistory: { claude: nativeReader } })
  // 跟 CC 说:真 makePhoneChat + 真 messages store;converse 是可放行的闸门(生产里是 companionConverse)。
  // 对聊天那件事的「说一句」(/m/api/matter/say)也走这同一个闸门,带真回执表(v70)。
  const phoneOwner = makePhoneOwner({ ownerChatId: () => 'owner', matters })
  let turn = 0
  const converse = (text: string) => {
    conversed.push(text)
    return new Promise<{ reply: string }>((resolve, reject) => {
      converseGates.push({ text, go: reply => {
        if (!reply) { reject(new Error('released_by_teardown')); return }
        const t0 = Date.now() + turn++ * 2
        void (async () => {
          await messages.append({ id: `app:phone:${t0}:in`, chatId: 'owner', ts: new Date(t0).toISOString(), direction: 'in', kind: 'text', text, source: 'phone' })
          await messages.append({ id: `app:phone:${t0}:out`, chatId: 'owner', ts: new Date(t0 + 1).toISOString(), direction: 'out', kind: 'text', text: reply, source: 'phone' })
          resolve({ reply })
        })().catch(reject)
      } })
    })
  }
  const service = makeMattersService({ store: matters, workbench, chat: { ownerChatId: () => 'owner', say: text => converse(text) }, sayReceipts: makeSayReceipts(db) })
  const phoneChat = makePhoneChat({
    converse,
    ownerMatterId: () => phoneOwner.ensure(),
    onSettled: () => { wiring?.events.poke() },
  })
  panel = makeSettingsPanel({
    stateDir: root, now: () => Date.now() + skewMs, ownerChatId: () => 'owner', chatPrefs: { get: () => ({}), set: () => ({}) }, getUserName: () => null, setUserName: async () => {}, log: () => {},
    // 设备列表只在接了 remote 时返回(settings-panel.ts state())。
    remote: { isEnabled: () => true, setEnabled: () => {}, requestRestart: () => {} },
    insight: { forMatter: async (_id, lang) => ({ explanations: {}, progress: { summary: `summary-${lang}`, steps: [], source: 'raw' as const } }) },
    changes: () => [],
    matters: { ...service, say: (id, text, input) => service.say(id, text, 'phone', input), seenOnPhone: id => { matters.bind(id, 'phone', 'pwa') } },
    sessionContinue: { preview: k => workbench.previewNativeContinue(k), adopt: k => workbench.adoptNativeSession(k) },
    chat: { owner: () => phoneOwner.peek(), history: (chatId, o) => messages.listRange(chatId, o), chat: phoneChat },
    // 连接:真 buildConnections(插件快照还没出来 ⇒ unknown;知识库没开 ⇒ 不出现)+ 真工作台;detail 只在 admin 视图里有,手机路由去掉。
    connections: () => buildConnections({
      plugins: () => null, wechatSyncedAt: () => null,
      knowledge: () => ({ enabled: false, built: false, latestAt: null, syncedAt: null }),
      computer: () => ({ label: 'e2e-mac', since: 1, version: null }),
      workbench, detailLimit: 3,
    }),
  })
  const link = panel.issueToken()
  const paired = await (await panel.handleRequest(new Request(`http://127.0.0.1/set/api/pair?t=${link}`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }))).json() as { device_token: string }
  deviceToken = paired.device_token

  wiring = makePhoneEventsWiring({
    workbench, matters, home: panel.home, changes: workbench.changes, pollMs: 40,
    chat: {
      latestAt: async chatId => { const ts = await messages.latestTs(chatId); return ts ? Date.parse(ts) : null },
      pendingMatter: () => phoneChat.pendingMatter(),
    },
  })
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
    handleRequest: async req => {
      const key = `${req.method} ${new URL(req.url).pathname}`
      handled.push(key)
      const hold = holds.get(key)
      if (hold) await hold.wait
      return panel.handleRequest(req)
    },
    connect: () => daemonSocket,
    reconnectMs: 50,
    events: wiring.events,
    log: () => {},
  })
  tunnel.start()
})

afterEach(async () => {
  for (const h of [...holds.values()]) h.go()   // 断言失败时别把扣住的请求留在半空
  holds.clear()
  for (const b of backends.splice(0)) b.dispose()
  tunnel?.stop()
  wiring?.dispose()
  for (const g of gates) g.finish()
  for (const g of converseGates.splice(0)) g.go('')
  await workbench?.shutdown()
  db?.close()
  removeTempDir(root); removeTempDir(managedRoot)
})

/** 一条手机 ↔ 中继的内存 WebSocket(同 phone-e2e.test.ts 的 phoneLine,去掉了 v1 改写)。 */
function phoneSocket(): ProtocolSocket {
  let onMsg: ((s: string) => void) | undefined, onClose: (() => void) | undefined, onOpen: (() => void) | undefined
  let dead = false
  let streamId = ''
  phoneOut++
  const kill = () => { if (dead) return; dead = true; phones.delete(kill); hub.dropPhone(streamId); onClose?.() }
  streamId = hub.attachPhone(DAEMON, { readyState: 1, send(raw) { if (!dead) onMsg?.(raw) }, close() { kill() } }).streamId!
  phones.add(kill)
  setTimeout(() => { if (!dead) onOpen?.() }, 0)
  return {
    send(s) { phoneOut++; if (!dead) hub.onPhoneFrame(streamId, s) },
    close: kill,
    onOpen(cb) { onOpen = cb },
    onMessage(cb) { onMsg = cb },
    onClose(cb) { onClose = cb },
  }
}
const dropAllPhones = () => { for (const k of [...phones]) k() }
function live(token = deviceToken, requestTimeoutMs = 3000): Backend {
  const b = makeLiveBackend({ open: phoneSocket, token, clientOpts: { requestTimeoutMs }, log: l => logs.push(l) })
  backends.push(b)
  return b
}
function createTask(name: string) {
  const path = join(root, name)
  mkdirSync(path, { recursive: true })
  return workbench.create({ path, providerId: 'claude', text: name })
}
/** 放行任务的执行者(spawn 是异步的:建完任务那一刻闸门未必已登记)。 */
async function release(task: { path: string }): Promise<void> {
  await expect.poll(() => gates.some(g => g.path === task.path), P).toBe(true)
  const i = gates.findIndex(g => g.path === task.path)
  gates.splice(i, 1)[0]!.finish()
}
/** 扣住到达面板的每一次 key 请求(含协议客户端同 rid 的重试),直到调用返回的放行函数。 */
function hold(key: string): () => void {
  let go!: () => void
  const wait = new Promise<void>(r => { go = r })
  holds.set(key, { wait, go })
  return () => { holds.delete(key); go() }
}
/** 放行最早那句还在等的 converse(先等它到:say 收下即回,converse 在后台起)。 */
async function releaseConverse(reply: string): Promise<void> {
  await expect.poll(() => converseGates.length, P).toBeGreaterThan(0)
  converseGates.shift()!.go(reply)
}
/** 等出生 / 握手 / 事件的 poll 一律给足 5 s(三平台 runner 会饿)。 */
const P = { timeout: 5000 }
const posts = () => handled.filter(h => h.startsWith('POST')).length

/** 内存钥匙串 + 真 CredentialStore;pairAndStore 是会话的调用方式:配对成功才存。 */
function memoryCreds(): { creds: CredentialStore; keys: Map<string, string> } {
  const keys = new Map<string, string>()
  const creds = makeCredentialStore({
    getItemAsync: async k => keys.get(k) ?? null,
    setItemAsync: async (k, v) => { keys.set(k, v) },
    deleteItemAsync: async k => { keys.delete(k) },
  })
  return { creds, keys }
}
const pairDeps = (label: string) => ({ connect: (_url: string, token: string) => makeProtocolClient({ open: phoneSocket, token, requestTimeoutMs: 3000 }), label })
async function pairAndStore(link: ParsedLink, creds: CredentialStore, label = 'x') {
  const rec = await pairWithLink(link, pairDeps(label))
  await creds.save(rec)
  return rec
}
function parse(raw: string): ParsedLink {
  const p = parsePairLink(raw)
  if (!p.ok) throw new Error(`parse: ${p.error}`)
  return p.link
}

describe('手机 app LiveBackend 对着进程内真 daemon', () => {
  it('读:列表 / 详情 / 说明(lang 传到 daemon)/ 改动都过 schema;连上后 online、有同步时间', async () => {
    const b = live()
    const agents: unknown[] = []
    b.subscribe('agents', d => agents.push(d))
    await expect.poll(() => b.connection().state, P).toBe('online')
    await expect.poll(() => agents.length, P).toBeGreaterThan(0)
    const task = createTask('read-me')
    await expect.poll(async () => (await b.matters('en')).map(m => m.id), P).toContain(task.id)
    expect((await b.matter(task.id, 'en')).task?.id).toBe(task.id)
    expect(await b.insight(task.id, 'zh-Hans')).toEqual({ explanations: {}, progress: { summary: 'summary-zh-Hans', steps: [], source: 'raw' } })
    expect(await b.changes(task.id)).toBeNull()
    expect(b.connection().lastSyncedAt).not.toBeNull()
    await release(task)
  })

  it('批准:允许一次成功;同一条再提交 ⇒ stale', async () => {
    const b = live()
    const task = createTask('needs-ask')
    await expect.poll(async () => (await b.matter(task.id, 'en')).permissions.length, P).toBe(1)
    const d = await b.matter(task.id, 'en')
    const p = { id: task.id, runId: d.runId!, requestId: d.permissions[0]!.id, decision: 'allow' as const }
    await b.decide(p)
    await expect(b.decide(p)).rejects.toMatchObject({ code: 'stale' })
    await release(task)
  })

  it('配对:链接 → 链接令牌配对 → 设备令牌能用、带名字;改名;本机解除配对后该令牌 revoked', async () => {
    const link = parse(`https://relay.example/pset/#id=${DAEMON}&t=${panel.issueToken()}&p=%2Fset&lan=10.0.0.2:1`)
    const { creds } = memoryCreds()
    const rec = await pairAndStore(link, creds, 'Tendhearth · test')
    expect(rec.deviceToken).toMatch(/^d[0-9a-f]{48}$/)
    expect(await creds.load()).toEqual(rec)          // 真返回过得了钥匙串那份 schema
    const b = live(rec.deviceToken)
    expect((await b.devices()).find(x => x.current)).toMatchObject({ id: rec.deviceId, label: 'Tendhearth · test' })
    await b.renameDevice('My phone')
    expect((await b.devices()).find(x => x.current)?.label).toBe('My phone')
    await b.unpair()
    expect(panel.deviceTokens()).not.toContain(rec.deviceToken)
    const again = live(rec.deviceToken)
    await expect(again.matters('en')).rejects.toMatchObject({ code: 'revoked' })
    expect(again.connection().state).toBe('revoked')
    // 别的设备不受影响
    expect((await live().matters('en'))).toBeInstanceOf(Array)
  })

  it('被新码顶掉的链接令牌 ⇒ expired(不是 revoked),钥匙串里什么都没存', async () => {
    const stale = panel.issueToken()
    panel.issueToken()                         // 新发一枚,旧的随即作废(同一时刻只一枚)
    const { creds, keys } = memoryCreds()
    const devicesBefore = panel.deviceTokens().length
    await expect(pairAndStore(parse(`https://relay.example/pset/#id=${DAEMON}&t=${stale}`), creds)).rejects.toMatchObject({ code: 'expired' })
    expect(keys.size).toBe(0)
    expect(await creds.load()).toBeNull()
    expect(panel.deviceTokens().length).toBe(devicesBefore)
  })

  it('超过 10 分钟的链接令牌 ⇒ expired(不是 revoked),钥匙串里什么都没存', async () => {
    const link = parse(`https://relay.example/pset/#id=${DAEMON}&t=${panel.issueToken()}`)
    skewMs = SETTINGS_LINK_TTL_MS + 60_000
    const { creds, keys } = memoryCreds()
    const devicesBefore = panel.deviceTokens().length
    await expect(pairAndStore(link, creds)).rejects.toMatchObject({ code: 'expired' })
    expect(keys.size).toBe(0)
    expect(await creds.load()).toBeNull()
    expect(panel.deviceTokens().length).toBe(devicesBefore)
  })

  it('电脑上忘掉所有设备 ⇒ 连接变 revoked,之后的提交一条都不发出', async () => {
    const b = live()
    b.subscribe('agents', () => {})
    await expect.poll(() => b.connection().state, P).toBe('online')
    expect((await panel.apply({ op: 'forget_devices' })).ok).toBe(true)
    const task = createTask('after-revoke')     // 有变化 ⇒ 集线器发事件前核对令牌 ⇒ 明文 auth_failed
    await expect.poll(() => b.connection().state, P).toBe('revoked')
    const out = phoneOut, before = handled.length
    await expect(b.say(task.id, 'hi', randomUUID())).rejects.toMatchObject({ code: 'revoked' })
    await expect(b.matters('en')).rejects.toMatchObject({ code: 'revoked' })
    await new Promise(r => setTimeout(r, 100))   // 推迟到微任务 / 定时器里的发送也要被看见
    expect(phoneOut).toBe(out)
    expect(handled.length).toBe(before)
    await release(task)
  })

  it('批准在飞时电脑撤销了这台手机 ⇒ 这次提交 revoked(不是 timeout/unknown),连接 revoked,之后不再发请求', async () => {
    const b = live()
    const task = createTask('revoke-ask')
    await expect.poll(async () => (await b.matter(task.id, 'en')).permissions.length, P).toBe(1)
    const d = await b.matter(task.id, 'en')
    const go = hold('POST /m/api/matter/permission')
    const pending = b.decide({ id: task.id, runId: d.runId!, requestId: d.permissions[0]!.id, decision: 'allow' })
    const settled = pending.catch(e => e as unknown)
    await expect.poll(() => handled.includes('POST /m/api/matter/permission'), P).toBe(true)   // 已过隧道令牌核对、到了面板门口
    expect((await panel.apply({ op: 'forget_devices' })).ok).toBe(true)
    go()
    expect(await settled).toMatchObject({ code: 'revoked' })
    expect(b.connection().state).toBe('revoked')
    const out = phoneOut, before = handled.length
    await expect(b.say(task.id, 'hi', randomUUID())).rejects.toMatchObject({ code: 'revoked' })
    await expect(b.matters('en')).rejects.toMatchObject({ code: 'revoked' })
    await new Promise(r => setTimeout(r, 100))   // 同上
    expect(phoneOut).toBe(out)
    expect(handled.length).toBe(before)
    await release(task)
  })

  it('中继断了手机这条 ⇒ offline → online(epoch 前进),订阅续上;重连前成功与超时的 say 都不被重发', async () => {
    const b = live(deviceToken, 1500)   // 超时那句要等两轮 1.5 s(同 rid 重试一次);别压太短,CI runner 会饿
    const states: ConnState[] = []
    b.onConnection(c => states.push(c.state))
    const got: Array<{ tasks: Array<{ id: string }> }> = []
    b.subscribe<{ tasks: Array<{ id: string }> }>('agents', d => got.push(d))
    await expect.poll(() => b.connection().epoch, P).toBe(1)
    const first = createTask('before-drop')
    await expect.poll(() => got.at(-1)?.tasks.map(t => t.id), P).toContain(first.id)

    // 跑着的任务不收话(workbench_busy):先让这一轮收工
    await release(first)
    await expect.poll(async () => (await b.matter(first.id, 'en')).task?.status, P).not.toBe('running')
    // 一句成功的 say
    await b.say(first.id, 'first words', randomUUID())
    // 一句超时的 say:面板扣住不回(协议客户端对 retry:true 的请求同 rid 重发一次,都在拒绝之前)
    const go = hold('POST /m/api/matter/say')
    await expect(b.say(first.id, 'lost words', randomUUID())).rejects.toMatchObject({ code: 'timeout' })
    go()
    await expect.poll(() => b.connection().state, P).toBe('online')
    const sayCount = () => handled.filter(h => h === 'POST /m/api/matter/say').length
    const says0 = sayCount()
    expect(says0).toBeGreaterThanOrEqual(2)
    const p0 = posts()
    const e0 = b.connection().epoch

    dropAllPhones()
    await expect.poll(() => b.connection().epoch, P).toBeGreaterThan(e0)
    expect(states).toContain('offline')
    const task = createTask('after-drop')
    await expect.poll(() => got.at(-1)?.tasks.map(t => t.id), P).toContain(task.id)
    // 上面的 poll 已见到新 epoch 下的订阅事件 ⇒ 重连与重挂都完成了;再等 200 ms 看有没有迟到的补发 —— 不该有。
    await new Promise(r => setTimeout(r, 200))
    expect(posts()).toBe(p0)
    expect(sayCount()).toBe(says0)
    await release(first); await release(task)
  })

  it('说一句「不确定」后用同一个 requestId 重发 ⇒ daemon 按 requestId 去重:不起第二轮;换一个 requestId 才被当成新话(这一轮在跑 ⇒ busy)', async () => {
    const b = live()
    const task = createTask('say-dedupe')
    await release(task)
    await expect.poll(async () => (await b.matter(task.id, 'en')).task?.status, P).not.toBe('running')
    const rid = randomUUID()
    await b.say(task.id, 'only once', rid)
    await expect.poll(() => gates.some(g => g.path === task.path), P).toBe(true)   // 这句起了新一轮
    const runs = gates.length
    await b.say(task.id, 'only once', rid)                                          // 重发:同一张回执,不报 busy
    await expect(b.say(task.id, 'only once', randomUUID())).rejects.toMatchObject({ code: 'busy' })
    await new Promise(r => setTimeout(r, 100))
    expect(gates.length).toBe(runs)
    await release(task)
  })

  it('运行中的手机补充携带 runId ⇒ 真 daemon 排队并回回执;重复同文仍同一条,冲突可区分', async () => {
    const b = live()
    const task = createTask('live-supplement')
    await expect.poll(async () => (await b.matter(task.id, 'en')).runId, P).toBeTruthy()
    const detail = await b.matter(task.id, 'en')
    expect(detail.inputMode).toBe('queue')
    const requestId = randomUUID()
    const result = await b.say(task.id, '**补充这一轮**', requestId, { runId: detail.runId! })
    expect(result).toMatchObject({ kind: 'task', input: { id: requestId, taskId: task.id, runId: detail.runId, text: '**补充这一轮**', status: 'pending' } })
    expect(await b.say(task.id, '**补充这一轮**', requestId, { runId: detail.runId! })).toMatchObject({ kind: 'task', input: { id: requestId, status: 'pending' } })
    await expect(b.say(task.id, '不同的要求', requestId, { runId: detail.runId! })).rejects.toMatchObject({ code: 'input_conflict' })
    const fresh = await b.matter(task.id, 'en')
    expect(fresh.inputs.filter(input => input.id === requestId)).toHaveLength(1)
    expect(fresh.inputs[0]).toMatchObject({ text: '**补充这一轮**', status: 'pending' })
    await release(task)
  })

  it('对微信聊天那件事说一句「不确定」后同一 requestId 重发 ⇒ daemon 按回执去重:只说一遍、拿回原来的回复;同 id 异文 ⇒ input_conflict', async () => {
    const chat = matters.ensureChat('owner')
    const b = live(deviceToken, 400)
    const rid = randomUUID()
    // 回合扣住不放:这次 say 超时(协议客户端同 rid 自动重发一次,也跟上同一轮)
    await expect(b.say(chat.id, '只说一次', rid)).rejects.toMatchObject({ code: 'timeout' })
    await expect.poll(() => conversed.length, P).toBe(1)
    await releaseConverse('听到了')
    await expect.poll(async () => (await messages.listRange('owner', { limit: 10 })).at(-1)?.text, P).toBe('听到了')
    // 「不确定」之后用同一个 requestId 重发:成功、不起第二轮
    await b.say(chat.id, '只说一次', rid)
    await expect(b.say(chat.id, '换了一句', rid)).rejects.toMatchObject({ code: 'input_conflict' })
    await new Promise(r => setTimeout(r, 100))
    expect(conversed).toEqual(['只说一次'])
    // 换一个 requestId 才是新的一句
    const next = b.say(chat.id, '只说一次', randomUUID())
    await releaseConverse('又听到了')
    await next
    expect(conversed).toEqual(['只说一次', '只说一次'])
  })

  it('前后台:setActive(false) 关连接;setActive(true) 新握手、订阅重挂', async () => {
    const b = live()
    const got: unknown[] = []
    b.subscribe('agents', d => got.push(d))
    await expect.poll(() => b.connection().epoch, P).toBe(1)
    b.setActive(false)
    await expect.poll(() => phones.size, P).toBe(0)
    b.setActive(true)
    await expect.poll(() => b.connection().epoch, P).toBe(2)
    const task = createTask('after-resume')
    await expect.poll(() => (got.at(-1) as { tasks: Array<{ id: string }> }).tasks.map(t => t.id), P).toEqual([task.id])
    await release(task)
  })
  it('这台 daemon 没接推送(还没上 v2 中继)⇒ registerPush 报 unavailable(不是 unknown / revoked),连接照常 online', async () => {
    const b = live()
    await expect(b.registerPush('apns_sandbox', 'a1'.repeat(32))).rejects.toMatchObject({ code: 'unavailable' })
    await expect.poll(() => b.connection().state, P).toBe('online')
  })

  it('跟 CC 说:收下即回 pending → 主题唤醒 → 拉到回复;同一 requestId 重发不说两遍', async () => {
    matters.ensureChat('owner')                       // 主人在微信里说过话:对话已经在了
    const b = live()
    await expect.poll(() => b.connection().state, P).toBe('online')
    const first = await b.chat({})
    expect(first).toMatchObject({ messages: [], pending: null, failed: null, hasMore: false })
    const versions: Array<{ phase?: string }> = []
    b.subscribe<{ phase?: string }>(`matter/${first.matterId}`, d => versions.push(d))
    await expect.poll(() => versions.length, P).toBeGreaterThan(0)
    const rid = randomUUID()
    const job = await b.chatSay('你好', rid)
    expect(job).toMatchObject({ requestId: rid, status: 'pending' })
    expect((await b.chatSay('你好', rid)).status).toBe('pending')   // 同一 requestId:同一张回执
    await expect(b.chatSay('另一句', randomUUID())).rejects.toMatchObject({ code: 'busy' })
    await expect.poll(() => conversed.length, P).toBe(1)
    expect(conversed).toEqual(['你好'])
    expect((await b.chat({})).pending?.requestId).toBe(rid)
    await expect.poll(() => versions.at(-1)?.phase, P).toBe('working')
    await releaseConverse('在呢')
    await expect.poll(async () => (await b.chat({})).messages.at(-1)?.text, P).toBe('在呢')
    const page = await b.chat({})
    expect(page.pending).toBeNull()
    expect(page.messages.map(m => [m.role, m.text, m.source])).toEqual([['me', '你好', 'phone'], ['cc', '在呢', 'phone']])
    await expect.poll(() => versions.at(-1)?.phase, P).not.toBe('working')
    expect(versions.length).toBeGreaterThan(1)
    expect(conversed).toHaveLength(1)
  })

  it('还没有主人对话 ⇒ chat() not_found(页面当空对话);照样能说,第一句建出对话', async () => {
    const b = live()
    await expect(b.chat({})).rejects.toMatchObject({ code: 'not_found' })
    expect((await b.chatSay('第一句', randomUUID())).status).toBe('pending')
    await releaseConverse('你好呀')
    await expect.poll(async () => (await b.chat({}).catch(() => null))?.messages.at(-1)?.text, P).toBe('你好呀')
    expect((await b.chat({})).matterId).toBe(matters.findChat('owner')?.id)
  })

  it('连接:真快照过 schema(插件快照没出来 ⇒ 不知道,不撒谎);原生会话没接上 ⇒ unavailable(不是 unknown)', async () => {
    const b = live()
    const task = createTask('linked')
    const c = await b.connections()
    expect(c.sources).toEqual([{ id: 'wechat_history', kind: 'wechat_history', name: 'wxvault', state: 'unknown', latestAt: null, syncedAt: null }])
    expect(c.computers).toEqual([{ id: 'home', online: true, label: 'e2e-mac', since: 1, version: null }])
    expect(c.recent.map(r => r.matterId)).toEqual([task.id])
    await expect(b.sessions('claude')).rejects.toMatchObject({ code: 'unavailable' })
    await expect(b.session('a2V5')).rejects.toMatchObject({ code: 'unavailable' })
    await release(task)
  })

  it('接着做电脑上的会话:预览 ready → 接成一件事(再点同一件)→ managed → 详情 nativeStart → 第一句接着原会话跑完 → nativeStart 消失;正在跑的会话 ⇒ busy', async () => {
    const b = live()
    await expect.poll(() => b.connection().state, P).toBe('online')
    const key = encodeNativeHistoryKey('claude', 'e2e-native')
    expect(await b.continuePreview(key)).toEqual({ state: 'ready', provider: 'claude', project: 'native', mode: 'native_resume', matterId: null })
    const { matterId } = await b.continueSession(key)
    expect((await b.continueSession(key)).matterId).toBe(matterId)
    expect(await b.continuePreview(key)).toMatchObject({ state: 'managed', matterId })
    expect((await b.matter(matterId, 'zh-Hans')).nativeStart).toEqual({ mode: 'native_resume', providerId: 'claude' })
    expect((await b.matters('zh-Hans')).some(m => m.id === matterId)).toBe(true)
    await b.say(matterId, '接着做', randomUUID())
    await release({ path: nativeDir })
    await expect.poll(async () => (await b.matter(matterId, 'zh-Hans')).events.some(e => e.text === '做完了'), P).toBe(true)
    expect((await b.matter(matterId, 'zh-Hans')).nativeStart).toBeUndefined()
    const busy = encodeNativeHistoryKey('claude', 'e2e-busy')
    expect(await b.continuePreview(busy)).toMatchObject({ state: 'busy_session', matterId: null })
    await expect(b.continueSession(busy)).rejects.toMatchObject({ code: 'session_busy' })
  })
})

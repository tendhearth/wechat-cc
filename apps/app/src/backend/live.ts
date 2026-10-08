/**
 * live.ts — 真连接后端:经中继用协议包 v2 连回家里的 daemon(spec §4)。
 * 订阅主题拿摘要与版本号,req 拉详情;每个返回过 PHONE_API_SCHEMAS,每条事件过主题 schema;
 * 错误码映射在 net/errors.ts,连接状态机在 net/connection.ts。
 * 纯 TS,不引 react-native:socket 由调用方注入(RN 用 net/rn-connect.ts),根目录的进程内端到端测试也直接用它。
 * 日志只写错误码与路由键,从不写令牌。
 *
 * 重入:协议客户端在 onStatus / onSubscriptionError 钩子里(connecting / down 时 conn 还是空的)被同步回调
 * request() / subscribe() 会开出第二条连接。所以钩子里只改状态(连接监听者照常同步收到),
 * 钩子期间对客户端的一切调用(请求、挂订阅、退订、关)都推到微任务之后。
 */
import {
  makeProtocolClient, PHONE_API_SCHEMAS, PHONE_ANSWER_MAX_JSON, PHONE_SAY_MAX_CHARS,
  HomeTopic, ApprovalsTopic, AgentsTopic, MatterTopic,
  type ClientOpts, type ProtocolClient, type ProtocolSocket,
} from '@wechat-cc/protocol'
import { INITIAL_CONNECTION, reduceConnection, type ConnEvent } from '../net/connection'
import { mapPhoneError, transportErrorCode } from '../net/errors'
import {
  BackendError,
  type ApprovalExplanationT, type Backend, type Connection, type DeviceRowT, type EntryOptionsT,
  type MatterDetailT, type MatterT, type PhoneChangesTurnT, type ProgressSummaryT, type Unsubscribe,
  type ChatPageT, type ChatJobT, type ConnectionsT, type NativeSessionRowT, type NativeSessionPageT, type SessionContinueT,
  type MatterSayResultT, type MatterInputT, type UploadStateT, type EntryModelCatalogT, type MemoryViewT, type ChatModelViewT, type ChatSearchHitT,
} from './types'

type Topic = Parameters<Backend['subscribe']>[0]
/** 常驻订阅:没人用时协议客户端不连,状态机就不知道电脑在不在。approvals 最轻,也是「此刻」最要紧的那份。 */
const LIVENESS: Topic = 'approvals'

export type LiveDeps = {
  open: () => ProtocolSocket
  token: string
  now?: () => number
  log?: (line: string) => void
  makeClient?: (o: ClientOpts) => ProtocolClient
  clientOpts?: Partial<Pick<ClientOpts, 'requestTimeoutMs' | 'handshakeTimeoutMs' | 'keepaliveMs' | 'requestDeadlineMs'>>
}

const schemaOf = (topic: string) =>
  topic === 'home' ? HomeTopic : topic === 'approvals' ? ApprovalsTopic : topic === 'agents' ? AgentsTopic : MatterTopic

type Reg = { topic: Topic; cbs: Set<(d: unknown) => void>; off: (() => void) | null; last?: unknown; pinned: boolean }

export function makeLiveBackend(d: LiveDeps): Backend {
  const now = d.now ?? (() => Date.now())
  const log = d.log ?? (() => {})
  const mk = d.makeClient ?? makeProtocolClient
  let conn: Connection = INITIAL_CONNECTION
  const connLs = new Set<(c: Connection) => void>()
  const regs = new Map<string, Reg>()
  let client: ProtocolClient | null = null
  let gen = 0
  let disposed = false
  let hookDepth = 0

  /** 在协议客户端的钩子里跑:期间对客户端的调用一律推迟(见文件头「重入」)。 */
  function hooked(fn: () => void): void {
    hookDepth++
    try { fn() } finally { hookDepth-- }
  }
  /** 碰客户端的动作:在钩子里 ⇒ 微任务之后再做;否则立刻做。 */
  function later(fn: () => void): void {
    if (hookDepth > 0) queueMicrotask(fn)
    else fn()
  }

  function dispatch(e: ConnEvent): void {
    const next = reduceConnection(conn, e)
    if (next === conn) return
    conn = next
    // 一个监听者抛错不能打断别的监听者,更不能打断 revoke() 后面的 closeClient()。
    for (const cb of [...connLs]) {
      try { cb(conn) } catch (e) { log(`connection listener threw (${e instanceof Error ? e.name : 'unknown'})`) }
    }
  }
  const connection = (): Connection => conn
  function closeClient(): void {
    gen++ // 旧客户端之后的回调一律作废
    const c = client
    client = null
    for (const r of regs.values()) r.off = null
    if (c) later(() => { try { c.close() } catch { /* 已关 */ } })
  }
  function revoke(): void {
    dispatch({ t: 'revoked' })
    closeClient()
  }
  function onEvent(r: Reg, data: unknown): void {
    const p = schemaOf(r.topic).safeParse(data)
    if (!p.success) { log(`topic ${r.topic}: bad event dropped`); return }
    r.last = p.data
    dispatch({ t: 'synced', at: now() })
    for (const cb of [...r.cbs]) cb(p.data)
  }
  function attach(r: Reg): void {
    later(() => {
      const c = client
      if (!c || r.off || regs.get(r.topic) !== r) return
      const my = gen
      try {
        const off = c.subscribe(r.topic, data => { if (my === gen) onEvent(r, data) })
        r.off = off
      } catch (e) { r.off = null; log(`topic ${r.topic}: subscribe failed (${e instanceof Error ? e.message : 'unknown'})`) }
    })
  }
  function start(): void {
    if (client || disposed || conn.state === 'revoked') return
    const my = ++gen
    client = mk({
      ...d.clientOpts,
      open: d.open,
      token: d.token,
      onStatus: s => hooked(() => {
        if (my !== gen) return
        if (s === 'auth_failed') revoke()
        else dispatch({ t: 'status', s })
      }),
      onSubscriptionError: (topic, code) => hooked(() => {
        if (my !== gen) return
        if (code === 'auth_failed') { revoke(); return }
        log(`topic ${topic}: ${code}`)
        // 这份订阅已作废:清掉句柄,下次重连(start)时重挂。
        const r = regs.get(topic)
        if (r) r.off = null
      }),
      onProtocolError: reason => log(`protocol: ${reason}`),
    })
    for (const r of regs.values()) attach(r)
  }

  async function call<T>(key: string, path: string, init: { body?: unknown; retry?: boolean } = {}): Promise<T> {
    if (hookDepth > 0) await new Promise<void>(r => queueMicrotask(r))
    if (conn.state === 'revoked') throw new BackendError('revoked')
    if (!client) throw new BackendError('offline')
    const c = client
    const my = gen
    const method = key.slice(0, key.indexOf(' '))
    let res: Awaited<ReturnType<ProtocolClient['request']>>
    try {
      res = await c.request({
        method, path,
        ...(init.body !== undefined ? { body: JSON.stringify(init.body), headers: { 'content-type': 'application/json' } } : {}),
        ...(init.retry !== undefined ? { retry: init.retry } : {}),
      })
    } catch (e) {
      // 这条可能已经送到电脑上,是我们自己把连接关了(进后台 / dispose / 撤销):不能说「没送到」。
      // 撤销了 ⇒ revoked;否则 ⇒ timeout,store 译成「不确定」,页面去重拉。
      if (e instanceof Error && e.message === 'closed' && (my !== gen || disposed)) {
        // (await 期间 revoke() 可能已改了 conn;TS 按 await 之前的收窄判断,这里重新读一次。)
        if (connection().state === 'revoked') throw new BackendError('revoked')
        log(`${key}: closed locally while in flight`)
        throw new BackendError('timeout')
      }
      const code = transportErrorCode(e)
      if (code === 'revoked') revoke()
      else log(`${key}: ${code}`)
      throw new BackendError(code)
    }
    let json: unknown = null
    try { json = res.json() } catch { /* 非 JSON:交给状态码判断 */ }
    const mapped = mapPhoneError(res.status, json)
    if (mapped) {
      if (mapped === 'revoked') revoke()
      else log(`${key}: ${res.status} ${mapped}`)
      throw new BackendError(mapped)
    }
    const schema = PHONE_API_SCHEMAS[key]
    const p = schema ? schema.safeParse(json) : null
    if (!p || !p.success) { log(`${key}: response did not match schema`); throw new BackendError('unknown') }
    dispatch({ t: 'synced', at: now() })
    return p.data as T
  }
  const idq = (id: string) => `id=${encodeURIComponent(id)}`
  function strip<T extends { ok: true }>(r: T): Omit<T, 'ok'> {
    const { ok: _ok, ...rest } = r
    return rest
  }

  regs.set(LIVENESS, { topic: LIVENESS, cbs: new Set(), off: null, pinned: true })
  start()

  const backend: Backend = {
    mode: 'live',
    connection: () => conn,
    onConnection(cb) { connLs.add(cb); cb(conn); return () => { connLs.delete(cb) } },
    subscribe<T>(topic: Topic, cb: (data: T) => void): Unsubscribe {
      let reg = regs.get(topic)
      if (!reg) { reg = { topic, cbs: new Set(), off: null, pinned: false }; regs.set(topic, reg); attach(reg) }
      const r = reg
      const f = cb as (x: unknown) => void
      r.cbs.add(f)
      if (r.last !== undefined) f(r.last)
      return () => {
        r.cbs.delete(f)
        if (r.cbs.size > 0 || r.pinned || regs.get(topic) !== r) return
        regs.delete(topic)
        const off = r.off
        r.off = null
        if (off) later(off)
      }
    },
    async matters() {
      return (await call<{ matters: MatterT[] }>('GET /m/api/matters', '/m/api/matters')).matters
    },
    async matter(id) {
      return strip(await call<{ ok: true } & MatterDetailT>('GET /m/api/matter', `/m/api/matter?${idq(id)}`))
    },
    async matterInputReceipt(id, requestId) {
      try {
        return (await call<{ ok: true; input: MatterInputT }>('GET /m/api/matter/input-receipt', `/m/api/matter/input-receipt?${idq(id)}&requestId=${encodeURIComponent(requestId)}`)).input
      } catch (e) {
        if (e instanceof BackendError && e.code === 'not_found') return null
        throw e
      }
    },
    async insight(id, lang) {
      const r = await call<{ explanations: Record<string, ApprovalExplanationT>; progress: ProgressSummaryT | null }>(
        'GET /m/api/matter/insight', `/m/api/matter/insight?${idq(id)}&lang=${encodeURIComponent(lang)}`)
      return { explanations: r.explanations, progress: r.progress }
    },
    async changes(id) {
      return (await call<{ turn: PhoneChangesTurnT | null }>('GET /m/api/matter/changes', `/m/api/matter/changes?${idq(id)}`)).turn
    },
    async chat(p) {
      const q = [p.before ? `before=${encodeURIComponent(p.before)}` : '', p.limit !== undefined ? `limit=${p.limit}` : ''].filter(Boolean).join('&')
      return strip(await call<{ ok: true } & ChatPageT>('GET /m/api/chat', `/m/api/chat${q ? '?' + q : ''}`))
    },
    async chatSay(text, requestId, materials) {
      if (text.length > PHONE_SAY_MAX_CHARS) throw new BackendError('invalid')
      const body = materials?.attachmentIds.length ? { requestId, text, draftId: materials.draftId, attachmentIds: materials.attachmentIds } : { requestId, text }
      return (await call<{ job: ChatJobT }>('POST /m/api/chat/say', '/m/api/chat/say', { body, retry: true })).job
    },
    async chatSearch(q) {
      const query = q.trim()
      if (!query || query.length > 200) throw new BackendError('invalid')
      return (await call<{ hits: ChatSearchHitT[] }>('GET /m/api/chat/search', `/m/api/chat/search?q=${encodeURIComponent(query)}`)).hits
    },
    async memory() {
      return strip(await call<{ ok: true } & MemoryViewT>('GET /m/api/memory', '/m/api/memory'))
    },
    async correctMemory(id, verdict) {
      await call('POST /m/api/memory/correct', '/m/api/memory/correct', { body: { id, verdict } })
    },
    async uploadChunk(p) {
      // 不自动重发:同一块重传由上传循环先问进度再续(uploadStatus),不在协议层盲重试。
      return strip(await call<{ ok: true } & UploadStateT>('POST /m/api/attachment/chunk', '/m/api/attachment/chunk', { body: p }))
    },
    async uploadStatus(id, draftId) {
      return strip(await call<{ ok: true } & UploadStateT>('GET /m/api/attachment/upload', `/m/api/attachment/upload?id=${encodeURIComponent(id)}&draftId=${encodeURIComponent(draftId)}`))
    },
    async discardUpload(id, draftId) {
      await call('POST /m/api/attachment/discard', '/m/api/attachment/discard', { body: { id, draftId } })
    },
    async chatModel() { return strip(await call<{ ok: true } & ChatModelViewT>('GET /m/api/chat/model', '/m/api/chat/model')) },
    async setChatModel(provider, model) { return strip(await call<{ ok: true } & ChatModelViewT>('POST /m/api/chat/model', '/m/api/chat/model', { body: { provider, model } })) },
    async chatFileChunk(p) {
      return strip(await call<{ ok: true; name: string; mime: string; size: number; sha256: string; offset: number; nextOffset: number; contentBase64: string }>('GET /m/api/chat/file',
        `/m/api/chat/file?id=${encodeURIComponent(p.messageId)}&i=${p.index}&offset=${p.offset}`))
    },
    async chatVoice(messageId, index) {
      return strip(await call<{ ok: true; mime: string; data: string }>('GET /m/api/chat/voice', `/m/api/chat/voice?id=${encodeURIComponent(messageId)}&i=${index}`))
    },
    async sticker(file) {
      return strip(await call<{ ok: true; mime: string; data: string }>('GET /m/api/sticker/', `/m/api/sticker/${encodeURIComponent(file)}?b64=1`))
    },
    async connections() {
      return strip(await call<{ ok: true } & ConnectionsT>('GET /m/api/connections', '/m/api/connections'))
    },
    async sessions(provider, cursor, q) {
      if (q !== undefined && (q.length > 200 || q.includes('\0'))) throw new BackendError('invalid')
      const r = await call<{ items: NativeSessionRowT[]; nextCursor: string | null }>(
        'GET /m/api/sessions', `/m/api/sessions?provider=${provider}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}${q ? `&q=${encodeURIComponent(q.trim())}` : ''}`)
      return { items: r.items, nextCursor: r.nextCursor }
    },
    async session(key, cursor, window) {
      if (window === 'recent' && cursor !== undefined) throw new BackendError('invalid')
      return strip(await call<{ ok: true } & NativeSessionPageT>(
        'GET /m/api/session', `/m/api/session?key=${encodeURIComponent(key)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}${window ? `&window=${window}` : ''}`))
    },
    async continuePreview(key) {
      return strip(await call<{ ok: true } & SessionContinueT>('GET /m/api/session/continue', `/m/api/session/continue?key=${encodeURIComponent(key)}`))
    },
    async continueSession(key) {
      // 幂等(spec D9):超时后协议客户端可以原样重发,daemon 回同一件事。
      const r = await call<{ matterId: string; created: boolean }>('POST /m/api/session/continue', '/m/api/session/continue', { body: { key }, retry: true })
      return { matterId: r.matterId }
    },
    async handoff(p) {
      // 幂等(requestId;一件事也只交一次):超时后协议客户端可以原样重发,daemon 回同一件。
      const r = await call<{ matterId: string; created: boolean }>('POST /m/api/matter/handoff', '/m/api/matter/handoff', { body: { id: p.id, requestId: p.requestId, providerId: p.providerId }, retry: true })
      return { matterId: r.matterId }
    },
    async decide(p) {
      await call('POST /m/api/matter/permission', '/m/api/matter/permission', { body: { id: p.id, runId: p.runId, requestId: p.requestId, decision: p.decision } })
    },
    async artifactChunk(p) {
      const r = strip(await call<{ ok: true; offset: number; nextOffset: number; size: number; contentBase64: string }>('GET /m/api/matter/artifact',
        `/m/api/matter/artifact?id=${encodeURIComponent(p.id)}&artifactId=${encodeURIComponent(p.artifactId)}&sha256=${encodeURIComponent(p.sha256)}&offset=${p.offset}`))
      return { offset: r.offset, nextOffset: r.nextOffset, size: r.size, contentBase64: r.contentBase64 }
    },
    async stop(p) {
      await call('POST /m/api/matter/stop', '/m/api/matter/stop', { body: { id: p.id, runId: p.runId } })
    },
    async worktree(p) {
      return strip(await call<{ ok: true; branch: string; committed?: boolean; removed?: boolean; merged?: boolean; reopened?: boolean }>('POST /m/api/matter/worktree', '/m/api/matter/worktree', { body: { id: p.id, action: p.action } }))
    },
    async answer(p) {
      if (p.answers !== null && JSON.stringify(p.answers).length > PHONE_ANSWER_MAX_JSON) throw new BackendError('invalid')
      await call('POST /m/api/matter/answer', '/m/api/matter/answer', { body: { id: p.id, runId: p.runId, requestId: p.requestId, answers: p.answers } })
    },
    async say(id, text, requestId, options) {
      if (text.length > PHONE_SAY_MAX_CHARS) throw new BackendError('invalid')
      // A reconnect checks the durable receipt. Only an explicit user retry replays the POST.
      return (await call<{ ok: true; result: MatterSayResultT }>('POST /m/api/matter/say', '/m/api/matter/say', { body: { id, text, requestId, ...(options?.runId ? { runId: options.runId } : {}), ...(options?.attachmentIds?.length && options.draftId ? { draftId: options.draftId, attachmentIds: options.attachmentIds } : {}) }, retry: false })).result
    },
    async entryModels(providerId, projectId) {
      return (await call<{ catalog: EntryModelCatalogT }>('GET /m/api/entry/models', `/m/api/entry/models?providerId=${encodeURIComponent(providerId)}${projectId ? `&projectId=${encodeURIComponent(projectId)}` : ''}`)).catalog
    },
    async entryOptions() {
      return strip(await call<{ ok: true } & EntryOptionsT>('GET /m/api/entry/options', '/m/api/entry/options'))
    },
    async create(p) {
      const body = {
        requestId: p.requestId, text: p.text,
        target: p.projectId ? { kind: 'project', projectId: p.projectId, ...(p.isolation ? { isolation: 'worktree', ...(p.base ? { base: p.base } : {}) } : {}) } : { kind: 'managed' },
        ...(p.providerId ? { providerId: p.providerId } : {}),
        ...(p.attachmentIds?.length && p.draftId ? { draftId: p.draftId, attachmentIds: p.attachmentIds } : {}),
        ...(p.execution && (p.execution.model || p.execution.reasoningEffort) ? { execution: { ...(p.execution.model ? { model: p.execution.model } : {}), ...(p.execution.reasoningEffort ? { reasoningEffort: p.execution.reasoningEffort } : {}) } } : {}),
      }
      try {
        const r = await call<{ receipt: { matterId: string } }>('POST /m/api/matter/create', '/m/api/matter/create', { body, retry: true })
        return { matterId: r.receipt.matterId }
      } catch (e) {
        if (!(e instanceof BackendError) || e.code !== 'timeout') throw e
        // 超时不等于没收到:按 requestId 查一次回执,查到就当成功。
        try {
          const r = await call<{ receipt: { matterId: string } }>('GET /m/api/matter/create-receipt', `/m/api/matter/create-receipt?requestId=${encodeURIComponent(p.requestId)}`)
          return { matterId: r.receipt.matterId }
        } catch (e2) {
          // 查回执时发现被撤销:如实报 revoked,别让原来的超时盖掉。
          if (e2 instanceof BackendError && e2.code === 'revoked') throw e2
          throw e
        }
      }
    },
    async devices() {
      return (await call<{ remote: { devices: DeviceRowT[] } }>('GET /set/api/state', '/set/api/state')).remote.devices
    },
    async renameDevice(label) {
      const me = (await backend.devices()).find(x => x.current)
      if (!me) throw new BackendError('unknown')
      await call('POST /set/api/apply', '/set/api/apply', { body: { op: 'label_device', id: me.id, label } })
    },
    async registerPush(platform, token) {
      await call('POST /m/api/push/register', '/m/api/push/register', { body: { platform, token } })
    },
    async testPush() {
      return (await call<{ result: { ok: boolean; code: string } }>('POST /m/api/push/test', '/m/api/push/test', { body: {} })).result
    },
    async unpair() {
      await call('POST /set/api/apply', '/set/api/apply', { body: { op: 'unpair_self' } })
      backend.dispose()
    },
    setActive(active) {
      if (disposed) return
      if (active) start()
      else closeClient()
    },
    dispose() { disposed = true; closeClient() },
  }
  return backend
}

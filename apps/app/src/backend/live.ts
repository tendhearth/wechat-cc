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
  makeProtocolClient, makePhoneApi, toProtocolRequest, PHONE_API_SCHEMAS, PHONE_ANSWER_MAX_JSON, PHONE_SAY_MAX_CHARS, PHONE_TRANSCRIBE_MAX_BYTES, PHONE_TRANSCRIBE_MIMES,
  HomeTopic, ApprovalsTopic, AgentsTopic, MatterTopic,
  type ClientOpts, type ProtocolClient, type ProtocolSocket, type PhoneTransport,
} from '@wechat-cc/protocol'
import { INITIAL_CONNECTION, reduceConnection, type ConnEvent } from '../net/connection'
import { mapPhoneError, transportErrorCode } from '../net/errors'
import {
  BackendError,
  type ApprovalExplanationT, type Backend, type Connection, type DeviceRowT, type EntryOptionsT,
  type MatterDetailT, type MatterT, type PhoneChangesTurnT, type ProgressSummaryT, type Unsubscribe,
  type ChatPageT, type ChatJobT, type ConnectionsT, type NativeSessionRowT, type NativeSessionPageT, type SessionContinueT,
  type MatterSayResultT, type MatterInputT, type CliSessionRowT, type CliActivityItemT, type OverseerTodayT, type CompanionHomeT, type FeedEventT, type PresenceT, type UploadStateT, type EntryModelCatalogT, type MemoryViewT, type ChatModelViewT, type ChatSearchHitT, type LetterSummaryT, type FileChunkT, type JobsViewT, type ActivityPageT, type RewindPreviewT, type PocketT,
} from './types'

type Topic = Parameters<Backend['subscribe']>[0]
/** 常驻订阅:没人用时协议客户端不连,状态机就不知道电脑在不在。approvals 最轻,也是「此刻」最要紧的那份。 */
const LIVENESS: Topic = 'approvals'
/** 此刻页读首屏动态的条数(daemon 默认 30、上限 100)。 */
const HOME_LIMIT = 20

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
      // 协议客户端只说 v2(2026-10-25 v1 退休):回来 v1 ⇒ 当中继篡改,拒绝降级(downgrade_refused)
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

  /** 类型化客户端的传输(F3):经中继 v2 送、按状态码 / 错误码挡失败、过 PHONE_API_SCHEMAS。路径由 `PHONE_CALLS` 拼。 */
  const send: PhoneTransport = async req => {
    const key = req.key
    if (hookDepth > 0) await new Promise<void>(r => queueMicrotask(r))
    if (conn.state === 'revoked') throw new BackendError('revoked')
    if (!client) throw new BackendError('offline')
    const c = client
    const my = gen
    let res: Awaited<ReturnType<ProtocolClient['request']>>
    try {
      res = await c.request(toProtocolRequest(req))
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
    return p.data
  }
  const api = makePhoneApi(send)
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
      return (await api.matters.list()).matters
    },
    async matter(id) {
      return strip(await api.matters.get({ query: { id } }))
    },
    async matterInputReceipt(id, requestId) {
      try {
        return (await api.matters.inputReceipt({ query: { id, requestId } })).input
      } catch (e) {
        if (e instanceof BackendError && e.code === 'not_found') return null
        throw e
      }
    },
    async insight(id, lang) {
      const r = await api.matters.insight({ query: { id, lang } })
      return { explanations: r.explanations, progress: r.progress }
    },
    async changes(id) {
      return (await api.matters.changes({ query: { id } })).turn
    },
    async reviewMark(p) {
      await api.matters.reviewMark({ body: { id: p.id, artifactId: p.artifactId, path: p.path, mark: 'accepted' } })
    },
    async reviewReturn(p) {
      if (p.comment.length > PHONE_SAY_MAX_CHARS) throw new BackendError('invalid')
      await api.matters.reviewReturn({ body: { id: p.id, artifactId: p.artifactId, paths: p.paths, comment: p.comment } })
    },
    // 行评论(切片 4):建按 commentId 幂等(同内容回原行);删也幂等(哪儿都没有这个 id ⇒ daemon 当已删过)⇒ 超时可自动重发。
    // 发出不自动重发(retry:false,协议客户端超时只拒不重发):重发时草稿多半已记成已发出,会回「没有草稿」。
    async reviewComment(p) {
      if (p.body.length > 2000) throw new BackendError('invalid')
      await api.matters.reviewComment({ body: { id: p.id, commentId: p.commentId, artifactId: p.artifactId, path: p.path, hunk: p.hunk, hunkSha256: p.hunkSha256, body: p.body }, retry: true })
    },
    async reviewCommentDelete(p) {
      await api.matters.reviewComment({ body: { id: p.id, commentId: p.commentId, delete: true }, retry: true })
    },
    async reviewCommentsSend(p) {
      if ((p.summary?.length ?? 0) > 2000) throw new BackendError('invalid')
      const r = await api.matters.reviewCommentsSend({ body: { id: p.id, inputRequestId: p.requestId, ...(p.summary ? { summary: p.summary } : {}) }, retry: false })
      return { sent: r.sent ?? 0, remaining: r.remaining ?? 0, skippedDiscarded: r.skippedDiscarded ?? 0 }
    },
    async rewindPreview(p) {
      return (await api.matters.rewindPreview({ query: { id: p.id, artifactId: p.artifactId } })).preview
    },
    async rewind(p) {
      // 不自动重发:超时 ⇒ 不确定(页面说「过一会儿看看」),重发要主人自己再点 —— 那时 token 多半已过期,会重拉预览
      await api.matters.rewind({ body: { id: p.id, artifactId: p.artifactId, token: p.token } })
    },
    async chat(p) {
      return strip(await api.chat.page({ query: { before: p.before || undefined, limit: p.limit } }))
    },
    async chatSay(text, requestId, materials) {
      if (text.length > PHONE_SAY_MAX_CHARS) throw new BackendError('invalid')
      const body = materials?.attachmentIds.length ? { requestId, text, draftId: materials.draftId, attachmentIds: materials.attachmentIds } : { requestId, text }
      return (await api.chat.say({ body, retry: true })).job
    },
    async chatSearch(q) {
      const query = q.trim()
      if (!query || query.length > 200) throw new BackendError('invalid')
      return (await api.chat.search({ query: { q: query } })).hits
    },
    async memory() {
      return strip(await api.memory.get())
    },
    async correctMemory(id, verdict) {
      await api.memory.correct({ body: { id, verdict } })
    },
    async memoryRetractions() {
      return (await api.memory.retractions()).items
    },
    async restoreMemory(key) {
      const r = await api.memory.restore({ body: { key } })
      return { restored: r.restored, note: r.note }
    },
    async pocket() {
      // 这一条还带名字、SVG 画像、表情库;App 只取待办与 PNG 画像
      const r = await api.state.get()
      return { todos: { active: r.todos.active, settled: r.todos.settled }, portraitPng: r.portraitPng ?? null }
    },
    async setTodo(id, status) {
      // 不自动重发:超时 ⇒ 不确定,页面重拉
      await api.todos.set({ body: { id, status } })
    },
    async uploadChunk(p) {
      // 不自动重发:同一块重传由上传循环先问进度再续(uploadStatus),不在协议层盲重试。
      return strip(await api.attachments.chunk({ body: p }))
    },
    async uploadStatus(id, draftId) {
      return strip(await api.attachments.upload({ query: { id, draftId } }))
    },
    async discardUpload(id, draftId) {
      await api.attachments.discard({ body: { id, draftId } })
    },
    async chatModel() { return strip(await api.chat.model()) },
    async setChatModel(provider, model) { return strip(await api.chat.setModel({ body: { provider, model } })) },
    async chatFileChunk(p) {
      return strip(await api.chat.file({ query: { id: p.messageId, i: p.index, offset: p.offset } }))
    },
    async jobs() {
      return strip(await api.jobs.list())
    },
    async jobsAction(id, action) {
      // 正文恰好 { id, action }(daemon 多一个键就 400)
      await api.jobs.action({ body: { id, action } })
    },
    async activity(p) {
      return strip(await api.activity.list({ query: { cursor: p?.cursor || undefined } }))
    },
    async letters() {
      return (await api.letters.list()).letters
    },
    async letterPageChunk(p) {
      return strip(await api.letters.page({ query: { id: p.id, p: p.page, offset: p.offset } }))
    },
    async chatVoice(messageId, index) {
      return strip(await api.chat.voice({ query: { id: messageId, i: index } }))
    },
    async transcribeStatus() {
      return { configured: (await api.chat.transcribeStatus()).configured }
    },
    async transcribe(p) {
      // 一帧装不下的在手机上就拦,不白传;不自动重发(转一次就够,重发会让电脑再转一遍)。
      if (p.audioBase64.length > Math.ceil(PHONE_TRANSCRIBE_MAX_BYTES / 3) * 4) throw new BackendError('too_large')
      if (!p.audioBase64 || !(PHONE_TRANSCRIBE_MIMES as readonly string[]).includes(p.mime)) throw new BackendError('invalid')
      return (await api.chat.transcribe({ body: { mime: p.mime, audioBase64: p.audioBase64 } })).text
    },
    async sticker(file) {
      return strip(await api.stickers.get({ suffix: file, query: { b64: 1 } }))
    },
    async connections() {
      return strip(await api.connections.get())
    },
    async sessions(provider, cursor, q) {
      if (q !== undefined && (q.length > 200 || q.includes('\0'))) throw new BackendError('invalid')
      const r = await api.sessions.list({ query: { provider, cursor: cursor || undefined, q: q ? q.trim() : undefined } })
      return { items: r.items, nextCursor: r.nextCursor, ...(r.names ? { names: r.names } : {}) }
    },
    async session(key, cursor, window) {
      if (window === 'recent' && cursor !== undefined) throw new BackendError('invalid')
      return strip(await api.sessions.get({ query: { key, cursor: cursor || undefined, window: window || undefined } }))
    },
    async continuePreview(key) {
      return strip(await api.sessions.continuePreview({ query: { key } }))
    },
    async continueSession(key) {
      // 幂等(spec D9):超时后协议客户端可以原样重发,daemon 回同一件事。
      const r = await api.sessions.continue({ body: { key }, retry: true })
      return { matterId: r.matterId }
    },
    async handoff(p) {
      // 幂等(requestId;一件事也只交一次):超时后协议客户端可以原样重发,daemon 回同一件。
      const r = await api.matters.handoff({ body: { id: p.id, requestId: p.requestId, providerId: p.providerId }, retry: true })
      return { matterId: r.matterId }
    },
    async cliSessions() {
      return (await api.cli.sessions()).sessions
    },
    async cliPermission(p) {
      // 有码就带码:防止这期间换了一项待批,手机批到了没看过的那一项。
      await api.cli.permission({ body: { session_id: p.sessionId, ...(p.hash ? { hash: p.hash } : {}), decision: p.decision } })
    },
    async cliSay(sessionId, text) {
      const r = await api.cli.say({ body: { session_id: sessionId, text } })
      return { sayId: r.say_id ?? null }
    },
    async cliActivity(sessionId) {
      return (await api.cli.activity({ query: { session_id: sessionId } })).items
    },
    async today() {
      return (await api.today.get()).today
    },
    async home() {
      // 此刻页只要 CC 在干什么 + 最近一张带回来的东西;20 条够盖住一天里的想法 / 聊天日摘要。
      const r = await api.home.get({ query: { limit: HOME_LIMIT } })
      return { presence: r.presence, seenUntil: r.seen_until, unread: r.unread, events: r.events }
    },
    async markSeen(until) {
      return (await api.home.seen({ body: { until } })).seen_until
    },
    async decide(p) {
      await api.matters.permission({ body: { id: p.id, runId: p.runId, requestId: p.requestId, decision: p.decision } })
    },
    async artifactChunk(p) {
      const r = strip(await api.matters.artifact({ query: { id: p.id, artifactId: p.artifactId, sha256: p.sha256, offset: p.offset } }))
      return { offset: r.offset, nextOffset: r.nextOffset, size: r.size, contentBase64: r.contentBase64 }
    },
    async stop(p) {
      await api.matters.stop({ body: { id: p.id, runId: p.runId } })
    },
    async worktree(p) {
      return strip(await api.matters.worktree({ body: { id: p.id, action: p.action } }))
    },
    async worktreeScript(p) {
      return strip(await api.matters.worktree({ body: { id: p.id, action: p.action } }))
    },
    async answer(p) {
      if (p.answers !== null && JSON.stringify(p.answers).length > PHONE_ANSWER_MAX_JSON) throw new BackendError('invalid')
      await api.matters.answer({ body: { id: p.id, runId: p.runId, requestId: p.requestId, answers: p.answers } })
    },
    async say(id, text, requestId, options) {
      if (text.length > PHONE_SAY_MAX_CHARS) throw new BackendError('invalid')
      // A reconnect checks the durable receipt. Only an explicit user retry replays the POST.
      return (await api.matters.say({ body: { id, text, requestId, ...(options?.runId ? { runId: options.runId } : {}), ...(options?.attachmentIds?.length && options.draftId ? { draftId: options.draftId, attachmentIds: options.attachmentIds } : {}) }, retry: false })).result
    },
    async entryModels(providerId, projectId) {
      return (await api.entry.models({ query: { providerId, projectId: projectId || undefined } })).catalog
    },
    async entryOptions() {
      return strip(await api.entry.options())
    },
    async create(p) {
      const body = {
        requestId: p.requestId, text: p.text,
        target: p.projectId ? { kind: 'project', projectId: p.projectId, ...(p.isolation ? { isolation: 'worktree', ...(p.base ? { base: p.base } : {}) } : {}) } : { kind: 'managed' },
        ...(p.providerId ? { providerId: p.providerId } : {}),
        ...(p.attachmentIds?.length && p.draftId ? { draftId: p.draftId, attachmentIds: p.attachmentIds } : {}),
        ...(p.execution && (p.execution.model || p.execution.reasoningEffort) ? { execution: { ...(p.execution.model ? { model: p.execution.model } : {}), ...(p.execution.reasoningEffort ? { reasoningEffort: p.execution.reasoningEffort } : {}) } } : {}),
        // 做到条件成立为止(10-20):只跟独立工作区一起带;daemon 没开独立工作区会回 until_requires_worktree
        ...(p.until && p.projectId && p.isolation ? { until: { command: p.until.command, maxRounds: p.until.maxRounds } } : {}),
      }
      try {
        const r = await api.matters.create({ body, retry: true })
        return { matterId: r.receipt.matterId }
      } catch (e) {
        if (!(e instanceof BackendError) || e.code !== 'timeout') throw e
        // 超时不等于没收到:按 requestId 查一次回执,查到就当成功。
        try {
          const r = await api.matters.createReceipt({ query: { requestId: p.requestId } })
          return { matterId: r.receipt.matterId }
        } catch (e2) {
          // 查回执时发现被撤销:如实报 revoked,别让原来的超时盖掉。
          if (e2 instanceof BackendError && e2.code === 'revoked') throw e2
          throw e
        }
      }
    },
    async devices() {
      return (await api.set.state()).remote.devices
    },
    async renameDevice(label) {
      const me = (await backend.devices()).find(x => x.current)
      if (!me) throw new BackendError('unknown')
      await api.set.apply({ body: { op: 'label_device', id: me.id, label } })
    },
    async registerPush(platform, token) {
      await api.push.register({ body: { platform, token } })
    },
    async testPush() {
      return (await api.push.test({ body: {} })).result
    },
    async unpair() {
      await api.set.apply({ body: { op: 'unpair_self' } })
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

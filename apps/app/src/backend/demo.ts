import { PHONE_SAY_MAX_CHARS } from '@wechat-cc/protocol'
import { labelJoin, type Lang } from '../i18n'
import { DEMO_STICKER, DEMO_STICKER_FILE, DEMO_VOICE } from './demo-media'
import { BackendError, type Backend, type Connection, type MatterT, type MatterDetailT, type ApprovalExplanationT, type ChatJobT, type ChatMessageT, type SessionContinueT, type MatterSayResultT } from './types'
import {
  copy, IDS, CHAT_ID, PERM_ID, QUESTION_ID, RUN_IDS, t, explanation, progress, changesTurn, entryOptions,
  demoConnections, demoSessions, demoSessionMessages, demoSessionTitleKey, DEMO_SESSION_MESSAGES, type Stage,
} from './demo-data'

type Topic = 'home' | 'approvals' | 'agents' | `matter/${string}`
type Copy = keyof typeof copy
/** 事件记录:带 key 的在读时按请求的语言生成文案;text 是用户自己的字,原样保留。 */
type EvRec = { kind: string; createdAt: number; key?: Copy; extra?: string; text?: string }
type Entry = { detail: MatterDetailT; stage: Stage; version: number; evs: EvRec[]; seeded: boolean; titleKey?: Copy }
const DAY = 86_400_000
const HOUR = 3_600_000
/** 主人对话里的一条:key 的在读时按语言出文案;text 是用户自己的字。 */
type ChatRec = { id: string; role: 'me' | 'cc'; key?: Copy; text?: string; at: number; source: ChatMessageT['source']; narr?: Copy[]; atts?: DemoAtt[] }
/** 演示回复的附件:文案按语言生成;表情有 file ⇒ 走 sticker() 取图,没有 ⇒ 联网表情只写情绪。 */
type DemoAtt = { kind: 'voice'; key: Copy } | { kind: 'sticker'; label: Copy; file?: string } | { kind: 'file'; name: string }

/** 演示里 CC 回一句要多久:「在想…」留得够久,主人看得见,模拟器 UI 测试(一次点击 2 秒多)也看得见。 */
export const DEMO_CHAT_REPLY_MS = 5000

export function makeDemoBackend(opts: { now?: () => number; setTimeout?: typeof setTimeout; lang?: Lang } = {}): Backend & { reset(): void } {
  const now = opts.now ?? (() => Date.now())
  let lastLang: Lang = opts.lang ?? 'en' // 主题快照(approvals 摘要、agents 标题)用最近一次读的语言;读本身按参数给文案
  const schedule = (fn: () => void, ms: number) => (opts.setTimeout ?? globalThis.setTimeout)(fn, ms)

  let entries = new Map<string, Entry>()
  let order: string[] = []
  let epoch = 0 // reset() 之后让旧定时器失效
  let seq = 0
  let createdBy = new Map<string, string>()
  let saidBy = new Map<string, MatterSayResultT>()
  let deviceLabel = ''
  // 接着做(演示):会话 key → 接成的那件事
  let adopted = new Map<string, string>()
  // 交给另一位继续(演示):requestId → 新那件
  let handedBy = new Map<string, string>()
  // 主人那条对话(与 daemon 一致:说一句收下即回,回复落地后经 matter/<CHAT_ID> 主题唤醒)
  let chatMsgs: ChatRec[] = []
  let chatPending: ChatJobT | null = null
  let chatJobs = new Map<string, ChatJobT>()
  const subs = new Map<Topic, Set<(d: any) => void>>()

  function mkMatter(id: string, kind: MatterT['kind'], title: string, status: MatterT['status'], path: string | null, ts: number): MatterT {
    return { id, kind, title, projectPath: path, status, ownerChatId: null, originMatterId: null, originMessageId: null, createdAt: ts, updatedAt: ts }
  }
  function mkDetail(m: MatterT, task: MatterDetailT['task'], extra: Partial<MatterDetailT> = {}): MatterDetailT {
    return { matter: m, bindings: [], sessions: [], task, events: [], permissions: [], questions: [], artifacts: [], inputs: [], ...extra }
  }
  const taskOf = (id: string, title: string, path: string, phase: string, ts: number) =>
    ({ id, title, status: phase === 'working' ? 'running' : 'completed', phase, providerId: 'claude', path, error: null, updatedAt: ts })

  const tripQuestion = (l: Lang, createdAt: number): MatterDetailT['questions'][number] => ({
    id: QUESTION_ID, taskId: IDS.trip, createdAt,
    questions: [{
      id: 'depart', header: t(l, 'qHeader'), question: t(l, 'qText'),
      options: [{ label: t(l, 'optMon'), description: '' }, { label: t(l, 'optTue'), description: '' }],
      multiSelect: false, allowOther: true,
    }],
  })

  function buildSeed(): { map: Map<string, Entry>; ids: string[] } {
    const map = new Map<string, Entry>(); const ids: string[] = []
    const n = now()
    const add = (d: MatterDetailT, stage: Stage, evs: EvRec[] = [], titleKey?: Copy) => {
      const e: Entry = { detail: d, stage, version: 1, evs, seeded: true, titleKey }
      map.set(d.matter.id, e); ids.push(d.matter.id)
    }
    const pTitle = t(lastLang, 'portfolioTitle')
    add(mkDetail(mkMatter(IDS.portfolio, 'task', pTitle, 'open', '~/Projects/portfolio', n - 600_000),
      taskOf(IDS.portfolio, pTitle, '~/Projects/portfolio', 'working', n - 60_000), {
        runId: RUN_IDS[IDS.portfolio], inputMode: 'steer',
        permissions: [{ id: PERM_ID, taskId: IDS.portfolio, tool: 'Bash', description: 'npm install sharp', createdAt: n - 60_000 }],
      }), 'pending', [
      { kind: 'tool_call', key: 'ev1', createdAt: n - 500_000 },
      { kind: 'tool_call', key: 'ev2', createdAt: n - 300_000 },
    ], 'portfolioTitle')
    const tTitle = t(lastLang, 'tripTitle')
    add(mkDetail(mkMatter(IDS.trip, 'task', tTitle, 'open', '~/Projects/trip', n - 400_000),
      taskOf(IDS.trip, tTitle, '~/Projects/trip', 'working', n - 30_000), {
        runId: RUN_IDS[IDS.trip], inputMode: 'steer',
        questions: [tripQuestion(lastLang, n - 30_000)],
      }), 'ask', [{ kind: 'tool_call', key: 'stepTrip1', createdAt: n - 200_000 }], 'tripTitle')
    const nTitle = t(lastLang, 'notesTitle')
    add(mkDetail(mkMatter(IDS.notes, 'task', nTitle, 'replied', '~/Projects/notes', n - DAY),
      taskOf(IDS.notes, nTitle, '~/Projects/notes', 'replied', n - DAY)), 'replied', [], 'notesTitle')
    // 额度用完的一件(spec continue-sessions §7-3):Claude Code 没做完,电脑说可以交给 Codex 继续
    const rTitle = t(lastLang, 'reportTitle')
    add(mkDetail(mkMatter(IDS.report, 'task', rTitle, 'done', '~/Projects/notes', n - 2 * HOUR),
      { id: IDS.report, title: rTitle, status: 'failed', phase: 'failed', providerId: 'claude', path: '~/Projects/notes', error: 'provider_quota_exhausted', updatedAt: n - 2 * HOUR }, {
        quotaHandoff: { state: 'offer', from: 'claude', to: 'codex', kind: 'quota', resetAt: n + 40 * 60_000 },
      }), 'replied', [
      { kind: 'tool_call', key: 'stepReport1', createdAt: n - 2 * HOUR - 60_000 },
      { kind: 'error', key: 'evQuota', createdAt: n - 2 * HOUR },
    ], 'reportTitle')
    // 主人和 CC 的那条对话:也是一件 chat matter(daemon 的 /m/api/matters 也会列它),内容走 chat()。
    add(mkDetail({ ...mkMatter(CHAT_ID, 'chat', t(lastLang, 'chatTitle'), 'open', null, n - HOUR), ownerChatId: 'demo-owner' }, null), 'replied', [], 'chatTitle')
    return { map, ids }
  }
  function seedChat() {
    const n = now()
    chatMsgs = [
      { id: 'demo-chat-1', role: 'cc', key: 'chatSeed1', at: n - 3 * HOUR, source: 'wechat' },
      { id: 'demo-chat-2', role: 'me', key: 'chatSeed2', at: n - 3 * HOUR + 120_000, source: 'wechat' },
      { id: 'demo-chat-3', role: 'cc', key: 'chatSeed3', at: n - 2 * HOUR, source: 'desktop', atts: [{ kind: 'file', name: 'portfolio-notes.md' }] },
      { id: 'demo-chat-4', role: 'me', key: 'chatSeed4', at: n - HOUR, source: 'phone' },
    ]
    chatPending = null
    chatJobs = new Map()
  }
  function seed() { const b = buildSeed(); entries = b.map; order = b.ids; seedChat() }
  const chatText = (m: ChatRec, l: Lang) => (m.key ? t(l, m.key) : m.text ?? '')
  const chatExtras = (m: ChatRec, l: Lang): Pick<ChatMessageT, 'attachments' | 'narration'> => ({
    ...(m.narr?.length ? { narration: m.narr.map(k => t(l, k)) } : {}),
    ...(m.atts?.length ? { attachments: m.atts.map(a => a.kind === 'voice' ? { kind: 'voice' as const, text: t(l, a.key) } : a.kind === 'sticker' ? { kind: 'sticker' as const, label: t(l, a.label), ...(a.file ? { file: a.file } : {}) } : a) } : {}),
  })
  const titleOf = (e: Entry, l: Lang) => (e.titleKey ? t(l, e.titleKey) : e.detail.matter.title)
  /** 读时按请求的语言出一份拷贝:标题、事件、未处理的种子问题都换成 l。状态(已批准 / 已回答 / 阶段)在 e 里,不因语言变。 */
  function localize(e: Entry, l: Lang): MatterDetailT {
    const d = structuredClone(e.detail)
    d.inputs.reverse() // match daemon's recent receipt list (newest first)
    d.events = e.evs.map(r => ({ kind: r.kind, createdAt: r.createdAt, text: r.key ? t(l, r.key) + (r.extra ?? '') : (r.text ?? '') }))
    const title = titleOf(e, l)
    d.matter.title = title
    if (d.task) d.task.title = title
    d.questions = d.questions.map(q => (q.id === QUESTION_ID ? tripQuestion(l, q.createdAt) : q))
    if (d.matter.id === CHAT_ID) d.events = chatMsgs.map(m => ({ kind: m.role === 'me' ? 'user' : 'text', createdAt: m.at, text: chatText(m, l) }))
    return d
  }
  /** 读的语言变了 ⇒ 记下,并在当前调用之后把非 matter 主题按新语言补推一次。 */
  function noteLang(l: Lang) {
    if (l === lastLang) return
    lastLang = l
    queueMicrotask(() => publish([]))
  }
  seed()

  // ---- 快照与订阅 ----
  const list = () => order.map(id => entries.get(id)!)
  const phaseOf = (e: Entry) => e.detail.task?.phase ?? (e.detail.matter.status === 'replied' ? 'replied' : 'working')
  function snapshot(topic: Topic): unknown {
    if (topic === 'approvals') {
      return list().flatMap(e => [
        ...e.detail.permissions.map(p => ({ taskId: e.detail.matter.id, kind: 'permission' as const, id: p.id, summary: `${p.tool}: ${p.description}`.slice(0, 80) })),
        ...e.detail.questions.map(q => {
          const first = (q.id === QUESTION_ID ? tripQuestion(lastLang, q.createdAt) : q).questions[0]
          return { taskId: e.detail.matter.id, kind: 'question' as const, id: q.id, summary: labelJoin(first?.header ?? '', first?.question ?? '').slice(0, 80) }
        }),
      ])
    }
    if (topic === 'agents') {
      const tasks = list().filter(e => e.detail.task).map(e => ({ id: e.detail.matter.id, title: titleOf(e, lastLang), phase: phaseOf(e) }))
      const waiting = list().filter(e => e.detail.permissions.length + e.detail.questions.length > 0).length
      return { running: tasks.filter(x => x.phase === 'working').length, waiting, tasks }
    }
    if (topic === 'home') {
      const unread = list().reduce((s, e) => s + e.detail.permissions.length + e.detail.questions.length, 0)
      return { unread, presenceState: { level: 'ok', activity: unread > 0 ? 'waiting' : 'idle' }, nextCursor: null }
    }
    const id = topic.slice('matter/'.length)
    const e = entries.get(id)
    if (e && id === CHAT_ID) return { found: true, kind: 'chat', version: e.version, phase: chatPending ? 'working' : e.detail.matter.status }
    return e ? { found: true, kind: e.detail.matter.kind, version: e.version, phase: phaseOf(e) } : { found: false }
  }
  function publish(ids: string[]) {
    for (const id of ids) { const e = entries.get(id); if (e) e.version++ }
    for (const [topic, set] of subs) {
      if (topic.startsWith('matter/') && !ids.includes(topic.slice(7))) continue
      for (const cb of [...set]) cb(snapshot(topic))
    }
  }
  function touch(e: Entry, patch: { phase?: string; status?: MatterT['status'] }) {
    const ts = now()
    e.detail.matter = { ...e.detail.matter, updatedAt: ts, ...(patch.status ? { status: patch.status } : {}) }
    if (e.detail.task) {
      const phase = patch.phase ?? e.detail.task.phase
      e.detail.task = { ...e.detail.task, updatedAt: ts, phase, status: phase === 'working' ? 'running' : 'completed' }
    }
  }
  const later = (ms: number, fn: () => void) => { const ep = epoch; schedule(() => { if (ep === epoch) fn() }, ms) }
  const ev = (e: Entry, kind: string, key: Copy, extra?: string) => { e.evs = [...e.evs, { kind, key, extra, createdAt: now() }] }
  const evText = (e: Entry, kind: string, text: string) => { e.evs = [...e.evs, { kind, text, createdAt: now() }] }
  const get = (id: string) => { const e = entries.get(id); if (!e) throw new BackendError('not_found'); return e }

  /** 演示里三条会话能不能接:进行中的那条看得见在跑;另两条一条能恢复、一条只能带记录新开。 */
  const DEMO_CONTINUE: Record<string, { state: SessionContinueT['state']; mode: SessionContinueT['mode'] }> = {
    'demo-claude-1': { state: 'busy_session', mode: null },
    'demo-claude-2': { state: 'ready', mode: 'native_resume' },
    'demo-codex-1': { state: 'ready', mode: 'fresh_context' },
  }
  const sessionRow = (key: string) => { const row = demoSessions(lastLang, now()).find(r => r.key === key); if (!row) throw new BackendError('not_found'); return row }

  const conn: Connection = { state: 'online', lastSyncedAt: null, epoch: 0 }

  return {
    mode: 'demo',
    connection: () => ({ ...conn, lastSyncedAt: now() }),
    onConnection: cb => { cb({ ...conn, lastSyncedAt: now() }); return () => {} },
    subscribe(topic, cb) {
      let set = subs.get(topic as Topic)
      if (!set) subs.set(topic as Topic, (set = new Set()))
      set.add(cb)
      cb(snapshot(topic as Topic) as never)
      return () => { set!.delete(cb) }
    },
    async matters(l) { noteLang(l); return list().map(e => localize(e, l).matter).sort((a, b) => b.updatedAt - a.updatedAt) },
    async matter(id, l) { noteLang(l); return localize(get(id), l) },
    async matterInputReceipt(id, requestId) { return get(id).detail.inputs.find(row => row.id === requestId) ?? null },
    async insight(id, l) {
      noteLang(l)
      const e = get(id)
      const explanations: Record<string, ApprovalExplanationT> = e.detail.permissions.some(p => p.id === PERM_ID) ? { [PERM_ID]: explanation(l) } : {}
      return { explanations, progress: progress(l, id, e.stage) }
    },
    async changes(id) { get(id); return id === IDS.portfolio ? changesTurn(now()) : null },
    async chat(_p) {
      const l = lastLang
      return {
        matterId: CHAT_ID, title: t(l, 'chatTitle'), hasMore: false, nextBefore: null, failed: null,
        pending: chatPending ? { ...chatPending } : null,
        messages: chatMsgs.map(m => ({ id: m.id, role: m.role, kind: 'text', text: chatText(m, l), truncated: false, at: m.at, source: m.source, ...chatExtras(m, l) })),
      }
    },
    async chatSay(text, requestId) {
      // 与 daemon 一致:同一 requestId ⇒ 回原来那张回执,不说两遍;上一句还在等 ⇒ busy。
      const seen = chatJobs.get(requestId)
      if (seen) return { ...seen }
      if (!text.trim() || text.length > PHONE_SAY_MAX_CHARS) throw new BackendError('invalid')
      if (chatPending) throw new BackendError('busy')
      const job: ChatJobT = { requestId, text, status: 'pending', since: now() }
      chatJobs.set(requestId, job); chatPending = job
      publish([CHAT_ID])
      later(DEMO_CHAT_REPLY_MS, () => {
        const ts = now()
        chatMsgs.push(
          { id: `demo-${requestId}-in`, role: 'me', text, at: ts, source: 'phone' },
          {
            id: `demo-${requestId}-out`, role: 'cc', key: 'chatDemoReply', at: ts + 1, source: 'phone',
            narr: ['chatDemoNarr1', 'chatDemoNarr2'],
            atts: [{ kind: 'voice', key: 'chatDemoVoice' }, { kind: 'sticker', label: 'chatDemoSticker', file: DEMO_STICKER_FILE }, { kind: 'sticker', label: 'chatDemoSticker2' }],
          },
        )
        job.status = 'replied'; chatPending = null
        const e = entries.get(CHAT_ID)
        if (e) touch(e, {})
        publish([CHAT_ID])
      })
      return { ...job }
    },
    async chatVoice(messageId, index) {
      const a = chatMsgs.find(m => m.id === messageId)?.atts?.[index]
      if (!a || a.kind !== 'voice') throw new BackendError('not_found')
      return { ...DEMO_VOICE }
    },
    async sticker(file) {
      if (file !== DEMO_STICKER_FILE) throw new BackendError('not_found')
      return { ...DEMO_STICKER }
    },
    async connections() { return demoConnections(lastLang, now()) },
    async sessions(provider, _cursor, q) {
      if (q !== undefined && (q.length > 200 || q.includes('\0'))) throw new BackendError('invalid')
      const needle = q?.trim().toLowerCase() ?? ''
      return { items: demoSessions(lastLang, now(), provider).filter(row => !needle || `${row.title}\n${row.project ?? ''}`.toLowerCase().includes(needle)), nextCursor: null }
    },
    async session(key, cursor, window = 'start') {
      if (window === 'recent' && cursor !== undefined) throw new BackendError('invalid')
      const row = demoSessions(lastLang, now()).find(r => r.key === key)
      if (!row) throw new BackendError('not_found')
      const messages = demoSessionMessages(lastLang)
      return { session: row, managed: adopted.has(key), window, nextCursor: null, messages: window === 'recent' ? messages.slice(-20) : messages }
    },
    async continuePreview(key) {
      const row = sessionRow(key), matterId = adopted.get(key) ?? null
      if (matterId) return { state: 'managed', provider: row.provider, project: row.project, mode: null, matterId }
      const c = DEMO_CONTINUE[key] ?? { state: 'empty' as const, mode: null }
      return { state: c.state, provider: row.provider, project: row.project, mode: c.mode, matterId: null }
    },
    async continueSession(key) {
      const dup = adopted.get(key)
      if (dup) return { matterId: dup }
      const row = sessionRow(key), c = DEMO_CONTINUE[key]
      if (!c || c.state !== 'ready' || !c.mode) throw new BackendError(c?.state === 'busy_session' ? 'session_busy' : 'unknown')
      const matterId = `demo${(++seq).toString(16).padStart(4, '0')}`
      adopted.set(key, matterId)
      const ts = now(), path = `~/Projects/${row.project ?? 'demo'}`
      const e: Entry = {
        stage: 'replied', version: 1, seeded: false, titleKey: demoSessionTitleKey(key),
        // 导入的原记录:与 daemon 一致,user ⇒ user、assistant ⇒ text;存文案键,读时按语言出
        evs: DEMO_SESSION_MESSAGES.map((m, i) => ({ kind: m.role === 'user' ? 'user' : 'text', key: m.key, createdAt: ts - 1000 + i })),
        detail: mkDetail(mkMatter(matterId, 'task', row.title, 'open', path, ts),
          { id: matterId, title: row.title, status: 'interrupted', providerId: row.provider, path, error: null, updatedAt: ts },
          { nativeStart: { mode: c.mode, providerId: row.provider } }),
      }
      entries.set(matterId, e); order.unshift(matterId); publish([matterId])
      return { matterId }
    },
    async handoff({ id, requestId, providerId }) {
      // 与 daemon 一致:同一 requestId ⇒ 同一件;已经交出去 ⇒ 回那一件;确认卡上的人不是此刻的接手人 ⇒ handoff_changed。
      const dup = handedBy.get(requestId)
      if (dup) return { matterId: dup }
      const src = get(id), h = src.detail.quotaHandoff
      if (h?.state === 'handed') return { matterId: h.matterId }
      if (h?.state !== 'offer' || h.to !== providerId || !src.detail.task) throw new BackendError('handoff_changed')
      const matterId = `demo${(++seq).toString(16).padStart(4, '0')}`
      handedBy.set(requestId, matterId)
      const ts = now(), task = src.detail.task
      const e: Entry = {
        stage: 'working', version: 1, seeded: false, titleKey: src.titleKey,
        evs: [{ kind: 'user', key: 'handoffFirst', createdAt: ts }],
        detail: mkDetail({ ...mkMatter(matterId, 'task', src.detail.matter.title, 'open', src.detail.matter.projectPath, ts), originMatterId: id },
          { ...taskOf(matterId, task.title, task.path, 'working', ts), providerId: h.to }),
      }
      entries.set(matterId, e); order.unshift(matterId)
      src.detail.quotaHandoff = { state: 'handed', from: h.from, to: h.to, matterId }
      touch(src, {}); publish([id, matterId])
      later(2000, () => { ev(e, 'text', 'handoffDone'); e.stage = 'replied'; touch(e, { phase: 'replied', status: 'replied' }); publish([matterId]) })
      return { matterId }
    },
    async decide({ id, requestId, decision }) {
      const e = get(id)
      if (!e.detail.permissions.some(p => p.id === requestId)) throw new BackendError('stale')
      e.detail.permissions = e.detail.permissions.filter(p => p.id !== requestId)
      if (decision === 'allow') {
        ev(e, 'tool_call', 'evAllowed'); e.stage = 'working'; touch(e, { phase: 'working' }); publish([id])
        later(2000, () => { ev(e, 'tool_call', 'evDone'); e.stage = 'replied'; touch(e, { phase: 'replied', status: 'replied' }); publish([id]) })
      } else {
        ev(e, 'tool_call', 'evDenied'); e.stage = 'denied'; touch(e, { phase: 'replied', status: 'replied' }); publish([id])
      }
    },
    async stop({ id, runId }) {
      const e = entries.get(id)
      if (!e || e.detail.runId !== runId) throw new BackendError('input_stale')
      ev(e, 'text', 'stopped'); e.stage = 'replied'; touch(e, { phase: 'cancelled', status: 'replied' }); delete e.detail.runId; publish([id])
    },
    async answer({ id, requestId, answers }) {
      const e = get(id)
      const req = e.detail.questions.find(q => q.id === requestId)
      if (!req) throw new BackendError('stale')
      // 与 daemon validateUserInputAnswers 同样严格:每题 string[],单选 1 个、多选 1–8 个不重复、每条非空且 ≤ 4000 字。
      if (answers !== null) {
        const ok = Object.keys(answers).length === req.questions.length && req.questions.every(q => {
          const a = answers[q.id]
          return Array.isArray(a) && a.length >= 1 && a.length <= (q.multiSelect ? 8 : 1) && new Set(a).size === a.length
            && a.every(x => typeof x === 'string' && x.trim() !== '' && x.length <= 4000 && (q.allowOther || q.options.some(o => o.label === x)))
        })
        if (!ok) throw new BackendError('unknown')
      }
      e.detail.questions = e.detail.questions.filter(q => q.id !== requestId)
      const text = answers ? Object.values(answers).map(v => v.join(', ')).join('; ') : ''
      ev(e, 'tool_call', 'evAnswered', text); e.stage = 'answered'; touch(e, { phase: 'working' }); publish([id])
      later(2000, () => { e.stage = 'replied'; touch(e, { phase: 'replied', status: 'replied' }); publish([id]) })
    },
    async say(id, text, requestId, options) {
      const e = get(id)
      // 与 daemon 一致:同一个 requestId 重发 ⇒ 当作已收到,不重复记。
      const prior = saidBy.get(requestId)
      if (prior) {
        if (prior.kind === 'task' && prior.input && (prior.input.taskId !== id || prior.input.text !== text || options?.runId && prior.input.runId !== options.runId)) throw new BackendError('input_conflict')
        return prior
      }
      if (options?.runId && options.runId !== e.detail.runId) throw new BackendError('input_stale')
      evText(e, 'user', text)
      // 接过来的那件事:第一句一发,「第一句会怎样」的说明就该消失,执行者开始跑(与 daemon 一致);回话后这一轮结束
      const started = !!e.detail.nativeStart
      if (started) { const { nativeStart: _sent, ...rest } = e.detail; e.detail = rest; touch(e, { phase: 'working' }) }
      else touch(e, {})
      const result: MatterSayResultT = e.detail.task ? {
        kind: 'task', task: e.detail.task,
        input: { id: requestId, taskId: id, runId: options?.runId ?? e.detail.runId ?? `run-${id}`, text, status: e.detail.inputMode === 'queue' ? 'pending' : 'sending' },
      } : { kind: 'chat', reply: t(lastLang, 'ccReply') }
      if (result.kind === 'task' && result.input) e.detail = { ...e.detail, inputs: [...e.detail.inputs, result.input] }
      saidBy.set(requestId, result)
      publish([id])
      later(2000, () => {
        if (result.kind === 'task' && result.input) result.input.status = 'delivered'
        ev(e, 'text', 'ccReply'); touch(e, started ? { phase: 'replied' } : {}); publish([id])
      })
      return result
    },
    async entryOptions(l) { noteLang(l); return entryOptions(l) },
    async create({ requestId, text, projectId }) {
      const dup = createdBy.get(requestId)
      if (dup) return { matterId: dup }
      const projectPath = projectId ? entryOptions(lastLang).projects.find(p => p.id === projectId)?.path ?? null : null
      const matterId = `demo${(++seq).toString(16).padStart(4, '0')}`
      createdBy.set(requestId, matterId)
      const ts = now()
      const title = text.trim().slice(0, 40) || text
      const e: Entry = {
        stage: 'working', version: 1, seeded: false,
        evs: [{ kind: 'user', text, createdAt: ts }, { kind: 'tool_call', key: 'creating', createdAt: ts }],
        detail: mkDetail(mkMatter(matterId, 'task', title, 'open', projectPath ?? null, ts),
          taskOf(matterId, title, projectPath ?? '~/Projects/portfolio', 'working', ts),
          { runId: `run-${matterId}`, inputMode: 'steer' }),
      }
      entries.set(matterId, e); order.unshift(matterId); publish([matterId])
      later(2000, () => { ev(e, 'text', 'created'); e.stage = 'replied'; touch(e, { phase: 'replied', status: 'replied' }); publish([matterId]) })
      return { matterId }
    },
    async devices() {
      const at = new Date(now()).toISOString()
      return [{ id: 'demo0001', created_at: at, last_seen_at: at, ...(deviceLabel ? { label: deviceLabel } : {}), current: true }]
    },
    async renameDevice(label) { deviceLabel = label.trim().slice(0, 24) },
    async registerPush() {},
    async testPush() { return { ok: false, code: 'demo' } },
    async unpair() {},
    setActive() {},
    dispose() {},
    reset() { epoch++; seq = 0; createdBy = new Map(); saidBy = new Map(); adopted = new Map(); handedBy = new Map(); deviceLabel = ''; seed(); publish([...order]) },
  }
}

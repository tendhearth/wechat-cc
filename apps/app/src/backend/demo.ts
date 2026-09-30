import type { Lang } from '../i18n'
import { BackendError, type Backend, type Connection, type MatterT, type MatterDetailT, type ApprovalExplanationT } from './types'
import { copy, IDS, PERM_ID, QUESTION_ID, RUN_IDS, t, explanation, progress, changesTurn, entryOptions, type Stage } from './demo-data'

type Topic = 'home' | 'approvals' | 'agents' | `matter/${string}`
type Copy = keyof typeof copy
/** 事件记录:带 key 的在换语言时按新语言重新生成文案;text 是用户自己的字,原样保留。 */
type EvRec = { kind: string; createdAt: number; key?: Copy; extra?: string; text?: string }
type Entry = { detail: MatterDetailT; stage: Stage; version: number; evs: EvRec[]; seeded: boolean }
const DAY = 86_400_000

export function makeDemoBackend(opts: { now?: () => number; setTimeout?: typeof setTimeout; lang?: Lang } = {}): Backend & { reset(): void; setLang(l: Lang, o?: { silent?: boolean }): void; republish(): void } {
  const now = opts.now ?? (() => Date.now())
  let lang: Lang = opts.lang ?? 'en' // setLang 只改之后生成的文案,不动已有状态
  const schedule = (fn: () => void, ms: number) => (opts.setTimeout ?? globalThis.setTimeout)(fn, ms)

  let entries = new Map<string, Entry>()
  let order: string[] = []
  let epoch = 0 // reset() 之后让旧定时器失效
  let seq = 0
  const subs = new Map<Topic, Set<(d: any) => void>>()

  function mkMatter(id: string, kind: MatterT['kind'], title: string, status: MatterT['status'], path: string | null, ts: number): MatterT {
    return { id, kind, title, projectPath: path, status, ownerChatId: null, originMatterId: null, originMessageId: null, createdAt: ts, updatedAt: ts }
  }
  function mkDetail(m: MatterT, task: MatterDetailT['task'], extra: Partial<MatterDetailT> = {}): MatterDetailT {
    return { matter: m, bindings: [], sessions: [], task, events: [], permissions: [], questions: [], artifacts: [], inputs: [], ...extra }
  }
  const taskOf = (id: string, title: string, path: string, phase: string, ts: number) =>
    ({ id, title, status: phase === 'working' ? 'running' : 'completed', phase, providerId: 'claude', path, error: null, updatedAt: ts })

  function buildSeed(): { map: Map<string, Entry>; ids: string[] } {
    const map = new Map<string, Entry>(); const ids: string[] = []
    const n = now()
    const add = (d: MatterDetailT, stage: Stage, evs: EvRec[] = []) => {
      const e: Entry = { detail: d, stage, version: 1, evs, seeded: true }
      renderEvents(e); map.set(d.matter.id, e); ids.push(d.matter.id)
    }
    const pTitle = t(lang, 'portfolioTitle')
    add(mkDetail(mkMatter(IDS.portfolio, 'task', pTitle, 'open', '~/Projects/portfolio', n - 600_000),
      taskOf(IDS.portfolio, pTitle, '~/Projects/portfolio', 'working', n - 60_000), {
        runId: RUN_IDS[IDS.portfolio], inputMode: 'steer',
        permissions: [{ id: PERM_ID, taskId: IDS.portfolio, tool: 'Bash', description: 'npm install sharp', createdAt: n - 60_000 }],
      }), 'pending', [
      { kind: 'progress', key: 'ev1', createdAt: n - 500_000 },
      { kind: 'progress', key: 'ev2', createdAt: n - 300_000 },
    ])
    const tTitle = t(lang, 'tripTitle')
    add(mkDetail(mkMatter(IDS.trip, 'task', tTitle, 'open', '~/Projects/trip', n - 400_000),
      taskOf(IDS.trip, tTitle, '~/Projects/trip', 'working', n - 30_000), {
        runId: RUN_IDS[IDS.trip], inputMode: 'steer',
        questions: [{
          id: QUESTION_ID, taskId: IDS.trip, createdAt: n - 30_000,
          questions: [{
            id: 'depart', header: t(lang, 'qHeader'), question: t(lang, 'qText'),
            options: [{ label: t(lang, 'optMon'), description: '' }, { label: t(lang, 'optTue'), description: '' }],
            multiSelect: false, allowOther: true,
          }],
        }],
      }), 'ask', [{ kind: 'progress', key: 'stepTrip1', createdAt: n - 200_000 }])
    add(mkDetail(mkMatter(IDS.notes, 'chat', t(lang, 'notesTitle'), 'replied', null, n - DAY), null), 'replied')
    return { map, ids }
  }
  function seed() { const b = buildSeed(); entries = b.map; order = b.ids }
  function renderEvents(e: Entry) {
    e.detail.events = e.evs.map(r => ({ kind: r.kind, createdAt: r.createdAt, text: r.key ? t(lang, r.key) + (r.extra ?? '') : (r.text ?? '') }))
  }
  seed()

  // ---- 快照与订阅 ----
  const list = () => order.map(id => entries.get(id)!)
  const phaseOf = (e: Entry) => e.detail.task?.phase ?? (e.detail.matter.status === 'replied' ? 'replied' : 'working')
  function snapshot(topic: Topic): unknown {
    if (topic === 'approvals') {
      return list().flatMap(e => [
        ...e.detail.permissions.map(p => ({ taskId: e.detail.matter.id, kind: 'permission' as const, id: p.id, summary: `${p.tool}: ${p.description}`.slice(0, 80) })),
        ...e.detail.questions.map(q => ({ taskId: e.detail.matter.id, kind: 'question' as const, id: q.id, summary: `${q.questions[0]?.header ?? ''}: ${q.questions[0]?.question ?? ''}`.slice(0, 80) })),
      ])
    }
    if (topic === 'agents') {
      const tasks = list().filter(e => e.detail.task).map(e => ({ id: e.detail.matter.id, title: e.detail.matter.title, phase: phaseOf(e) }))
      const waiting = list().filter(e => e.detail.permissions.length + e.detail.questions.length > 0).length
      return { running: tasks.filter(x => x.phase === 'working').length, waiting, tasks }
    }
    if (topic === 'home') {
      const unread = list().reduce((s, e) => s + e.detail.permissions.length + e.detail.questions.length, 0)
      return { unread, presenceState: { level: 'present', activity: unread > 0 ? 'waiting' : 'idle' }, nextCursor: null }
    }
    const e = entries.get(topic.slice('matter/'.length))
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
  const ev = (e: Entry, kind: string, key: Copy, extra?: string) => { e.evs = [...e.evs, { kind, key, extra, createdAt: now() }]; renderEvents(e) }
  const evText = (e: Entry, kind: string, text: string) => { e.evs = [...e.evs, { kind, text, createdAt: now() }]; renderEvents(e) }
  const get = (id: string) => { const e = entries.get(id); if (!e) throw new BackendError('unknown'); return e }

  const conn: Connection = { state: 'online', lastSyncedAt: null }
  const clone = <T,>(v: T): T => structuredClone(v)

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
    async matters() { return list().map(e => clone(e.detail.matter)).sort((a, b) => b.updatedAt - a.updatedAt) },
    async matter(id) { return clone(get(id).detail) },
    async insight(id, l) {
      const e = get(id)
      const explanations: Record<string, ApprovalExplanationT> = e.detail.permissions.some(p => p.id === PERM_ID) ? { [PERM_ID]: explanation(l) } : {}
      return { explanations, progress: progress(l, id, e.stage) }
    },
    async changes(id) { get(id); return id === IDS.portfolio ? changesTurn(now()) : null },
    async decide({ id, requestId, decision }) {
      const e = get(id)
      if (!e.detail.permissions.some(p => p.id === requestId)) throw new BackendError('stale')
      e.detail.permissions = e.detail.permissions.filter(p => p.id !== requestId)
      if (decision === 'allow') {
        ev(e, 'progress', 'evAllowed'); e.stage = 'working'; touch(e, { phase: 'working' }); publish([id])
        later(2000, () => { ev(e, 'progress', 'evDone'); e.stage = 'replied'; touch(e, { phase: 'replied', status: 'replied' }); publish([id]) })
      } else {
        ev(e, 'progress', 'evDenied'); e.stage = 'denied'; touch(e, { phase: 'replied', status: 'replied' }); publish([id])
      }
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
      ev(e, 'progress', 'evAnswered', text); e.stage = 'answered'; touch(e, { phase: 'working' }); publish([id])
      later(2000, () => { e.stage = 'replied'; touch(e, { phase: 'replied', status: 'replied' }); publish([id]) })
    },
    async say(id, text) {
      const e = get(id)
      evText(e, 'user', text); touch(e, {}); publish([id])
      later(2000, () => { ev(e, 'assistant', 'ccReply'); touch(e, {}); publish([id]) })
    },
    async entryOptions() { return entryOptions(lang) },
    async create({ text, projectPath }) {
      const matterId = `demo${(++seq).toString(16).padStart(4, '0')}`
      const ts = now()
      const title = text.trim().slice(0, 40) || text
      const e: Entry = {
        stage: 'working', version: 1, seeded: false,
        evs: [{ kind: 'user', text, createdAt: ts }, { kind: 'progress', key: 'creating', createdAt: ts }],
        detail: mkDetail(mkMatter(matterId, 'task', title, 'open', projectPath ?? null, ts),
          taskOf(matterId, title, projectPath ?? '~/Projects/portfolio', 'working', ts),
          { runId: `run-${matterId}`, inputMode: 'steer' }),
      }
      renderEvents(e)
      entries.set(matterId, e); order.unshift(matterId); publish([matterId])
      later(2000, () => { ev(e, 'assistant', 'created'); e.stage = 'replied'; touch(e, { phase: 'replied', status: 'replied' }); publish([matterId]) })
      return { matterId }
    },
    setLang(l, o) {
      if (l === lang) return
      lang = l
      // 种子事项按新语言重建文案,再把状态(已决定的批准/已答的问题/阶段/追加事件)留在原处;用户自己创建的事项只重渲染带 key 的事件。
      const fresh = buildSeed().map
      for (const [id, e] of entries) {
        const f = fresh.get(id)
        if (e.seeded && f) {
          e.detail.matter = { ...e.detail.matter, title: f.detail.matter.title }
          if (e.detail.task) e.detail.task = { ...e.detail.task, title: f.detail.matter.title }
          const qIds = new Set(e.detail.questions.map(q => q.id))
          e.detail.questions = f.detail.questions.filter(q => qIds.has(q.id))
        }
        renderEvents(e)
      }
      if (!o?.silent) publish([...order])
    },
    republish() { publish([...order]) },
    reset() { epoch++; seq = 0; seed(); publish([...order]) },
  }
}

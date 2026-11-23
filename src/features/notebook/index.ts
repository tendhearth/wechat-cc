import type { DaemonModule, ModuleCtx } from '../../daemon/modules/container'
import type { InternalApiLifecycle } from '../../daemon/internal-api/lifecycle'
import { notebookRoutes } from './routes'
import { NOTEBOOK_JOT_PREFIX } from '@wechat-cc/protocol'
import {
  COMMENT_PROMPT, DEFAULT_OPENING, availableNotebookFonts, defaultOpening, penPrompt,
  parseComment, parseOpening, type NotebookEntry, type NotebookRow,
} from '../../domain/notebook'
import { NOTEBOOK_DEFAULTS, type NotebookConfig } from '../../lib/notebook-config'
import { localParts } from '../../lib/local-time'
import type { CheapEval, CheapEvalOptions } from '../../ports/agent-provider'
import type { Notebook, NotebookCaller, NotebookSettings, NotebookStore } from '../../ports/notebook'

// A valid 4,000-character entry can grow to 24,000 characters through JSON escaping.
const CHAT_READ_MAX_CHARS = 26_000
const CHAT_READ_BATCH = 32
const DAY_MS = 86_400_000
const MAX_MISSED_REPLY_IDS = 200
const EMPTY_INITIATIVE: NotebookSettings['initiative'] = { lastAt: 0, day: '', attempts: 0, failures: 0, retryAt: 0 }

interface NotebookDeps {
  store: NotebookStore
  settings: () => { timezone: string; notebook?: Partial<NotebookConfig> }
  model: () => CheapEval | null
  persona?: () => string
  isOwner?: (caller: NotebookCaller) => boolean
  now?: () => number
  log?: (count: number, length: number) => void
}

export function makeNotebook(deps: NotebookDeps): Notebook {
  const { store } = deps
  const now = deps.now ?? Date.now
  const settings = () => {
    const { timezone, notebook } = deps.settings()
    return { timezone, config: { ...NOTEBOOK_DEFAULTS, ...notebook } }
  }
  const append = (author: NotebookRow['author'], body: string, origin: NotebookRow['origin'], createdAt: number, clientId: string | null = null, refId: string | null = null) => {
    const entry = store.append({ author, body, origin, createdAt, clientId, refId })
    deps.log?.(1, Array.from(entry.body).length)
    return entry
  }
  function advanceReplyReadState(state: NotebookSettings['replyReadState'], ids: readonly string[]) {
    const replies = store.replyTimestamps(ids)
    const highWater = replies.reduce((latest, reply) => Math.max(latest, reply.createdAt), state.highWater)
    const missedIds = store.missedReplyIds(state.highWater, highWater, state.missedIds,
      replies.map(reply => reply.id), MAX_MISSED_REPLY_IDS)
    return { highWater, missedIds }
  }

  // Called inside the same transaction as the first read or confirmation.
  function replyReadState() {
    const saved = store.get('replyReadState')
    if (saved !== null) return saved
    const baseline = { highWater: store.get('repliesSeenAt') ?? now(), missedIds: [] }
    const legacyIds = store.get('repliesSeenIds') ?? []
    const state = legacyIds.length ? advanceReplyReadState(baseline, legacyIds) : baseline
    store.set('replyReadState', state)
    return state
  }

  let modelActive = false
  async function ask(model: CheapEval, prompt: string, timeoutMs: number, beforeRequest?: CheapEvalOptions['beforeRequest']) {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error('Notebook model timed out')
        controller.abort(error)
        reject(error)
      }, timeoutMs)
      timer.unref?.()
    })
    modelActive = true
    const request = (async () => model(prompt, { signal: controller.signal, beforeRequest }))().finally(() => { modelActive = false })
    try {
      const result = await Promise.race([request, deadline])
      controller.signal.throwIfAborted()
      return result
    } finally {
      clearTimeout(timer)
    }
  }

  function withReferenceDays(entries: NotebookEntry[], dayOf: (at: number) => string): NotebookEntry[] {
    const ids = new Set(entries.flatMap(entry => entry.refId === null ? [] : [entry.refId]))
    if (!ids.size) return entries
    const refDays = new Map(store.referenceTimestamps([...ids]).map(({ id, createdAt }) => [id, dayOf(createdAt)]))
    return entries.map(entry => {
      const refDay = entry.refId === null ? undefined : refDays.get(entry.refId)
      return refDay === undefined ? entry : { ...entry, refDay }
    })
  }

  let opening: Promise<void> | undefined
  function open(origin: 'desktop' | 'app', reportedFonts?: string) {
    if (opening || store.get('pen')) return opening
    const fonts = availableNotebookFonts(reportedFonts)
    const fallback = defaultOpening(fonts)
    // 只看有没有挑过笔,不看本子里有没有字:没翻开过时,对话里的「记一笔」可以先写进来,
    // 那不该让主人第一次翻开时既没有开场、笔也不是 CC 挑的。开场落在翻开的这一刻,排在早先那几笔之后。
    const openedAt = now()
    opening = Promise.resolve().then(async () => {
      let intro: ReturnType<typeof parseOpening> = fallback
      try {
        const model = deps.model()
        const persona = deps.persona?.()
        const basePrompt = penPrompt(fonts)
        const prompt = persona ? `${basePrompt}\nCC 的性格资料：${JSON.stringify(persona)}` : basePrompt
        if (model && !modelActive) intro = parseOpening(await ask(model, prompt, settings().config.openingTimeoutMs), fonts)
      } catch { /* 用固定开场。 */ }
      store.atomic(() => {
        if (store.get('pen')) return
        const { font, ink, reason } = intro
        store.set('pen', { font, ink, reason })
        // 写入可以在选笔期间完成;开场用翻开那一刻的时间,仍排在这些写入之前。
        for (const line of intro.lines) {
          append('cc', line, origin, openedAt)
        }
      })
    }).finally(() => { opening = undefined })
    return opening
  }

  let nextCheck = 0
  let checking = false
  async function tick() {
    const startedAt = now()
    if (checking || modelActive || startedAt < nextCheck) return
    const { timezone, config } = settings()
    nextCheck = startedAt + config.checkIntervalMs
    const day = localParts(startedAt, timezone).day
    const state = store.get('initiative') ?? EMPTY_INITIATIVE
    const attempts = state.day === day ? state.attempts : 0
    if (startedAt < state.retryAt || (state.lastAt && startedAt - state.lastAt < config.cooldownMs) || attempts >= config.dailyLimit) return
    const latestOwner = store.list({ ownerOnly: true, limit: 1 })[0]
    if (!latestOwner || startedAt - latestOwner.createdAt < config.quietMs) return
    const recent = store.list({ limit: 40 })
    const candidates = recent.filter(entry => entry.author === 'owner' && entry.createdAt > state.lastAt && entry.struckAt === null)
    if (!candidates.length) return
    const model = deps.model()
    if (!model) return
    checking = true
    let reservation = state
    try {
      const prompt = `${COMMENT_PROMPT}\n${JSON.stringify({
        candidateIds: candidates.map(entry => entry.id),
        entries: recent.filter(entry => entry.struckAt === null).map(({ id, author, body, createdAt }) =>
          ({ id, author, body, day: localParts(createdAt, timezone).day })),
      })}`
      const result = parseComment(await ask(model, prompt, config.timeoutMs, () => {
        const requestDay = localParts(now(), timezone).day
        const requestAttempts = state.day === requestDay ? state.attempts : 0
        if (requestAttempts >= config.dailyLimit) throw new Error('Notebook daily budget exhausted')
        const charged = { ...state, day: requestDay, attempts: requestAttempts + 1 }
        store.set('initiative', charged)
        reservation = charged
      }), candidates)
      store.atomic(() => {
        const finishedAt = now()
        const latest = store.list({ ownerOnly: true, limit: 1 })[0]
        const ref = result && store.byId(result.refId)
        const finishedDay = localParts(finishedAt, timezone).day
        // 宁可丢掉跨日的结果；该次调用属于发起的那一天。
        const saved = !!(result && ref && ref.struckAt === null && latest && finishedDay === reservation.day
          && finishedAt - latest.createdAt >= config.quietMs)
        if (saved) append('cc', result.body, 'desktop', finishedAt, null, result.refId)
        store.set('initiative', { ...reservation, lastAt: saved ? finishedAt : state.lastAt, failures: 0, retryAt: 0 })
      })
    } catch {
      const failures = state.failures + 1
      const delay = Math.min(config.failureMaxMs, config.failureBaseMs * 2 ** Math.min(30, failures - 1))
      store.set('initiative', { ...reservation, failures, retryAt: now() + delay })
    } finally {
      checking = false
    }
  }

  return {
    open,
    page(day?: string) {
      const { timezone } = settings()
      const dayOf = (at: number) => localParts(at, timezone).day
      const days = store.occupiedDays(timezone)
      const today = dayOf(now())
      const selected = day ?? days[0] ?? today
      const utc = Date.parse(selected)
      // IANA 偏移小于一天。先按索引缩小范围，再按当地日期精确匹配。
      const rows = store.list({ since: utc - DAY_MS, until: utc + 2 * DAY_MS }).filter(entry => dayOf(entry.createdAt) === selected)
      const entries = withReferenceDays(rows.map(entry => ({ ...entry, day: selected })), dayOf)
      const pen = store.get('pen')
      const { font, ink, reason } = DEFAULT_OPENING
      // Match localParts' UTC fallback if the configured zone is invalid.
      let timeZone = 'UTC'
      try { timeZone = new Intl.DateTimeFormat('en', { timeZone: timezone }).resolvedOptions().timeZone } catch {}
      return { day: selected, today, timeZone, days: [...days], entries, pen: pen ?? { font, ink, reason }, penPending: !!opening, paper: store.get('paper') ?? 'ruled' }
    },
    markRepliesSeen(ids) {
      store.atomic(() => {
        const state = replyReadState()
        const next = advanceReplyReadState(state, ids)
        if (next.highWater !== state.highWater || next.missedIds.length !== state.missedIds.length) {
          store.set('replyReadState', next)
        }
      })
    },
    unseen() {
      const state = store.get('replyReadState') ?? store.atomic(replyReadState)
      const at = store.firstUnseenReplyAfter(state.highWater, state.missedIds)
      return { ok: true, unseen: at !== null, day: at === null ? null : localParts(at, settings().timezone).day }
    },
    write(body, clientId, origin) {
      const entry = append('owner', body, origin, now(), clientId)
      return { ...entry, day: localParts(entry.createdAt, settings().timezone).day }
    },
    strike: (id: string, struck: boolean) => store.strike(id, struck ? now() : null),
    paper: (paper: NotebookSettings['paper']) => { store.set('paper', paper); return paper },
    isOwner: (caller: Parameters<NonNullable<NotebookDeps['isOwner']>>[0]) => deps.isOwner?.(caller) === true,
    jot(text) {
      const entry = append('cc', NOTEBOOK_JOT_PREFIX + text.trim(), 'chat', now())
      return { ...entry, day: localParts(entry.createdAt, settings().timezone).day }
    },
    read(days: number, query?: string, after?: string) {
      const { timezone } = settings()
      const dayOf = (at: number) => localParts(at, timezone).day
      const firstDay = new Date(Date.parse(dayOf(now())) - (days - 1) * DAY_MS).toISOString().slice(0, 10)
      const since = Date.parse(firstDay) - DAY_MS
      const entries: NotebookEntry[] = []
      let olderThan = after
      let size = JSON.stringify({ entries: [], nextAfter: '00000000-0000-0000-0000-000000000000' }).length
      for (;;) {
        const batch = store.list({ since, query, olderThan, limit: CHAT_READ_BATCH }).reverse()
        const dated = batch.map(entry => ({ ...entry, day: dayOf(entry.createdAt) })).filter(entry => entry.day >= firstDay)
        for (const entry of withReferenceDays(dated, dayOf)) {
          const added = JSON.stringify(entry).length + (entries.length ? 1 : 0)
          if (size + added > CHAT_READ_MAX_CHARS) return { entries, nextAfter: entries.at(-1)?.id }
          entries.push(entry)
          size += added
        }
        if (batch.length < CHAT_READ_BATCH) return { entries }
        olderThan = batch.at(-1)!.id
      }
    },
    tick,
  }
}

export { notebookRoutes } from './routes'

export function notebookFeature(deps: (ctx: ModuleCtx) => NotebookDeps): DaemonModule<Notebook> {
  return {
    name: 'notebook',
    needs: ['internal-api', 'bootstrap'],
    optional: true,
    init(ctx) {
      const notebook = makeNotebook(deps(ctx))
      ctx.get<InternalApiLifecycle>('internal-api').mount('notebook', notebookRoutes(notebook))
      return notebook
    },
  }
}

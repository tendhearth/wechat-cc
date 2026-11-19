import { NOTEBOOK_JOT_PREFIX } from '@wechat-cc/protocol'
import {
  COMMENT_PROMPT, DEFAULT_OPENING, PEN_PROMPT,
  parseComment, parseOpening, type NotebookEntry,
} from '../../domain/notebook'
import { NOTEBOOK_DEFAULTS, type NotebookConfig } from '../../lib/notebook-config'
import { localParts } from '../../lib/local-time'
import type { Notebook, NotebookCaller, NotebookSettings, NotebookStore } from '../../ports/notebook'

const DAY_MS = 86_400_000
const EMPTY_INITIATIVE: NotebookSettings['initiative'] = { lastAt: 0, day: '', attempts: 0, failures: 0, retryAt: 0 }

interface NotebookDeps {
  store: NotebookStore
  settings: () => { timezone: string; notebook?: Partial<NotebookConfig> }
  model: () => ((prompt: string) => Promise<string>) | null
  persona?: () => string
  isOwner?: (caller: NotebookCaller) => boolean
  now?: () => number
  log?: (count: number, length: number) => void
}

async function ask(model: (prompt: string) => Promise<string>, prompt: string, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      model(prompt),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Notebook model timed out')), timeoutMs)
        timer.unref?.()
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

export function makeNotebook(deps: NotebookDeps): Notebook {
  const { store } = deps
  const now = deps.now ?? Date.now
  const settings = () => {
    const { timezone, notebook } = deps.settings()
    return { timezone, config: { ...NOTEBOOK_DEFAULTS, ...notebook } }
  }
  const append = (author: NotebookEntry['author'], body: string, origin: NotebookEntry['origin'], createdAt: number, clientId: string | null = null, refId: string | null = null) => {
    const entry = store.append({ author, body, origin, createdAt, clientId, refId })
    deps.log?.(1, Array.from(entry.body).length)
    return entry
  }

  let opening: Promise<void> | undefined
  function open(origin: 'desktop' | 'app') {
    if (opening || store.get('pen')) return opening
    if (store.list({ limit: 1 }).length) {
      const { font, ink, reason } = DEFAULT_OPENING
      store.set('pen', { font, ink, reason })
      return
    }
    const openedAt = now()
    opening = Promise.resolve().then(async () => {
      let intro = DEFAULT_OPENING
      try {
        const model = deps.model()
        const persona = deps.persona?.()
        const prompt = persona ? `${PEN_PROMPT}\nCC 的性格资料：${JSON.stringify(persona)}` : PEN_PROMPT
        if (model) intro = parseOpening(await ask(model, prompt, settings().config.openingTimeoutMs))
      } catch { /* 用固定开场。 */ }
      store.atomic(() => {
        if (store.get('pen')) return
        const { font, ink, reason } = intro
        store.set('pen', { font, ink, reason })
        // 首次打开时为空。写入可以在选笔期间完成，开场仍排在第一页。
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
    if (checking || startedAt < nextCheck) return
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
    const reservation = { ...state, day, attempts: attempts + 1 }
    try {
      store.set('initiative', reservation)
      const prompt = `${COMMENT_PROMPT}\n${JSON.stringify({
        candidateIds: candidates.map(entry => entry.id),
        entries: recent.filter(entry => entry.struckAt === null).map(({ id, author, body, createdAt }) =>
          ({ id, author, body, day: localParts(createdAt, timezone).day })),
      })}`
      const result = parseComment(await ask(model, prompt, config.timeoutMs), candidates)
      store.atomic(() => {
        const finishedAt = now()
        const latest = store.list({ ownerOnly: true, limit: 1 })[0]
        const ref = result && store.byId(result.refId)
        const finishedDay = localParts(finishedAt, timezone).day
        // 宁可丢掉跨日的结果；该次调用属于发起的那一天。
        const saved = !!(result && ref && ref.struckAt === null && latest && finishedDay === day
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
      const days = [...new Set(store.timestamps().map(dayOf))].sort().reverse()
      const selected = day ?? days[0] ?? dayOf(now())
      const utc = Date.parse(selected)
      // IANA 偏移小于一天。先按索引缩小范围，再按当地日期精确匹配。
      const entries = store.list({ since: utc - DAY_MS, until: utc + 2 * DAY_MS }).filter(entry => dayOf(entry.createdAt) === selected)
      const pen = store.get('pen')
      const { font, ink, reason } = DEFAULT_OPENING
      return { day: selected, days, entries, pen: pen ?? { font, ink, reason }, penPending: !!opening, paper: store.get('paper') ?? 'ruled' }
    },
    write: (body: string, clientId: string, origin: 'desktop' | 'app') => append('owner', body, origin, now(), clientId),
    strike: (id: string, struck: boolean) => store.strike(id, struck ? now() : null),
    paper: (paper: NotebookSettings['paper']) => { store.set('paper', paper); return paper },
    isOwner: (caller: Parameters<NonNullable<NotebookDeps['isOwner']>>[0]) => deps.isOwner?.(caller) === true,
    jot: (text: string) => append('cc', NOTEBOOK_JOT_PREFIX + text.trim(), 'chat', now()),
    read(days: number, query?: string) {
      const { timezone } = settings()
      const dayOf = (at: number) => localParts(at, timezone).day
      const firstDay = new Date(Date.parse(dayOf(now())) - (days - 1) * DAY_MS).toISOString().slice(0, 10)
      return store.list({ since: Date.parse(firstDay) - DAY_MS, query }).filter(entry => dayOf(entry.createdAt) >= firstDay)
    },
    tick,
  }
}

export { notebookRoutes } from './routes'

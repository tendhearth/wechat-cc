/**
 * CC 的信(2026-10-16):不定期给主人写一封信,排成信纸图片寄到微信。
 *
 * 两条路进来:
 *   - 定时:15 分钟一次 tick。开着(companion.letters_enabled)才排期;到了随机的那天傍晚落笔。
 *   - 当面:主人说「给我写封信」,CC 的 cc_letter 工具 → writeNow(不看开关、不改排期)。
 *
 * 写好的信先存档(<stateDir>/letters/<id>/),再投递。投递失败不丢信:
 *   - 微信不让主动发(errcode=-2,主人很久没说话)/ 微信断着 → App 收得到(手机伙伴第 2 步,2026-10-18)就寄到 App
 *     (几页图记成主人对话里 CC 的一行 + 一条「CC 给你写了一封信」推送);收不到 ⇒ 等主人下一次开口再寄,
 *     不在关着的窗口上反复撞;
 *   - 其它失败最多试 3 次,之后放弃(信还在存档里)。
 * 一次一封:上一封没寄出去之前,不写下一封。
 */
import type { ProactiveTurn } from '../../daemon/companion/proactive-channel'
import { writeFileAtomic } from '../../lib/json-file'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { readJsonFile } from '../../lib/read-json-file'
import { localParts } from '../../lib/local-time'
import { TELLTALE, buildLetterPrompt, letterText, parseLetter, type LetterDraft, type LetterMaterial } from './compose'
import { letterSvgs } from './render'
import { DAY_MS, FIRST_GAP_DAYS, GAP_DAYS, THIN_RETRY_DAYS, isLetterDue, nextDueAt } from './schedule'

export const LETTERS_DIR = 'letters'
const STATE_FILE = 'letters.json'
const CHAT_LOOKBACK_MS = 30 * DAY_MS
const PENDING_TTL_MS = 14 * DAY_MS
const MAX_ATTEMPTS = 3
const EVAL_TIMEOUT_MS = 4 * 60_000
const isWindowClosed = (msg: string) => /errcode=-2\b/.test(msg)

export interface PendingLetter {
  id: string
  createdAt: number
  pages: string[]
  text: string
  attempts: number
  /** 主人当面要的(免打扰时段不拦);旧状态文件没有 ⇒ 当成不定期的。 */
  requested?: boolean
  /** 已经寄到微信的页数(中途失败下一次从这里接着寄,不把前几页再发一遍;旧状态文件没有 ⇒ 0) */
  sentPages?: number
  /** 微信说主动发不了的那一刻;主人此后开口过才再试 */
  blockedAt: number | null
}
export interface LetterState {
  dueAt: number | null
  pending: PendingLetter | null
  /**
   * 旧标记(M5d 起只读不写):上一封寄出的时刻。现在从「信」那件事的轮推(letterDeliveries);真机上第一封信寄出之前
   * 一轮都没有,所以两边取较新的(lastSentAtOf)。
   */
  lastSentAt?: number | null
}
export interface LetterRecord {
  id: string
  day: string
  created_at: string
  /** 旧标记(M5d 起只读不写):寄出的时刻。现在从「信」那件事的轮推(letterDeliveries),老信没有轮 ⇒ 读这个。 */
  sent_at: string | null
  requested: boolean
  /** 寄到哪了(2026-10-18 起才记;老信没有这个字段 = 微信)。同 sent_at:M5d 起只读不写,新信从轮推。 */
  sent_via?: 'wechat' | 'app'
  letter: LetterDraft
}
export interface LetterSummary { id: string; day: string; sent_at: string | null; requested: boolean; opening: string }
export interface LetterStatus {
  enabled: boolean
  /** 只说排没排上,不说哪天 —— 说了就不是「无缘无故」了 */
  scheduled: boolean
  pending: { id: string; created_at: string; waiting_for_owner: boolean } | null
  letters: LetterSummary[]
}
export type WriteResult =
  | { status: 'sent' | 'waiting'; id: string }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; reason: string }

export interface LetterDeps {
  stateDir: string
  /** CC 自己做的事(M5b):写一封 / 续寄一次 = 「信」那件事的一轮;不给 ⇒ 不记。 */
  acts?: Pick<import('../../ports/cc-acts').CcActs, 'begin' | 'stepsOf'>
  enabled(): boolean
  timezone(): string
  ownerChatId(): string | null
  memory(owner: string): string
  chatSince(owner: string, sinceIso: string): Promise<string[]>
  lastInboundAt(owner: string): Promise<number | null>
  evalText(): ((prompt: string) => Promise<string>) | null
  wechatSuspended(): boolean
  /**
   * CC 开口那道门(SpeechPolicy,第三批 3a):信能不能写 / 能不能寄由它判 —— 不定期的信是 initiative(别烦我 ⇒ 这封不写,
   * 写好没寄的不寄了,存档里留着;免打扰 / 两条路都送不到 ⇒ 等着);当面要的(letter_asked)是 requested,照写照寄。
   * 「往哪儿寄、怎么一页一页寄、断了怎么续」仍是这里自己的事(信有自己的多页投递和 App 那条路)。
   */
  speech: import('../../daemon/speech/policy').SpeechPolicy
  sendText(chatId: string, text: string): Promise<{ error?: string }>
  sendFile(chatId: string, path: string): Promise<void>
  /**
   * App 那条路(手机伙伴第 2 步):微信断着 / 主动发的窗口关了时,App 收得到就寄到 App。
   * 没接 / 回 null ⇒ 只有微信(改造前:等主人开口)。
   */
  app?(): LetterApp | null
  /** 微信寄出之后:这几页记成主人对话里 CC 的一行(App 对话页看得见)。sendFile 本身不再逐页记。 */
  mirror?(chatId: string, pages: string[]): void
  /** SVG → PNG 路径;不支持的平台回 null(退回发文字) */
  rasterize(svg: string, dir: string, name: string): string | null
  now(): number
  random(): number
  newId(): string
  log(tag: string, line: string): void
}

export interface LetterApp {
  deliverable(chatId: string): boolean
  /** 记进主人对话 + 推一条;成功 ⇒ true。 */
  deliver(chatId: string, letter: { id: string; pages: string[]; text: string }): Promise<boolean>
}

export interface LetterRuntime {
  tick(): Promise<void>
  writeNow(request?: string): Promise<WriteResult>
  /** 维护者自检:照常写、照常排版,但不存档、不寄、不动排期。图放在 letters/previews/。 */
  preview(request?: string): Promise<{ status: 'ok'; pages: string[]; text: string } | { status: 'skipped' | 'failed'; reason: string }>
  status(): LetterStatus
}

const DEFAULT_STATE: LetterState = { dueAt: null, pending: null }

/** 一封信寄出的那一刻、寄到哪(从「信」那件事的轮推出来;M5d)。 */
export interface LetterDelivery { at: number; via: 'wechat' | 'app' }
export type LetterDeliveries = ReadonlyMap<string, LetterDelivery>

/**
 * 「信」那件事的轮里,寄出去了的每一封:delivery 那一步 result='sent'。时刻取那一步记的 sentAt(= 以前写进 sent_at /
 * lastSentAt 的那一刻),没有就取这一步写下的时刻。读不出来 ⇒ 空(调用方照旧读旧标记)。
 */
export function letterDeliveries(acts: Pick<import('../../ports/cc-acts').CcActs, 'stepsOf'> | undefined): Map<string, LetterDelivery> {
  const out = new Map<string, LetterDelivery>()
  let steps: ReturnType<import('../../ports/cc-acts').CcActs['stepsOf']> = []
  // 所有轮里的 delivery 那一步(不限轮数:失败、续寄的轮再多,也找得到每一封寄出的那一步;Codex 评审)
  try { steps = acts?.stepsOf('letters', 'delivery') ?? [] } catch { steps = [] }
  for (const st of steps) {
    const p = st.payload
    if (p.result !== 'sent' || typeof p.letter !== 'string' || out.has(p.letter)) continue
    out.set(p.letter, { at: typeof p.sentAt === 'number' && Number.isFinite(p.sentAt) ? p.sentAt : st.at, via: p.via === 'app' ? 'app' : 'wechat' })
  }
  return out
}
/** 这封信寄出了没有、什么时候、寄到哪:轮里有 ⇒ 轮;没有(M5d 之前寄的)⇒ 存档里的旧 sent_at / sent_via。 */
export function letterSent(r: LetterRecord, delivered: LetterDeliveries): LetterDelivery | null {
  const d = delivered.get(r.id)
  if (d) return d
  if (!r.sent_at) return null
  const at = Date.parse(r.sent_at)
  return Number.isFinite(at) ? { at, via: r.sent_via === 'app' ? 'app' : 'wechat' } : null
}
/** 上一封寄出的时刻:轮里最新的那封和旧标记 lastSentAt 取较新的。 */
export function lastSentAtOf(s: LetterState, delivered: LetterDeliveries): number | null {
  let best = typeof s.lastSentAt === 'number' && Number.isFinite(s.lastSentAt) ? s.lastSentAt : null
  for (const d of delivered.values()) if (best === null || d.at > best) best = d.at
  return best
}

/** 存档里的信,新的在前(手机「CC 的信」也读这个,letters/archive.ts)。 */
export function readLetterRecords(stateDir: string): LetterRecord[] { return readRecords(stateDir) }

export function readLetterState(stateDir: string): LetterState {
  try {
    const raw = readJsonFile<Partial<LetterState>>(join(stateDir, 'companion', STATE_FILE))
    return { ...DEFAULT_STATE, ...raw }
  } catch { return { ...DEFAULT_STATE } }
}
function writeLetterState(stateDir: string, s: LetterState): void {
  const dir = join(stateDir, 'companion')
  mkdirSync(dir, { recursive: true })
  writeFileAtomic(join(dir, STATE_FILE), JSON.stringify(s, null, 2))
}

function readRecords(stateDir: string): LetterRecord[] {
  const root = join(stateDir, LETTERS_DIR)
  if (!existsSync(root)) return []
  const out: LetterRecord[] = []
  for (const id of readdirSync(root)) {
    if (id === 'previews') continue
    try { out.push(readJsonFile<LetterRecord>(join(root, id, 'letter.json'))) } catch { /* 半截的目录:跳过 */ }
  }
  return out.sort((a, b) => b.created_at.localeCompare(a.created_at))
}
function writeRecord(stateDir: string, r: LetterRecord): void {
  const dir = join(stateDir, LETTERS_DIR, r.id)
  mkdirSync(dir, { recursive: true })
  writeFileAtomic(join(dir, 'letter.json'), JSON.stringify(r, null, 2))
}
const opening = (r: LetterRecord) => (r.letter.paragraphs[0] ?? '').slice(0, 40)

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms)
    p.then(v => { clearTimeout(t); resolve(v) }, e => { clearTimeout(t); reject(e) })
  })
}

export function makeLetterRuntime(d: LetterDeps): LetterRuntime {
  const state = () => readLetterState(d.stateDir)
  const save = (patch: Partial<LetterState>) => writeLetterState(d.stateDir, { ...state(), ...patch })
  const delivered = () => letterDeliveries(d.acts)
  const lastSentAt = () => lastSentAtOf(state(), delivered())

  async function compose(owner: string, request: string | undefined): Promise<{ kind: 'letter'; letter: LetterDraft } | { kind: 'skip' | 'failed'; reason: string }> {
    const ev = d.evalText()
    if (!ev) return { kind: 'failed', reason: 'no_model' }
    const nowMs = d.now()
    const records = readRecords(d.stateDir)
    const lastSent = lastSentAt()
    const since = new Date(Math.max(nowMs - CHAT_LOOKBACK_MS, lastSent ? lastSent - 2 * DAY_MS : 0)).toISOString()
    const material: LetterMaterial = {
      today: localParts(nowMs, d.timezone()).day,
      memory: d.memory(owner),
      chat: await d.chatSince(owner, since),
      previous: records.slice(0, 3).map(r => ({ day: r.day, opening: opening(r) })),
      ...(request ? { request } : {}),
    }
    const prompt = buildLetterPrompt(material)
    let raw: string
    try {
      raw = await withTimeout(ev(prompt), EVAL_TIMEOUT_MS)
      const first = parseLetter(raw)
      const hit = first.kind === 'letter' ? letterText(first.letter).match(TELLTALE) : null
      if (hit) {
        // 露馅了(「翻到那条记录」):带着原稿重写一次;第二次还露馅也寄,不无限重试
        d.log('LETTERS', `draft said 「${hit[0]}」; rewriting once`)
        raw = await withTimeout(ev(`${prompt}\n\n## 你刚写的一稿\n${raw}\n\n这一稿里出现了「${hit[0]}」这种字眼,读起来像在翻档案。按同样的格式重写一遍:同样的事,写得像你自然记得。`), EVAL_TIMEOUT_MS)
      }
    } catch (e) { return { kind: 'failed', reason: e instanceof Error ? e.message : String(e) } }
    const r = parseLetter(raw)
    if (r.kind !== 'letter' && (r.reason === 'empty' || r.reason === 'unparseable')) d.log('LETTERS', `model reply not a letter (${raw.length} chars): ${raw.slice(0, 80).replace(/\s+/g, ' ')}`)
    return r.kind === 'letter' ? r : { kind: 'skip', reason: r.reason }
  }

  /** 存档 + 排成图;返回待寄的那封。 */
  function file(letter: LetterDraft, requested: boolean, allocatedId?: string): PendingLetter {
    const nowMs = d.now()
    const day = localParts(nowMs, d.timezone()).day
    const id = allocatedId ?? `${day}-${d.newId()}`
    const record: LetterRecord = { id, day, created_at: new Date(nowMs).toISOString(), sent_at: null, requested, letter }
    writeRecord(d.stateDir, record)
    const dir = join(d.stateDir, LETTERS_DIR, id)
    const pages: string[] = []
    const svgs = letterSvgs(letter, day)
    for (let i = 0; i < svgs.length; i++) {
      const png = d.rasterize(svgs[i]!, dir, `page-${i + 1}`)
      if (!png) { pages.length = 0; break }   // 一页失败就整封退回文字,别寄半封
      pages.push(png)
    }
    return { id, createdAt: nowMs, pages, text: letterText(letter), attempts: 0, blockedAt: null, ...(requested ? { requested: true } : {}) }
  }

  async function deliver(p: PendingLetter, outbound?: ProactiveTurn): Promise<'sent' | 'waiting' | 'failed' | 'expired'> {
    const owner = d.ownerChatId()
    if (!owner) return 'waiting'
    const nowMs = d.now()
    if (nowMs - p.createdAt > PENDING_TTL_MS) {
      save({ pending: null })
      d.log('LETTERS', `letter ${p.id} expired unsent (kept in archive)`)
      return 'expired'
    }
    // 寄出的时刻和去处记在这一轮的 delivery 那一步上(deliverIn 写),不再回写存档 / lastSentAt(M5d)
    const markSent = (via: 'wechat' | 'app') => {
      sentMark = { id: p.id, at: nowMs, via }
      save({ pending: null })
    }
    // 微信不通时寄到 App:收得到且记上了 ⇒ 'sent';否则 null(照旧等)。
    const toApp = async (why: string): Promise<'sent' | null> => {
      let ok = false
      try {
        const a = d.app?.() ?? null
        if (!a || !a.deliverable(owner)) return null
        ok = await a.deliver(owner, { id: p.id, pages: p.pages, text: p.text })
      } catch (e) {
        d.log('LETTERS', `letter ${p.id} app delivery threw: ${e instanceof Error ? e.message : String(e)}`)
        return null
      }
      if (!ok) return null
      outbound?.confirmDelivery?.('app')
      markSent('app')
      d.log('LETTERS', `letter ${p.id} delivered to the app (${why})`)
      return 'sent'
    }
    if (d.wechatSuspended()) return (await toApp('wechat degraded')) ?? 'waiting'
    if (p.blockedAt !== null) {
      const inbound = await d.lastInboundAt(owner)
      if (!inbound || inbound <= p.blockedAt) return (await toApp('wechat window closed')) ?? 'waiting'
    }
    let sentPages = Math.min(Math.max(0, p.sentPages ?? 0), p.pages.length)
    try {
      if (p.pages.length) for (; sentPages < p.pages.length; sentPages++) {
        await d.sendFile(owner, p.pages[sentPages]!)
        outbound?.confirmDelivery?.('wechat')
      }
      else {
        const r = await d.sendText(owner, `（一封信）\n\n${p.text}`)
        if (r.error) throw new Error(r.error)
        outbound?.confirmDelivery?.('wechat')
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (isWindowClosed(msg)) {
        if (await toApp('wechat window closed')) return 'sent'
        save({ pending: { ...p, sentPages, blockedAt: nowMs } })
        d.log('LETTERS', `letter ${p.id} waiting: WeChat won't take a proactive send until the owner speaks`)
        return 'waiting'
      }
      const attempts = p.attempts + 1
      if (attempts >= MAX_ATTEMPTS) {
        save({ pending: null })
        d.log('LETTERS', `letter ${p.id} gave up after ${attempts} tries: ${msg}`)
        return 'failed'
      }
      save({ pending: { ...p, sentPages, attempts } })
      d.log('LETTERS', `letter ${p.id} send failed (try ${attempts}): ${msg}`)
      return 'waiting'
    }
    if (p.pages.length) { try { d.mirror?.(owner, p.pages) } catch { /* 只是让 App 也看得见 */ } }
    markSent('wechat')
    d.log('LETTERS', `letter ${p.id} sent (${p.pages.length ? `${p.pages.length} page(s)` : 'as text'})`)
    return 'sent'
  }

  /** deliver 寄出时记下的那一刻和去处(deliverIn 写进 delivery 那一步;寄出的时刻只记在轮上,M5d)。 */
  let sentMark: { id: string; at: number; via: 'wechat' | 'app' } | null = null
  const sentMarkOf = (id: string) => (sentMark?.id === id ? sentMark : null)   // 读成函数:await 之后 TS 不再把它收窄成 null
  /** 「信」那件事的一轮(M5b):写信 / 续寄时开,寄的结果收。记不上不影响寄信。 */
  const NO_TURN = { id: null, step: () => false, finish: () => false }
  const actTurn = (policy: Record<string, unknown>) => { try { return d.acts?.begin('letters', { startedAt: d.now(), policy }) ?? NO_TURN } catch { return NO_TURN } }
  type ActTurn = ReturnType<typeof actTurn>
  const filed = (t: ActTurn, p: PendingLetter) => t.step('artifact', { letter: p.id, pages: p.pages.length, chars: p.text.length, opening: p.text.split('\n')[0]!.slice(0, 40) })
  const noLetter = (t: ActTurn, r: { kind: 'skip' | 'failed'; reason: string }) => { t.step('system', { [r.kind === 'skip' ? 'skipped' : 'failed']: r.reason }); t.finish('failed', { endedAt: d.now(), errorCode: r.kind === 'skip' ? 'skipped' : 'compose_failed' }) }
  /** 写 / 存档 / 排版中途抛了:这一轮收成 failed 再往外抛,别让它一直挂「在跑」(Codex 评审)。finish 只收一次。 */
  const guarded = async <T>(t: ActTurn, fn: () => Promise<T>): Promise<T> => {
    try { return await fn() } catch (e) { t.finish('failed', { endedAt: d.now(), errorCode: 'threw' }); throw e }
  }
  const deliverIn = async (t: ActTurn, p: PendingLetter, outbound?: ProactiveTurn): Promise<Awaited<ReturnType<typeof deliver>>> => {
    let r: Awaited<ReturnType<typeof deliver>> = 'failed'
    sentMark = null
    try { r = await deliver(p, outbound) } finally {
      const mark = r === 'sent' ? sentMarkOf(p.id) : null
      const recorded = t.step('delivery', { letter: p.id, result: r, ...(mark ? { via: mark.via, sentAt: mark.at } : {}) }, { status: r === 'sent' ? 'completed' : 'failed' }) === true
      // 寄出的那一步没记上(没接 act / 库写不进):退回旧标记,别让寄出去的信在抽屉里看不见、下一封的间隔算错
      if (mark && !recorded) {
        try {
          const rec = readRecords(d.stateDir).find(x => x.id === p.id)
          if (rec) writeRecord(d.stateDir, { ...rec, sent_at: new Date(mark.at).toISOString(), sent_via: mark.via })
          save({ lastSentAt: mark.at })
        } catch (e) { d.log('LETTERS', `letter ${p.id} sent mark not saved: ${e instanceof Error ? e.message : String(e)}`) }
      }
      t.finish(r === 'sent' ? 'completed' : 'failed', { endedAt: d.now(), ...(r === 'sent' ? {} : { errorCode: r }) })
    }
    return r
  }

  // tick 与 writeNow 走同一条串行链:不会两封同时写,也不会同一封寄两次。
  let chain: Promise<unknown> = Promise.resolve()
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn)
    chain = next.catch(() => {})
    return next
  }

  return {
    tick: () => serial(async () => {
      const s = state()
      // 写好没寄的:先问门(当面要的是 requested,照寄;不定期的:免打扰 / 送不到 ⇒ 等,别烦我 ⇒ 不寄了,存档里留着)
      if (s.pending) {
        const pending = s.pending, owner = d.ownerChatId()
        if (!owner) return
        const o = await d.speech.propose({ source: 'letter', summary: 'Resume an archived letter', createdAt: pending.createdAt, expiresAt: pending.createdAt + PENDING_TTL_MS, payloadRef: { letter: pending.id }, validate: () => state().pending?.id === pending.id, kind: pending.requested ? 'letter_asked' : 'letter', chatId: owner, ref: `letter:${pending.id}`, nowMs: d.now() }, async (outbound) => { await deliverIn(actTurn({ letter: pending.id, resume: true }), pending, outbound) })
        if ('drop' in o) { save({ pending: null }); d.log('LETTERS', `letter ${pending.id} not sent: ${o.reason} (kept in archive)`) }
        return
      }
      if (!d.enabled()) return
      const nowMs = d.now()
      if (s.dueAt === null) {
        const dueAt = nextDueAt(nowMs, lastSentAt() ? GAP_DAYS : FIRST_GAP_DAYS, d.random)
        save({ dueAt })
        d.log('LETTERS', `next letter scheduled ${new Date(dueAt).toISOString()}`)
        return
      }
      if (!isLetterDue({ nowMs, tz: d.timezone(), dueAt: s.dueAt })) return
      const owner = d.ownerChatId()
      if (!owner) return
      // 到点了:先问门,再写(写信要调模型,被拦下的那一拍一个 token 都不花)。免打扰 / 两条路都送不到 ⇒ 不写,还是到期,
      // 下一拍再问;别烦我 ⇒ 这一封不写了,排下一封。
      const allocatedId = `${new Date(nowMs).toISOString().slice(0, 10)}-${d.newId()}`
      const o = await d.speech.propose({ source: 'letter', summary: 'Write a due letter', payloadRef: { letter: allocatedId, dueAt: s.dueAt }, validate: () => d.enabled() && !state().pending && state().dueAt === s.dueAt && isLetterDue({ nowMs: d.now(), tz: d.timezone(), dueAt: s.dueAt! }), kind: 'letter', chatId: owner, ref: `letter:${allocatedId}`, nowMs }, async (outbound) => {
        const t = actTurn({ trigger: 'schedule' })
        await guarded(t, async () => {
        const r = await compose(owner, undefined)
        if (r.kind !== 'letter') {
          noLetter(t, r)
          const retryDays = r.kind === 'skip' ? THIN_RETRY_DAYS : 1
          save({ dueAt: nowMs + retryDays * DAY_MS })
          d.log('LETTERS', `scheduled letter ${r.kind}: ${r.reason}; look again in ${retryDays}d`)
          return
        }
        const p = file(r.letter, false, allocatedId)
        filed(t, p)
        save({ pending: p, dueAt: nextDueAt(nowMs, GAP_DAYS, d.random) })
        await deliverIn(t, p, outbound)
        })
      })
      if ('drop' in o) {
        save({ dueAt: nextDueAt(nowMs, GAP_DAYS, d.random) })
        d.log('LETTERS', `scheduled letter not written: ${o.reason}; next one rescheduled`)
      }
    }),

    writeNow: (request) => serial(async (): Promise<WriteResult> => {
      const owner = d.ownerChatId()
      if (!owner) return { status: 'failed', reason: 'no_owner' }
      const s = state()
      // 上一封还没寄出去:先寄它,不写新的(主人当面要的 ⇒ requested,照寄;门只在两条路都送不到时让它等)
      if (s.pending) {
        const pending = s.pending
        let r = 'waiting' as Awaited<ReturnType<typeof deliver>>
        await d.speech.say({ kind: 'letter_asked', chatId: owner, ref: `letter:${pending.id}`, nowMs: d.now() }, async (outbound) => { r = await deliverIn(actTurn({ letter: pending.id, resume: true, trigger: 'owner' }), pending, outbound) })
        return r === 'sent' ? { status: 'sent', id: pending.id } : r === 'waiting' ? { status: 'waiting', id: pending.id } : { status: 'failed', reason: `previous_${r}` }
      }
      const t = actTurn({ trigger: 'owner' })
      return guarded(t, async (): Promise<WriteResult> => {
      const r = await compose(owner, request)
      if (r.kind !== 'letter') {
        noLetter(t, r)
        d.log('LETTERS', `requested letter ${r.kind}: ${r.reason}`)
        // 主人当面要的,写不成要说一声(「出了错但没人告诉你」)
        await d.sendText(owner, r.kind === 'skip' ? '这封信我没写成 —— 能落笔的具体的事还太少。多跟我说说,过几天再给你写。' : '这封信我没写成(这会儿模型连不上)。晚点再跟我说一次。').catch(() => {})
        return { status: r.kind === 'skip' ? 'skipped' : 'failed', reason: r.reason }
      }
      const p = file(r.letter, true)
      filed(t, p)
      save({ pending: p })
      let out = 'waiting' as Awaited<ReturnType<typeof deliver>>
      let delivered = false
      await d.speech.say({ kind: 'letter_asked', chatId: owner, ref: `letter:${p.id}`, nowMs: d.now() }, async (outbound) => { delivered = true; out = await deliverIn(t, p, outbound) })
      // 门没让寄(两条路都送不到):这一轮先收成「等着」,下次续寄再开一轮
      if (!delivered) t.finish('failed', { endedAt: d.now(), errorCode: 'waiting' })
      return out === 'sent' || out === 'waiting' ? { status: out, id: p.id } : { status: 'failed', reason: out }
      })
    }),

    preview: (request) => serial(async () => {
      const owner = d.ownerChatId()
      if (!owner) return { status: 'failed' as const, reason: 'no_owner' }
      const r = await compose(owner, request)
      if (r.kind !== 'letter') return { status: r.kind === 'skip' ? 'skipped' as const : 'failed' as const, reason: r.reason }
      const day = localParts(d.now(), d.timezone()).day
      const dir = join(d.stateDir, LETTERS_DIR, 'previews')
      const pages = letterSvgs(r.letter, day).map((svg, i) => d.rasterize(svg, dir, `preview-${d.now()}-${i + 1}`)).filter((p): p is string => !!p)
      return { status: 'ok' as const, pages, text: letterText(r.letter) }
    }),

    status: () => {
      const s = state()
      const sent = delivered()
      return {
        enabled: d.enabled(),
        scheduled: d.enabled() && s.dueAt !== null,
        pending: s.pending ? { id: s.pending.id, created_at: new Date(s.pending.createdAt).toISOString(), waiting_for_owner: s.pending.blockedAt !== null } : null,
        letters: readRecords(d.stateDir).slice(0, 20).map(r => { const at = letterSent(r, sent)?.at; return { id: r.id, day: r.day, sent_at: at !== undefined ? new Date(at).toISOString() : null, requested: r.requested, opening: opening(r) } }),
      }
    },
  }
}

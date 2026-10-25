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
import { writeFileAtomic } from '../../lib/json-file'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { readJsonFile } from '../../lib/read-json-file'
import { localParts } from '../../daemon/memory/nightly-schedule'
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
  lastSentAt: number | null
}
export interface LetterRecord {
  id: string
  day: string
  created_at: string
  sent_at: string | null
  requested: boolean
  /** 寄到哪了(2026-10-18 起才记;老信没有这个字段 = 微信)。 */
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

const DEFAULT_STATE: LetterState = { dueAt: null, pending: null, lastSentAt: null }

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

  async function compose(owner: string, request: string | undefined): Promise<{ kind: 'letter'; letter: LetterDraft } | { kind: 'skip' | 'failed'; reason: string }> {
    const ev = d.evalText()
    if (!ev) return { kind: 'failed', reason: 'no_model' }
    const nowMs = d.now()
    const records = readRecords(d.stateDir)
    const lastSent = state().lastSentAt
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
  function file(letter: LetterDraft, requested: boolean): PendingLetter {
    const nowMs = d.now()
    const day = localParts(nowMs, d.timezone()).day
    const id = `${day}-${d.newId()}`
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

  async function deliver(p: PendingLetter): Promise<'sent' | 'waiting' | 'failed' | 'expired'> {
    const owner = d.ownerChatId()
    if (!owner) return 'waiting'
    const nowMs = d.now()
    if (nowMs - p.createdAt > PENDING_TTL_MS) {
      save({ pending: null })
      d.log('LETTERS', `letter ${p.id} expired unsent (kept in archive)`)
      return 'expired'
    }
    const markSent = (via: 'wechat' | 'app') => {
      const rec = readRecords(d.stateDir).find(r => r.id === p.id)
      if (rec) writeRecord(d.stateDir, { ...rec, sent_at: new Date(nowMs).toISOString(), sent_via: via })
      save({ pending: null, lastSentAt: nowMs })
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
      if (p.pages.length) for (; sentPages < p.pages.length; sentPages++) await d.sendFile(owner, p.pages[sentPages]!)
      else {
        const r = await d.sendText(owner, `（一封信）\n\n${p.text}`)
        if (r.error) throw new Error(r.error)
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
        const o = await d.speech.say({ kind: pending.requested ? 'letter_asked' : 'letter', chatId: owner, nowMs: d.now() }, async () => { await deliver(pending) })
        if ('drop' in o) { save({ pending: null }); d.log('LETTERS', `letter ${pending.id} not sent: ${o.reason} (kept in archive)`) }
        return
      }
      if (!d.enabled()) return
      const nowMs = d.now()
      if (s.dueAt === null) {
        const dueAt = nextDueAt(nowMs, s.lastSentAt ? GAP_DAYS : FIRST_GAP_DAYS, d.random)
        save({ dueAt })
        d.log('LETTERS', `next letter scheduled ${new Date(dueAt).toISOString()}`)
        return
      }
      if (!isLetterDue({ nowMs, tz: d.timezone(), dueAt: s.dueAt })) return
      const owner = d.ownerChatId()
      if (!owner) return
      // 到点了:先问门,再写(写信要调模型,被拦下的那一拍一个 token 都不花)。免打扰 / 两条路都送不到 ⇒ 不写,还是到期,
      // 下一拍再问;别烦我 ⇒ 这一封不写了,排下一封。
      const o = await d.speech.say({ kind: 'letter', chatId: owner, nowMs }, async () => {
        const r = await compose(owner, undefined)
        if (r.kind !== 'letter') {
          const retryDays = r.kind === 'skip' ? THIN_RETRY_DAYS : 1
          save({ dueAt: nowMs + retryDays * DAY_MS })
          d.log('LETTERS', `scheduled letter ${r.kind}: ${r.reason}; look again in ${retryDays}d`)
          return
        }
        const p = file(r.letter, false)
        save({ pending: p, dueAt: nextDueAt(nowMs, GAP_DAYS, d.random) })
        await deliver(p)
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
        await d.speech.say({ kind: 'letter_asked', chatId: owner, nowMs: d.now() }, async () => { r = await deliver(pending) })
        return r === 'sent' ? { status: 'sent', id: pending.id } : r === 'waiting' ? { status: 'waiting', id: pending.id } : { status: 'failed', reason: `previous_${r}` }
      }
      const r = await compose(owner, request)
      if (r.kind !== 'letter') {
        d.log('LETTERS', `requested letter ${r.kind}: ${r.reason}`)
        // 主人当面要的,写不成要说一声(「出了错但没人告诉你」)
        await d.sendText(owner, r.kind === 'skip' ? '这封信我没写成 —— 能落笔的具体的事还太少。多跟我说说,过几天再给你写。' : '这封信我没写成(这会儿模型连不上)。晚点再跟我说一次。').catch(() => {})
        return { status: r.kind === 'skip' ? 'skipped' : 'failed', reason: r.reason }
      }
      const p = file(r.letter, true)
      save({ pending: p })
      let out = 'waiting' as Awaited<ReturnType<typeof deliver>>
      await d.speech.say({ kind: 'letter_asked', chatId: owner, nowMs: d.now() }, async () => { out = await deliver(p) })
      return out === 'sent' || out === 'waiting' ? { status: out, id: p.id } : { status: 'failed', reason: out }
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
      return {
        enabled: d.enabled(),
        scheduled: d.enabled() && s.dueAt !== null,
        pending: s.pending ? { id: s.pending.id, created_at: new Date(s.pending.createdAt).toISOString(), waiting_for_owner: s.pending.blockedAt !== null } : null,
        letters: readRecords(d.stateDir).slice(0, 20).map(r => ({ id: r.id, day: r.day, sent_at: r.sent_at, requested: r.requested, opening: opening(r) })),
      }
    },
  }
}

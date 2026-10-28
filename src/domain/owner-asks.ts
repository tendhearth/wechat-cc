/**
 * 要主人拍板的候选(设计稿 2026-10-23-cc-runs-development §4.8「怎么走」的问主人那一半,§6 第 5 步)。
 *
 * CC 自己找到的活里,**改变主人看得见的行为**的那些不直接做:攒在这里,接在早报「要你拍板的」那一段末尾问,
 * 主人回「2」或「2 不要」就是答案。这一份同时就是**批准记录**(§6 第 7 步的先决条件,整合者评审 #651 / #652):
 * 谁、什么时候、批的是哪一版(hash);内容改了 ⇒ 新的一版,得重批。不另起一套。
 *
 * 规矩(主人 2026-10-24):
 *  - 放在早报里,不单发;一份早报最多接 3 条,每条一行问题 + 一行推荐,编号从早报里已有的拍板项之后接着排;
 *  - 当天没有候选 ⇒ 早报不加这一段;
 *  - 问过三天没回 ⇒ 记成「主人没要」,不再问(主人 10-24 确认);同一个 key 以后再来也不再提。
 *  - 没开早报 ⇒ 不为它单发(**默认,待主人点头**,见 ASK_ONLY_IN_BRIEF)。
 *
 * 这一层是纯的(不碰文件、不碰微信、不叫模型):文件在 owner-asks-store.ts,早报那一轮在 daemon/scheduled-jobs/brief.ts。
 */

/** 一份早报最多接几条(主人 10-24)。 */
export const ASKS_PER_BRIEF = 3
/** 问过几天(几份早报)没回就不再问,记成「主人没要」(主人 10-24 确认)。 */
export const ASK_MAX_DAYS = 3
/**
 * 早报发出后多久内回「2」还算数:12 小时(8 点的早报到晚上 8 点)。原来是 24 小时,整合者评审 #659:
 * 窗口越长,「2」撞上别处刚问的数字(管家的「1 还是 2」、CC 聊天里的「选 2 还是 3」)的机会越多;
 * 当天没回,第二天的早报会重新问(最多三天),所以短一点不丢答案。
 */
export const ASK_REPLY_WINDOW_MS = 12 * 3600_000
/**
 * 没开早报时要不要单发一条问主人:**不**(默认,待主人点头 —— 10-24 问过一次,主人回的是别的事)。
 * 改成 false 之前要先有单发的那条路(现在没有):候选只攒着,`wechat-cc self ask --list` 看得见。
 */
export const ASK_ONLY_IN_BRIEF = true
/** 早报模型写在「要你拍板的」那一段末尾的占位行,CC 在这里接上候选;没写 ⇒ 接在「就这些。」前面。 */
export const ASK_PLACEHOLDER = '<<CC_ASKS>>'

export type OwnerAskStatus = 'queued' | 'asked' | 'approved' | 'declined' | 'unanswered'
export type OwnerAskSource = 'plan' | 'discover' | 'manual'

export interface OwnerAskAnswer {
  verdict: 'approved' | 'declined' | 'unanswered'
  /** 回话的对话 id(主人);三天没回 ⇒ 'cc'(CC 按规矩记的,不是主人说的)。 */
  by: string
  at: string
  /** 批 / 拒的是哪一版(= 当时的 OwnerAsk.hash)。 */
  hash: string
  via: 'wechat_brief' | 'expired'
}

export interface OwnerAsk {
  id: string
  /** 去重用:同一件事(`plan:<计划>:<步>`、`discover:<签名>`…)只排一条。 */
  key: string
  question: string
  recommend: string
  /** 证据(给 `self ask --list` 和以后的规划者看;不进早报)。 */
  evidence?: string
  source: OwnerAskSource
  /** 越大越先问;同分先来先问。 */
  priority: number
  /** 这一版的指纹:sha256(key、问题、推荐、调用方给的版本内容)。 */
  hash: string
  createdAt: string
  status: OwnerAskStatus
  /** 每次接进早报的时刻(一天一次)。 */
  asks: string[]
  answer?: OwnerAskAnswer
}

/** 最近一份早报里的编号 → 候选 id。主人回「2」按它找。 */
export interface OwnerAskBatch { at: string; nos: Record<string, string> }

export interface OwnerAsksState { items: OwnerAsk[]; batch: OwnerAskBatch | null }

export const EMPTY_ASKS: OwnerAsksState = { items: [], batch: null }

export interface EnqueueInput {
  key: string
  question: string
  recommend: string
  evidence?: string
  source: OwnerAskSource
  priority?: number
  /** 这一版的内容(比如计划的 JSON);参与 hash —— 改了就得重批。 */
  version?: string
}

export type EnqueueResult = 'added' | 'updated' | 'same' | 'closed'

const oneLine = (s: string, max: number): string => {
  const t = s.replace(/\s+/g, ' ').trim()
  const a = [...t]
  return a.length <= max ? t : a.slice(0, max - 1).join('') + '…'
}

export function askHashInput(i: EnqueueInput): string {
  return [i.key, oneLine(i.question, 200), oneLine(i.recommend, 200), i.version ?? ''].join('\n')
}

const isOpen = (a: OwnerAsk) => a.status === 'queued' || a.status === 'asked'

/** 从上一份早报的编号里摘掉这些 id(换了版 / 撤下的那条,旧编号作废)。 */
function dropFromBatch(b: OwnerAskBatch | null, ids: ReadonlySet<string>): OwnerAskBatch | null {
  return b ? { ...b, nos: Object.fromEntries(Object.entries(b.nos).filter(([, id]) => !ids.has(id))) } : null
}

/**
 * 入队。同一个 key:
 *  - 主人不要过 / 三天没回过(哪一版都算)⇒ 不再提('closed');
 *  - 这一版(key + hash)主人批过 ⇒ 'same',并撤下这个 key 还开着的别的版本 —— 不然 批过 H1 → 排着 H2 → 又来 H1
 *    会把 H2 改写回 H1、再问一遍批过的(整合者评审 #659);
 *  - 还开着 ⇒ 同一版不动;内容变了 ⇒ 换成新的一版、从头排(旧编号作废);
 *  - 只有批过的别的版本 ⇒ 另起一条等重批。
 */
export function enqueue(s: OwnerAsksState, i: EnqueueInput, o: { nowIso: string; hash: string; id: string }): { state: OwnerAsksState; result: EnqueueResult; item: OwnerAsk } {
  const same = s.items.filter(x => x.key === i.key)
  const closed = [...same].reverse().find(x => x.status === 'declined' || x.status === 'unanswered')
  if (closed) return { state: s, result: 'closed', item: closed }
  const approved = same.find(x => x.status === 'approved' && x.hash === o.hash)
  if (approved) {
    const stale = new Set(same.filter(isOpen).map(x => x.id))
    if (!stale.size) return { state: s, result: 'same', item: approved }
    return { state: { items: s.items.filter(x => !stale.has(x.id)), batch: dropFromBatch(s.batch, stale) }, result: 'same', item: approved }
  }
  const fresh = (): OwnerAsk => ({
    id: o.id, key: i.key, question: oneLine(i.question, 200), recommend: oneLine(i.recommend, 200),
    ...(i.evidence ? { evidence: i.evidence.slice(0, 2000) } : {}),
    source: i.source, priority: i.priority ?? 0, hash: o.hash, createdAt: o.nowIso, status: 'queued', asks: [],
  })
  const open = [...same].reverse().find(isOpen)
  if (!open) { const item = fresh(); return { state: { ...s, items: [...s.items, item] }, result: 'added', item } }
  if (open.hash === o.hash) return { state: s, result: 'same', item: open }
  // 开着的换新版:id 留着(同一件事),内容、hash 换掉,问过的天数清零,从上一份早报的编号里摘掉。
  const item: OwnerAsk = { ...fresh(), id: open.id, createdAt: open.createdAt }
  return { state: { items: s.items.map(x => (x === open ? item : x)), batch: dropFromBatch(s.batch, new Set([open.id])) }, result: 'updated', item }
}

/** 问满三天还没回的 ⇒ 记成「主人没要」。早报挑之前先过这一道。 */
export function expireStale(s: OwnerAsksState, nowIso: string): OwnerAsksState {
  let changed = false
  const items = s.items.map(a => {
    if (a.status !== 'asked' || a.asks.length < ASK_MAX_DAYS) return a
    changed = true
    return { ...a, status: 'unanswered' as const, answer: { verdict: 'unanswered' as const, by: 'cc', at: nowIso, hash: a.hash, via: 'expired' as const } }
  })
  return changed ? { ...s, items } : s
}

export interface PickedAsk { no: number; id: string; hash: string; question: string; recommend: string }

/**
 * 今天的早报接哪几条(不改状态;发出去了再 commitAsked)。问过的先(接着问到第三天),再按 priority、先来后到。
 * `base` = 早报里已有的拍板项条数,编号从 base + 1 起。
 */
export function pickForBrief(s: OwnerAsksState, base: number, max = ASKS_PER_BRIEF): PickedAsk[] {
  const open = s.items.filter(isOpen)
  const asked = open.filter(a => a.status === 'asked').sort((a, b) => (a.asks[0] ?? a.createdAt).localeCompare(b.asks[0] ?? b.createdAt))
  const queued = open.filter(a => a.status === 'queued').sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt))
  return [...asked, ...queued].slice(0, Math.max(0, max)).map((a, i) => ({ no: Math.max(0, base) + i + 1, id: a.id, hash: a.hash, question: a.question, recommend: a.recommend }))
}

/** 早报真发出去、这一段真接上了 ⇒ 记成问过一次,编号存成这一份的。中途换了版的那条(hash 对不上)不记。 */
export function commitAsked(s: OwnerAsksState, picked: readonly PickedAsk[], nowIso: string): OwnerAsksState {
  const byId = new Map(picked.map(p => [p.id, p]))
  const nos: Record<string, string> = {}
  const items = s.items.map(a => {
    const p = byId.get(a.id)
    if (!p || !isOpen(a) || a.hash !== p.hash) return a
    nos[String(p.no)] = a.id
    return { ...a, status: 'asked' as const, asks: [...a.asks, nowIso] }
  })
  return { items, batch: Object.keys(nos).length ? { at: nowIso, nos } : s.batch }
}

/** 接在早报里的那一段:每条一行问题 + 一行推荐,最后一行说怎么回。 */
export function renderAsksBlock(picked: readonly PickedAsk[]): string {
  if (!picked.length) return ''
  const first = picked[0]!.no
  return [
    '要你拍板的(CC 自己找到的):',
    ...picked.flatMap(p => [`${p.no}. ${p.question}`, `   推荐:${p.recommend}`]),
    `回「${first}」就是要,「${first} 不要」就是不要;不回就先放着,问满三天不再提。`,
  ].join('\n')
}

/** 把那一段接进模型写的早报:占位行处;没有占位 ⇒ 「就这些。」那一行前面;再没有 ⇒ 末尾。多出来的占位行删掉。 */
export function spliceAsks(text: string, block: string): string {
  const isMark = (l: string) => l.trim() === ASK_PLACEHOLDER
  const lines = text.split('\n')
  const at = block ? lines.findIndex(isMark) : -1
  const clean = (ls: string[]) => ls.filter(l => !isMark(l)).map(l => l.split(ASK_PLACEHOLDER).join(''))
  if (!block) return clean(lines).join('\n')
  if (at >= 0) return [...clean(lines.slice(0, at)), block, ...clean(lines.slice(at + 1))].join('\n')
  const rest = clean(lines)
  let end = rest.length
  while (end > 0 && rest[end - 1]!.trim() === '') end--
  const body = rest.slice(0, end)
  const last = body[body.length - 1]?.trim() ?? ''
  // 不插空行:空行会被分成两条气泡,这一段跟早报是一条消息。
  if (/^就这些[。.]?$/.test(last)) return [...body.slice(0, -1), block, body[body.length - 1]!].join('\n')
  return [...body, block].join('\n')
}

const YES = /^(?:要|好|好的|可以|行|做|同意|批|ok|y|yes)$/i
const NO = /^(?:不要|不用|不行|不做|别做|别|算了|不|no|n)$/i

/** 「2」「2 要」⇒ 要;「2 不要」「2不」⇒ 不要。别的不认(交给普通聊天)。 */
export function parseAskReply(text: string): { no: number; verdict: 'approved' | 'declined' } | null {
  const m = /^\s*(\d{1,2})\s*[.、:：,，]?\s*(\S*?)\s*[。.!！]?\s*$/.exec(text)
  if (!m) return null
  const no = Number(m[1])
  const word = m[2] ?? ''
  if (!word || YES.test(word)) return { no, verdict: 'approved' }
  if (NO.test(word)) return { no, verdict: 'declined' }
  return null
}

/**
 * 最近一份早报里这个编号指的那条:窗口内、**还在等回**。答过的 ⇒ null —— 再回一次「2」就是普通聊天,
 * 不拿「已经回过了」把它吞掉(整合者评审 #659)。
 */
export function lookupAsk(s: OwnerAsksState, no: number, nowMs: number): OwnerAsk | null {
  const b = s.batch
  if (!b || !(nowMs - Date.parse(b.at) <= ASK_REPLY_WINDOW_MS)) return null
  const id = b.nos[String(no)]
  const a = id ? s.items.find(x => x.id === id) : undefined
  return a && a.status === 'asked' ? a : null
}

export type AnswerResult = { result: 'recorded'; item: OwnerAsk } | { result: 'none' }

/** 记下主人的回答(谁、什么时候、批的是哪一版)。 */
export function answerAsk(s: OwnerAsksState, a: { no: number; verdict: 'approved' | 'declined'; by: string; nowIso: string }): { state: OwnerAsksState; r: AnswerResult } {
  const item = lookupAsk(s, a.no, Date.parse(a.nowIso))
  if (!item) return { state: s, r: { result: 'none' } }
  const next: OwnerAsk = { ...item, status: a.verdict, answer: { verdict: a.verdict, by: a.by, at: a.nowIso, hash: item.hash, via: 'wechat_brief' } }
  return { state: { ...s, items: s.items.map(x => (x.id === item.id ? next : x)) }, r: { result: 'recorded', item: next } }
}

/** 这一版(key + hash)主人批过没有 —— 第 7 步自动执行之前查它;现在只给 `self ask --list` 和测试用。 */
export function approvalFor(s: OwnerAsksState, key: string, hash: string): OwnerAskAnswer | null {
  const a = s.items.find(x => x.key === key && x.hash === hash && x.status === 'approved')
  return a?.answer ?? null
}

const STATUS_WORD: Record<OwnerAskStatus, string> = { queued: '排着', asked: '问过', approved: '主人要', declined: '主人不要', unanswered: '主人没要' }

/** 人读的清单(`self ask --list`;以后「有什么要我拍板的」也用这一份)。开着的在前。 */
export function formatAsks(s: OwnerAsksState, o: { all?: boolean } = {}): string {
  const shown = o.all ? s.items : s.items.filter(isOpen)
  if (!shown.length) return o.all ? '还没有要主人拍板的候选。' : '没有在等主人拍板的候选。'
  const order = [...shown].sort((a, b) => Number(isOpen(b)) - Number(isOpen(a)))
  return order.map(a => {
    const asked = a.asks.length ? `,问过 ${a.asks.length} 天` : ''
    const ans = a.answer ? `,${a.answer.at.slice(0, 16).replace('T', ' ')}` : ''
    return `${a.id} · ${STATUS_WORD[a.status]}${asked}${ans} · ${a.question}\n    推荐:${a.recommend}${a.evidence ? `\n    证据:${oneLine(a.evidence, 120)}` : ''}`
  }).join('\n')
}

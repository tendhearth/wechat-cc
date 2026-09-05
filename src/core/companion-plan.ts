/**
 * 伙伴日程判断(spec 2026-09-05-companion-plan):冷却到了不再「马上做」,
 * 先问伙伴一句「现在要不要」。这里是纯的部分 —— 候选集、prompt、fail-closed
 * 解析、回退顺序、退避;I/O 与执行在 tick-bodies.ts。
 *
 * 红线:模型只能在通过了 shouldSpeak 的候选里选,或选 none;候选外一律降级。
 * 冷却 / care 档 / 无回复暂停只在 calibration.ts,这里不复制一行。
 *
 * 纯:不引 daemon;shouldSpeak 由调用方注入(tick-bodies 传 calibration.shouldSpeak)。
 */

// 与 calibration.ts 结构一致,故意在此镜像一份,让 core 不引 daemon。
export type CareLevel = 'off' | 'low' | 'high'
export interface CareLedgerEntry {
  lastProactiveAtIso?: string
  lastHuntAtIso?: string
  lastVisitAtIso?: string
  noReplyCount: number
}

export type SpeakGate = (args: {
  kind: 'hunt' | 'visit' | 'gap'
  level: CareLevel
  nowIso: string
  ledger: CareLedgerEntry
  lastInboundAtIso?: string
}) => { ok: true } | { ok: false; reason: string }

export type PlanAction = 'hunt' | 'visit' | 'gap' | 'none'
export const PLAN_REASK_MS = 90 * 60_000
export const PLAN_EVAL_TIMEOUT_MS = 20_000
export const PLAN_MAX_OBSERVATIONS = 3
export const PLAN_OBSERVATION_CHARS = 80
export const PLAN_PERSONA_CHARS = 300
export const PLAN_JOURNAL_ITEMS = 3
export const PLAN_TITLE_CHARS = 40
export const PLAN_WHY_CHARS = 120
export const PLAN_EARLIER_ITEMS = 5
export const PLAN_PROVEN_MAX = 5

const ACTIONS: readonly PlanAction[] = ['hunt', 'visit', 'gap', 'none']
const FALLBACK_ORDER: ReadonlyArray<Exclude<PlanAction, 'none'>> = ['hunt', 'visit', 'gap']

export interface Candidate { action: Exclude<PlanAction, 'none'> }
export interface Rejected { action: Exclude<PlanAction, 'none'>; reason: string }
export interface CandidateInput {
  isOwnerChat: boolean
  level: CareLevel
  prefs: { hunt?: boolean; visit?: boolean }
  socialWired: boolean
  nowIso: string
  ledger: CareLedgerEntry
  lastInboundAtIso?: string
}

export function computeCandidates(i: CandidateInput, decide: SpeakGate): { candidates: Candidate[]; rejected: Rejected[] } {
  const candidates: Candidate[] = []
  const rejected: Rejected[] = []
  const consider = (action: Exclude<PlanAction, 'none'>, level: CareLevel) => {
    const d = decide({ kind: action, level, nowIso: i.nowIso, ledger: i.ledger, lastInboundAtIso: i.lastInboundAtIso })
    if (d.ok) candidates.push({ action })
    else rejected.push({ action, reason: d.reason })
  }
  if (i.isOwnerChat) {
    // 与 tick-bodies 原逻辑一致:pref 明确 false → off,否则 low;care off 由 level 传入时 shouldSpeak 自己拒。
    consider('hunt', i.level === 'off' ? 'off' : (i.prefs.hunt !== false ? 'low' : 'off'))
    if (i.socialWired) consider('visit', i.level === 'off' ? 'off' : (i.prefs.visit !== false ? 'low' : 'off'))
  }
  consider('gap', i.level)
  return { candidates, rejected }
}

export interface PlanContext {
  nowLocal: string
  ownerLastInboundMinutesAgo: number | null
  today: { lastHuntHoursAgo: number | null; lastVisitHoursAgo: number | null; lastProactiveHoursAgo: number | null }
  candidates: Candidate[]
  rejected: Rejected[]
  journal: { unread: number; latest: Array<{ kind: string; title: string; ts: string }> } | null
  social: { openWishes: number; pendingOffers: number; provenChannels: Array<{ id: string; label: string }> } | null
  observations: Array<{ tone: string | null; body: string }>
  personaExcerpt: string
  earlierToday: Array<{ at: string; decision: PlanAction; why: string }>
}

const cut = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s)

export function buildPlanPrompt(ctx: PlanContext): string {
  const journal = ctx.journal
    ? { unread: ctx.journal.unread, latest: ctx.journal.latest.slice(0, PLAN_JOURNAL_ITEMS).map(x => ({ kind: x.kind, title: cut(x.title, PLAN_TITLE_CHARS), ts: x.ts })) }
    : '没接线'
  const social = ctx.social
    ? { openWishes: ctx.social.openWishes, pendingOffers: ctx.social.pendingOffers, provenChannels: ctx.social.provenChannels.slice(0, PLAN_PROVEN_MAX) }
    : '没接线'
  const observations = ctx.observations.slice(-PLAN_MAX_OBSERVATIONS).map(o => ({ tone: o.tone, body: cut(o.body, PLAN_OBSERVATION_CHARS) }))
  const earlier = ctx.earlierToday.slice(-PLAN_EARLIER_ITEMS).map(e => ({ at: e.at, decision: e.decision, why: cut(e.why, PLAN_WHY_CHARS) }))
  return [
    '你是伙伴自己。下面是此刻的处境,请判断现在要不要出门做一件事。',
    '可选的只有 candidates 里列出的动作(hunt=替主人去网上打猎、visit=去朋友的伙伴家串门、gap=主人好久没说话了问候一句);不想做就 "none"。理由一句话,写给自己看。',
    '判断时想想:主人是不是正在跟你聊(几分钟内有入站就别打扰);今天已经做过什么;包袱里是不是已经堆了主人没看的东西(堆着就别再往里塞);现在这个时间点合不合适;earlierToday 里你之前怎么想的,别每拍都翻来覆去。',
    '只输出 JSON,不要 Markdown、解释、额外字段:{"action":"hunt"|"visit"|"gap"|"none","why":"…"};action 是 visit 时可加 "target",只能是 social.provenChannels 里某一项的 id。',
    '【当前】', JSON.stringify({ nowLocal: ctx.nowLocal, ownerLastInboundMinutesAgo: ctx.ownerLastInboundMinutesAgo }),
    '【今天】', JSON.stringify(ctx.today),
    '【候选】', JSON.stringify(ctx.candidates.map(c => c.action)),
    '【被拒的】', JSON.stringify(ctx.rejected),
    '【包袱】', JSON.stringify(journal),
    '【社交】', JSON.stringify(social),
    '【最近观察】', JSON.stringify(observations),
    '【我的表达倾向】', JSON.stringify(cut(ctx.personaExcerpt, PLAN_PERSONA_CHARS)),
    '【今天之前的判断】', JSON.stringify(earlier),
  ].join('\n')
}

export interface Plan { action: PlanAction; why: string; target?: string }

export function parsePlan(raw: string): { ok: true; plan: Plan } | { ok: false; reason: string } {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  let v: unknown
  try { v = JSON.parse(text) } catch { return { ok: false, reason: 'not_json' } }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, reason: 'not_object' }
  const o = v as Record<string, unknown>
  for (const k of Object.keys(o)) if (k !== 'action' && k !== 'why' && k !== 'target') return { ok: false, reason: `unknown_field:${k}` }
  if (typeof o.action !== 'string' || !ACTIONS.includes(o.action as PlanAction)) return { ok: false, reason: 'bad_action' }
  if (typeof o.why !== 'string' || o.why.length === 0 || o.why.length > PLAN_WHY_CHARS) return { ok: false, reason: 'bad_why' }
  if (o.target !== undefined && typeof o.target !== 'string') return { ok: false, reason: 'bad_target' }
  const plan: Plan = { action: o.action as PlanAction, why: o.why }
  if (typeof o.target === 'string') plan.target = o.target
  return { ok: true, plan }
}

export function pickFallback(candidates: Candidate[]): Exclude<PlanAction, 'none'> | null {
  const have = new Set(candidates.map(c => c.action))
  return FALLBACK_ORDER.find(a => have.has(a)) ?? null
}

export function constrainPlan(plan: Plan, candidates: Candidate[], provenIds: readonly string[]): { plan: Plan; downgraded: boolean } {
  if (plan.action === 'none') return { plan: { action: 'none', why: plan.why }, downgraded: false }
  if (!candidates.some(c => c.action === plan.action)) return { plan: { action: 'none', why: plan.why }, downgraded: true }
  const out: Plan = { action: plan.action, why: plan.why }
  if (plan.action === 'visit' && plan.target && provenIds.includes(plan.target)) out.target = plan.target
  return { plan: out, downgraded: false }
}

export interface PlanLogEntry { at: string; chatId: string; candidates: PlanAction[]; decision: PlanAction; why: string; source: 'model' | 'fallback' | 'downgraded' }

export function shouldReask(entries: readonly PlanLogEntry[], chatId: string, nowMs: number): boolean {
  const last = [...entries].reverse().find(e => e.chatId === chatId)
  if (!last || last.source !== 'model' || last.decision !== 'none') return true
  const at = Date.parse(last.at)
  if (Number.isNaN(at)) return true
  return nowMs - at >= PLAN_REASK_MS
}

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

export function formatLocal(nowIso: string, tz?: string): string {
  const d = new Date(nowIso)
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short' })
  const parts = Object.fromEntries(fmt.formatToParts(d).map(p => [p.type, p.value]))
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(d)
  const idx = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd)
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} 周${WEEKDAYS[idx] ?? '?'}`
}

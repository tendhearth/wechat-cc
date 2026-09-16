/**
 * task-reference — 主人在微信里说的那句话,指的是哪件事。
 *
 * 管家原则(导览 §离开电脑):能确定就办并复述归属;不确定就问;永远不默默押注
 * "最近一件"。"不确定"也不等于"必须背编号"。解析在**活跃候选**(进行中 / 已答复 /
 * 排队)里做,历史任务不参与。
 *
 * 顺序,从最硬到最软:
 *   ① 引用锚   —— 主人引用了 CC 发过的任务消息(消息头带「任务 <编号>」)。确定性。
 *   ② 显式编号 —— 正文带 8 位编号。确定性。
 *   ③ 名称     —— 项目名 / 目录名 / 标题片段在候选里唯一命中;执行者名只用来在
 *                  命中里排歧,单独出现不定位(主人不该需要知道谁在做)。
 *   ④ 焦点     —— 主人声明过"接下来说 X"且未过期。声明不是猜。
 *   ⑤ 模型     —— 便宜模型只能从候选里选一个或说"不确定";名称命中多件时用它排歧,
 *                  零命中且无焦点时用它判断"这是不是在说任务"。它挂了就当没有。
 * 落不定:多件 ⇒ ambiguous(带选项);零件 ⇒ none(交回普通聊天,不劫持)。
 *
 * 纯函数,零 I/O;渠道无关 —— 微信和以后的手机 app 都是它的前端。
 */

export interface TaskCandidate {
  id: string
  title: string
  /** 项目显示名(通常是目录名)。 */
  project: string
  path: string
  providerId: string
  phase: string
  updatedAt: number
  /** 终态错误码(如 provider_quota_exhausted);管家据此认出"因额度失败的那件"。 */
  error?: string | null
}
export interface FocusState { taskId: string; expiresAt: number }
export type TaskJudge = (input: { text: string; candidates: TaskCandidate[] }) => Promise<{ taskId: string | null; confident: boolean }>
export interface ResolveInput {
  text: string
  quotedText?: string | null
  focus?: FocusState | null
  nowMs: number
  candidates: TaskCandidate[]
  judge?: TaskJudge
}
export type Resolution =
  | { kind: 'task'; taskId: string; via: 'quote' | 'id' | 'name' | 'focus' | 'judge' }
  | { kind: 'set_focus'; taskId: string; via: 'name' | 'id' }
  | { kind: 'ambiguous'; options: TaskCandidate[] }
  | { kind: 'none' }

export const FOCUS_TTL_MS = 20 * 60_000

const TASK_ID = /\b([a-f0-9]{8})\b/i
/** 「任务 <编号>」,或详情回复里的「标题 · <编号>」—— 两种 CC 出站格式都能当锚。 */
const HEADER_ID = /(?:任务\s+|·\s*)([a-f0-9]{8})(?![a-f0-9])/i
const FOCUS_DECL = /^(?:现在|接下来|先|下面)(?:说|聊|谈|讲)\s*(.+?)\s*[。.!！]?$/
/** 太泛的二字词,命中它们不算数。 */
const STOP = new Set(['一个', '那个', '这个', '一下', '什么', '怎么', '可以', '不要', '一件', '这件', '那件', '回答', '只列'])
const PROVIDER_WORDS: Record<string, string[]> = {
  claude: ['claude', '克劳德'], codex: ['codex'], openai: ['api', 'qwen', 'deepseek', 'kimi'], cursor: ['cursor'], agy: ['agy', 'gemini'],
}

/** CC 发出的每条任务消息都带「任务 <编号>」;引用它就是在指它。 */
export function parseTaskIdFromMessage(text: string): string | null {
  const m = HEADER_ID.exec(text)
  return m ? m[1]!.toLowerCase() : null
}

/** "现在说 X" / "接下来说 X" ⇒ 返回 X;不是声明 ⇒ null。 */
export function focusDeclaration(text: string): string | null {
  const m = FOCUS_DECL.exec(text.trim())
  return m ? m[1]!.trim() || null : null
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()
const basename = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''

/** 候选的可检索关键词:ASCII 词(去扩展名)+ 中文片段的二字词。 */
function keywords(c: TaskCandidate): Set<string> {
  const out = new Set<string>()
  const add = (w: string) => { if (w.length >= 2 && !STOP.has(w)) out.add(w) }
  for (const src of [c.project, basename(c.path)]) { const w = norm(src); if (w) add(w) }
  const text = `${c.title}`
  for (const ascii of text.toLowerCase().match(/[a-z0-9][a-z0-9_-]*/g) ?? []) add(ascii.replace(/\.[a-z0-9]+$/, ''))
  for (const seg of text.split(/[^\p{Script=Han}]+/u)) {
    for (let i = 0; i + 2 <= seg.length; i++) add(seg.slice(i, i + 2))
  }
  return out
}

function scoreAll(text: string, candidates: TaskCandidate[]): Map<string, number> {
  const t = norm(text)
  const scores = new Map<string, number>()
  for (const c of candidates) {
    let n = 0
    for (const k of keywords(c)) if (t.includes(k)) n += /^[a-z0-9]/.test(k) ? 2 : 1
    if (n > 0) scores.set(c.id, n)
  }
  return scores
}

function mentionsProvider(text: string, providerId: string): boolean {
  const t = norm(text)
  return (PROVIDER_WORDS[providerId] ?? [providerId]).some(w => t.includes(w))
}

/** 名称匹配:返回最高分的候选集合(可能 0 / 1 / 多)。 */
function byName(text: string, candidates: TaskCandidate[]): TaskCandidate[] {
  const scores = scoreAll(text, candidates)
  if (!scores.size) return []
  const top = Math.max(...scores.values())
  let hits = candidates.filter(c => scores.get(c.id) === top)
  if (hits.length > 1) {
    const named = hits.filter(c => mentionsProvider(text, c.providerId))
    if (named.length === 1) hits = named
  }
  return hits
}

const inCandidates = (id: string | null, cs: TaskCandidate[]) => !!id && cs.some(c => c.id === id.toLowerCase())

async function askJudge(judge: TaskJudge | undefined, text: string, candidates: TaskCandidate[]): Promise<string | null> {
  if (!judge || !candidates.length) return null
  try {
    const v = await judge({ text, candidates })
    return v.confident && inCandidates(v.taskId, candidates) ? v.taskId!.toLowerCase() : null
  } catch {
    return null
  }
}

export async function resolveTaskReference(input: ResolveInput): Promise<Resolution> {
  const { candidates } = input
  if (!candidates.length) return { kind: 'none' }

  const quoted = input.quotedText ? parseTaskIdFromMessage(input.quotedText) : null
  if (quoted && inCandidates(quoted, candidates)) return { kind: 'task', taskId: quoted, via: 'quote' }

  const decl = focusDeclaration(input.text)
  if (decl !== null) {
    const id = TASK_ID.exec(decl)?.[1]?.toLowerCase()
    if (id && inCandidates(id, candidates)) return { kind: 'set_focus', taskId: id, via: 'id' }
    const hits = byName(decl, candidates)
    if (hits.length === 1) return { kind: 'set_focus', taskId: hits[0]!.id, via: 'name' }
    return { kind: 'ambiguous', options: hits.length ? hits : candidates }
  }

  const explicit = TASK_ID.exec(input.text)?.[1]?.toLowerCase()
  if (explicit && inCandidates(explicit, candidates)) return { kind: 'task', taskId: explicit, via: 'id' }

  const hits = byName(input.text, candidates)
  if (hits.length === 1) return { kind: 'task', taskId: hits[0]!.id, via: 'name' }
  if (hits.length > 1) {
    const picked = await askJudge(input.judge, input.text, hits)
    return picked ? { kind: 'task', taskId: picked, via: 'judge' } : { kind: 'ambiguous', options: hits }
  }

  const focus = input.focus
  if (focus && focus.expiresAt > input.nowMs && inCandidates(focus.taskId, candidates)) return { kind: 'task', taskId: focus.taskId, via: 'focus' }

  const picked = await askJudge(input.judge, input.text, candidates)
  return picked ? { kind: 'task', taskId: picked, via: 'judge' } : { kind: 'none' }
}

/**
 * 把便宜模型包成裁判:它只能回一个编号(1..n)或 0(不是在说任务)。
 * 单独一个数字才算数;夹杂多个数字、超范围、空回答 ⇒ 没把握(调用方就会去问主人)。
 */
export function makeCheapJudge(cheapEval: (prompt: string) => Promise<string>): TaskJudge {
  return async ({ text, candidates }) => {
    const list = candidates.map((c, i) => `${i + 1}. ${c.project} · ${c.title}（${c.providerId}，${c.phase}）`).join('\n')
    const prompt = `主人在微信里对管家说了一句话,判断它指的是下面哪一件正在进行的事。\n只回一个数字:候选编号,或 0 表示这句话不是在说任何一件事(闲聊、别的话题)。拿不准就回 0。\n\n候选:\n${list}\n\n主人的话:「${text}」\n\n数字:`
    const answer = (await cheapEval(prompt)).trim()
    const numbers = answer.match(/\d+/g) ?? []
    if (numbers.length !== 1) return { taskId: null, confident: false }
    const n = Number(numbers[0])
    if (n === 0) return { taskId: null, confident: true }
    const c = candidates[n - 1]
    return c ? { taskId: c.id, confident: true } : { taskId: null, confident: false }
  }
}

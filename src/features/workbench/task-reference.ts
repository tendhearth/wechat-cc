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
  /** 来自 provider registry 的名字、显示名和已登记模型别名。 */
  handoffExecutors?: readonly string[]
  /** 模型判断的上限;超时当作没把握。主人的消息不能被一个慢网关卡住。 */
  judgeTimeoutMs?: number
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
const STOP = new Set(['一个', '那个', '这个', '一下', '什么', '怎么', '可以', '不要', '一件', '这件', '那件', '回答', '只列', '本周', '整理', '一句', '一份', '文件', '不用', '然后'])
/** 零命中时才问模型,而且只在这句话有"任务感"时问 —— 普通聊天不付一次 LLM 往返。 */
const TASK_CUE = /(任务|那件|这件|哪件|项目|继续|进展|结果|成果|怎么样|做完|好了吗|弄完|做好|接着|停止|交给|换人)/
const JUDGE_TIMEOUT_MS = 3000
/**
 * 这句话是不是在说「把这件事转给另一位执行者」。是 ⇒ 不当补充塞给原执行者,交回 CC 的对话(由它调接力工具并走主人确认)。
 *
 * 精确优先:判错成「是」会把日常补充从执行者手里劫走,判错成「不是」只是主人换个说法再说一遍。所以只认
 * 「转交动词 + 已登记的执行者 + 干净的收尾」这一种句式,其余一律不是。三段都由下面的表定:
 *   - 动词:交给 / 转给 / 改由 / 换(成) 可以不带后续动作;让 / 给 / 「X 来」必须带(「让 Claude」本身不成句)。
 *   - 执行者:只认登记过的名字,去掉泛称(api);名字后面紧跟字母数字、路径、「的」都不算(codex 的配置、claude-style)。
 *   - 收尾:名字之后到分句结束只能是「(来)接着做 / 继续 / 接手…」+ 可选的「这件 / 剩下的 / 后半段 / 事项 <id> 的后半段」
 *     + 可选语气词或一句短问(吧 / 了 / 行吗 / 会不会更快)。出现别的内容(「之前先补测试」「闪烁的 bug」「一个头像」)就不是。
 * 否定(别 / 不要 / 先不…)、引号里的文案、「文档里写:…」这类转述不算。显式写出 matter_handoff 按协议算。
 */
const HANDOFF_GENERIC_NAMES = new Set(['api'])
const HANDOFF_VERB = '(?:做|处理|完成|干|弄|写|改|跑|负责)'
const HANDOFF_ACTION = `(?:来|去)?(?:(?:接着|继续|接手|接管)${HANDOFF_VERB}?(?:下去|完)?|${HANDOFF_VERB}|试试|看看)`
const HANDOFF_OBJECT = '(?:(?:任务|事项)? ?[a-f0-9]{8}|这个(?:修复|任务|活)?|这件事?|这一?步|它|剩下的?(?:部分|活)?|后面的?(?:部分|活)?|后续|[前后上下]半段)'
const HANDOFF_ENDING = '(?:吧|了|啊|呀|嘛|好了|一下|就行|即可|试试|看看|行吗|可以吗|好吗|好不好|行不行|怎么样|如何|(?:会不会|是不是|能不能)[^的 ]{0,6})'
const HANDOFF_NEGATION = /(?:别|不要|不用|不必|无需|禁止|停止|取消|不再|不能|不该|不是|先不|没有?|为什么不|不(?=交|转|换|让|给|改由)|\bdon'?t\b|\bdo not\b|\bnever\b|\bstop\b|\bno need\b|\bnot\b)/i
/** 冒号前以这些结尾 ⇒ 冒号后是被转述 / 被引用的文字,不是对 CC 说的话。 */
const HANDOFF_REPORTED = /(?:写上?|写着|写道|文案|注释|提示|显示|出现|叫做?|名为|标题|字样|原文是?|改成|改为|(?<!意思)是|为|输入用?|says?|said|reads?|shows?|to|as)$/i
const HANDOFF_QUOTED = /“[^”]{0,200}”|‘[^’]{0,200}’|「[^」]{0,200}」|『[^』]{0,200}』|`[^`]{0,200}`|"[^"]{0,200}"|'[^']{0,200}'/g
/** 归一:全角转半角、弯引号的撇号转直的、连续空白并成一个空格(也去掉了正则回溯的空间)、过长的只看开头。 */
const handoffNormalize = (text: string) => text.normalize('NFKC').replace(/[’ʼ]/g, "'").replace(/\s+/g, ' ').trim().slice(0, 400)
export function isTaskHandoffRequest(text: string, executors: readonly string[] = []): boolean {
  const normalized = handoffNormalize(text)
  const unquoted = normalized.replace(HANDOFF_QUOTED, ' ')
  const sentences = unquoted.split(/[。！？!?；;\n]|\.(?= |$)/).map(part => part.trim()).filter(Boolean)
  const clausesOf = (sentence: string) => {
    // 「文档里写:交给 Claude 接着做」是转述:冒号前以「写 / 文案 / 出现 / says…」结尾的,冒号后不看。
    const colon = sentence.search(/[:：]/)
    const body = colon >= 0 && HANDOFF_REPORTED.test(sentence.slice(0, colon).trim()) ? sentence.slice(0, colon) : sentence
    return body.split(/[,，:：]/).map(part => part.trim()).filter(Boolean)
  }
  const negated = (clause: string, index: number) => HANDOFF_NEGATION.test(clause.slice(0, index).split(/而是|但是|不过/).at(-1) ?? '')
  // 显式工具名:只有「调用 / 用 / call…」它才算请求;提到函数名、要改名、说别调用都不是。
  const TOOL = /(?:调用|使用|用|执行|走|call|use|run|invoke) ?`?matter_handoff(?![a-z0-9_])/i
  for (const sentence of sentences) for (const clause of clausesOf(sentence)) {
    const m = TOOL.exec(clause)
    if (m && !negated(clause, m.index)) return true
  }
  const names = [...new Set(executors.map(n => handoffNormalize(n).toLowerCase()).filter(n => n && !HANDOFF_GENERIC_NAMES.has(n)))]
    .sort((a, b) => b.length - a.length)
    .map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  if (!names.length) return false
  const name = `@?(?:${names.join('|')})(?![a-z0-9_./@-])`
  const rest = (actionRequired: boolean) => `(?: ?${HANDOFF_ACTION})${actionRequired ? '' : '?'}(?: ?${HANDOFF_OBJECT})?(?: ?的 ?${HANDOFF_OBJECT})?(?: ?${HANDOFF_ENDING})?$`
  const forms = [
    `(?<!提)(?:交给|转给|改由) ?${name}${rest(false)}`,
    `换(?:成|个)? ?${name}${rest(false)}`,
    `(?<![交转提])(?:让|给|由|请) ?${name}${rest(true)}`,
    // 名字打头必须带「来」:「Claude 跑了」「Codex 继续」是在说现状或对当前执行者说话,不是换人。
    `(?<![a-z0-9_.@/-])${name} ?来(?:(?:接着|继续|接手|接管)${HANDOFF_VERB}?|${HANDOFF_VERB}|试试)(?:下去|完)?(?: ?${HANDOFF_OBJECT})?(?: ?${HANDOFF_ENDING})?$`,
    `\\b(?:switch|reassign(?: (?:it|this|this task|the task))?|hand(?: (?:it|this))? off|hand(?: (?:it|this))? over|pass(?: (?:it|this))?) to ${name}(?: (?:please|now))?$`,
    `\\b(?:let|can|could) ${name} (?:take (?:it |this )?over|continue|finish(?: (?:it|this))?)(?: (?:please|now|from here))?$`,
  ].map(f => new RegExp(f, 'i'))
  for (const sentence of sentences) for (const clause of clausesOf(sentence)) {
    for (const form of forms) {
      const m = form.exec(clause)
      if (m && !negated(clause, m.index)) return true
    }
  }
  return false
}

/** 新建命令里的任务正文照旧处理；仅已有事项的显式接力让路。 */
export const isTaskHandoffCommand = (text: string, executors: readonly string[] = []): boolean => /^(?:任务|\/task)\s+[a-f0-9]{8}\s+/i.test(text.trim()) && isTaskHandoffRequest(text, executors)
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

/**
 * 有把握才算命中(评审 2026-09-16:单个泛二字词命中会把"本周有空吗"吞成任务):
 * 要么至少一个强关键词(项目名 / 目录名 / ASCII 词),要么至少两个不同的标题片段。
 */
function scoreAll(text: string, candidates: TaskCandidate[]): Map<string, number> {
  const t = norm(text)
  const scores = new Map<string, number>()
  for (const c of candidates) {
    let strong = 0, weak = 0
    for (const k of keywords(c)) if (t.includes(k)) { if (/^[a-z0-9]/.test(k)) strong++; else weak++ }
    // 单个标题片段只在这句话本身有"任务感"时算数:「检查那件怎么说」算,「我周三有个会」不算。
    if (strong >= 1 || weak >= 2 || (weak === 1 && TASK_CUE.test(text))) scores.set(c.id, strong * 2 + weak)
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

async function askJudge(judge: TaskJudge | undefined, text: string, candidates: TaskCandidate[], timeoutMs = JUDGE_TIMEOUT_MS): Promise<string | null> {
  if (!judge || !candidates.length) return null
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const v = await Promise.race([
      judge({ text, candidates }),
      new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), timeoutMs) }),
    ])
    if (!v) return null
    return v.confident && inCandidates(v.taskId, candidates) ? v.taskId!.toLowerCase() : null
  } catch {
    return null
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function resolveTaskReference(input: ResolveInput): Promise<Resolution> {
  if (isTaskHandoffRequest(input.text, input.handoffExecutors)) return { kind: 'none' }
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
    if (hits.length > 1) return { kind: 'ambiguous', options: hits }
    // "先说一下,明天我不在"也长得像声明;落不到任务就当普通聊天,不把全部候选列出来问。
  }

  const explicit = TASK_ID.exec(input.text)?.[1]?.toLowerCase()
  if (explicit && inCandidates(explicit, candidates)) return { kind: 'task', taskId: explicit, via: 'id' }

  const hits = byName(input.text, candidates)
  if (hits.length === 1) return { kind: 'task', taskId: hits[0]!.id, via: 'name' }
  if (hits.length > 1) {
    const picked = await askJudge(input.judge, input.text, hits, input.judgeTimeoutMs)
    return picked ? { kind: 'task', taskId: picked, via: 'judge' } : { kind: 'ambiguous', options: hits }
  }

  const focus = input.focus
  if (focus && focus.expiresAt > input.nowMs && inCandidates(focus.taskId, candidates)) return { kind: 'task', taskId: focus.taskId, via: 'focus' }

  if (!TASK_CUE.test(input.text)) return { kind: 'none' }
  const picked = await askJudge(input.judge, input.text, candidates, input.judgeTimeoutMs)
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

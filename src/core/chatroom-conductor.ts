/**
 * chatroom-conductor — pure prompt builders + tolerant parsers for the /chat
 * debate. No LLM / SDK here; the coordinator runs the agents and calls
 * deps.haikuEval for the cheap structural beats (contention map, convergence)
 * and deps.verdictEval for the synthesis.
 *
 * ── 2026-09 改造:把 prompt 里的散文意图变成结构 ──────────────────────────
 *
 * 改造前是一场对称的自由辩论:每个模型都拿到**一模一样**的指令、看到带着
 * 名牌的对手全文,然后被一段散文求着「别附和、别凑字数、别制造虚假对立」。
 * 三条真实的毛病:
 *
 *  1. **名牌**。互驳 prompt 里明写「【claude 的立场】」,模型对着名牌客气、
 *     对着陌生名字挑刺。抄 karpathy/llm-council 的 Stage 2:互评前抹掉作者名。
 *  2. **无靶**。把所有人的全文原样塞回去让大家自由发挥,产出的是泛泛而谈。
 *     先花一次 cheapEval 抽出争点,第二拍只对着争点打;**没有争点就整拍跳过**。
 *  3. **同质**。相同指令 → 相同角度。改成给每人指派一个批判视角(事实/假设/
 *     遗漏),这是结构,不是恳求。
 *
 * 另外补了一件此前完全没有的事:**互评名次**。每位在互驳正文末尾附一行
 * `#RANK:`,Borda 计票(不算自投)。它寄生在互驳那次调用上,不额外多打 N 次
 * provider —— agy 一次 10-14 秒,为一个排名再跑一轮不值。有了它,「这场辩论
 * 到底有没有用、谁真的有用」第一次是个可以看的数字。
 *
 * 背景:2026 年的实证工作(arXiv 2502.08788 / 2605.00914)反复指出**无引导
 * 的同构辩论打不过单模型 CoT+self-consistency**,而**模型异构性**是唯一稳定
 * 有效的因素。本仓库跑的是真异构(claude in-process / agy 订阅版 Gemini /
 * codex / cursor / openai-compatible),这一格本来就站对了;要补的正是「引导」。
 */
import type { ProviderId } from './conversation'

export interface Opening {
  speaker: ProviderId
  text: string
}

const NO_REPLY_TOOL = '用纯文本回复，不要调 reply 工具。'

/** 匿名标签。N 上限是 3(resolveParticipants 强制),留到 F 够用有余。 */
const LABEL_ALPHABET = ['A', 'B', 'C', 'D', 'E', 'F'] as const

export interface LabeledOpenings {
  /** provider → 匿名标签('A'/'B'/…)。 */
  labelOf: Map<ProviderId, string>
  /** 匿名标签 → provider。计票时用来把标签换回真人。 */
  speakerOf: Map<string, ProviderId>
  /** 渲染好的匿名块 —— **保证不含任何 provider 名字**。 */
  block: string
  /** 参与的标签,按顺序。 */
  labels: string[]
}

/**
 * 把一组开场匿名化成「回答 A / 回答 B / …」。
 *
 * 刻意**不**把「你自己那条」单独拎出来:标签必须对所有人一视同仁,名次才能
 * 覆盖全部回答(N=2 时尤其重要 —— 只排别人等于没排)。模型多半认得出自己的
 * 文风,那没关系:要挡的是「看到是 Claude 写的就客气三分」这种**品牌**偏见,
 * 不是自我偏好 —— 自我偏好在计票阶段直接剔除(见 aggregateRanking)。
 */
export function labelOpenings(openings: Opening[]): LabeledOpenings {
  const labelOf = new Map<ProviderId, string>()
  const speakerOf = new Map<string, ProviderId>()
  const labels: string[] = []
  openings.forEach((o, i) => {
    const label = LABEL_ALPHABET[i] ?? `X${i}`
    labelOf.set(o.speaker, label)
    speakerOf.set(label, o.speaker)
    labels.push(label)
  })
  const block = openings
    .map((o) => `【回答 ${labelOf.get(o.speaker)}】\n${o.text}`)
    .join('\n\n')
  return { labelOf, speakerOf, block, labels }
}

/**
 * Beat ① — the OPENING. Frame the agent as one voice in a multi-AI roundtable
 * alongside its named peers, so it does NOT answer as if it's a solo chat (the
 * raw question alone made Claude say "现在是 solo 模式" and made Codex fabricate
 * the other side). It states the peers, the user's message, and that a
 * cross-talk round follows — so the agent stakes a position meant to be debated.
 *
 * 开场**保留**同台者的真名:此时还没有互评,知道对手是谁有助于它把话说到位;
 * 匿名只在互评与裁决那两拍才需要。
 */
export function buildOpeningPrompt(question: string, participants: ProviderId[], self: ProviderId): string {
  const peers = participants.filter(p => p !== self).join('、')
  return [
    `你正在一个多 AI 圆桌讨论（chatroom）里，同台的还有：${peers}。这不是 solo 对话——你和他们一起回应同一个用户。`,
    `用户的消息：${question}`,
    '',
    `先给出你的开场立场/回答。稍后你会看到 ${peers} 的回答，然后你们互相讨论、挑毛病——所以现在把观点说清楚、有立场、能被反驳。直接答，别说"我没有对手"之类的话。简短、中文、没废话。`,
    NO_REPLY_TOOL,
  ].join('\n')
}

// ── Beat ①b:争点地图 ────────────────────────────────────────────────────

export interface Contention {
  contested: string[]
  agreed: string[]
}

/** 从匿名开场里抽出「还在争什么」。一次 cheapEval,输出必须小到不会被截断。 */
export function buildContentionPrompt(question: string, labels: LabeledOpenings): string {
  return [
    `下面是几位 AI 对「${question}」各自独立给出的回答。`,
    labels.block,
    '',
    '找出它们之间**实质性**的分歧点（同一件事给了不同结论、或互相矛盾的事实/前提）。',
    '措辞不同但意思一样、详略不同、补充而非冲突——都不算分歧。宁可少报也不要凑。',
    '只输出一行紧凑 JSON，不要 markdown 围栏，不要解释：',
    '{"contested": ["<一句话说清一个争点>", ...], "agreed": ["<他们其实一致的要点>", ...]}',
  ].join('\n')
}

function stringsOf(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : []
}

/**
 * 容忍解析。解析不了 → `contested: []`,调用方据此**跳过整个互驳拍**。
 * 这个默认方向是刻意的:抽不出争点时宁可少跑一拍,也不要拿一个瞎编的争点
 * 去逼几个模型对骂 —— 虚假对立比沉默更贵。
 */
export function parseContention(raw: string): Contention {
  const block = raw.match(/\{[\s\S]*\}/)
  if (!block) return { contested: [], agreed: [] }
  try {
    const o = JSON.parse(block[0]) as Record<string, unknown>
    return { contested: stringsOf(o.contested), agreed: stringsOf(o.agreed) }
  } catch {
    return { contested: [], agreed: [] }
  }
}

// ── Beat ②:指派视角的定向互驳 ──────────────────────────────────────────

export interface CriticLens {
  name: string
  instruction: string
}

/**
 * 三个互不重叠的批判视角。给每人指派一个,而不是给所有人同一段「请深入」——
 * 相同指令必然产出相同角度,那正是同构辩论没有增益的原因。
 */
export const CRITIC_LENSES: CriticLens[] = [
  {
    name: '事实与证据',
    instruction: '专攻事实层面：哪句话是错的、哪个数字/接口/行为对不上、哪条断言没有依据。要求对方给证据，或直接给出反例。不要评论文风与结构。',
  },
  {
    name: '假设与推理',
    instruction: '专攻推理层面：它默认了什么没说出口的前提、哪一步是逻辑跳跃、换个前提结论还成不成立。攻前提，不攻结论本身。',
  },
  {
    name: '遗漏与代价',
    instruction: '专攻没被说的部分：漏掉的角度、没算的成本、没提的失败模式与边界条件、方案落地后谁会疼。补上被所有人一起忽略的那一块。',
  },
]

/** 按序号轮转,可复现 —— 同一场里相邻的两位一定拿到不同视角。 */
export function lensFor(index: number): CriticLens {
  return CRITIC_LENSES[index % CRITIC_LENSES.length]!
}

export interface RebuttalOpts {
  labels: LabeledOpenings
  contested: string[]
  lens: CriticLens
  self: ProviderId
  /** 附加的聚焦提示(收敛未达成时的加时拍用)。 */
  focus?: string
}

/** Beat ② — 匿名 + 聚焦争点 + 指派视角 + 要一行名次。 */
export function buildRebuttalPrompt(question: string, opts: RebuttalOpts): string {
  const { labels, contested, lens } = opts
  const rankLabels = labels.labels.join(' > ')
  return [
    `用户的问题：${question}`,
    '',
    '几位 AI（包含你自己，作者已匿名）给出的回答：',
    labels.block,
    '',
    ...(contested.length
      ? ['这一轮**只针对下面这些争点**，别的不要展开：', ...contested.map(c => `- ${c}`), '']
      : []),
    ...(opts.focus ? [`额外聚焦：${opts.focus}`, ''] : []),
    `你这一轮的分工是【${lens.name}】。${lens.instruction}`,
    '',
    '通用要求——只说"新东西"：',
    '- 别重复你或对方已经说过的话；别"基本同意+小补充"地附和（没有新内容就不要发言）。',
    '- 要么提出新角度 / 反例 / 证据，要么明确指出哪一句具体错了（引用原话），要么承认你被说服的那一点并说清为什么。',
    '- 不制造虚假对立：真一致就说一致，只回一句"这点我一致，没有要补充的"，不要凑字数。',
    '- 你只是在讨论当中，不要做总结/收口/最终裁决——那是主持人最后才做的事。',
    '简短、中文、没废话。',
    '',
    `最后单独起一行，按你认为的质量从高到低给全部回答排名（作者是谁你不知道，就事论事；其中一条是你自己写的，照样按质量排）：`,
    `#RANK: ${rankLabels}`,
    NO_REPLY_TOOL,
  ].join('\n')
}

// ── Beat ②b:互评名次 ──────────────────────────────────────────────────

export interface PeerVote {
  voter: ProviderId
  ranking: string[]
}

export interface RankedSpeaker {
  speaker: ProviderId
  score: number
}

/**
 * 从互驳正文尾巴上拆出 `#RANK:` 行,并把那行从**给用户看的正文**里删掉。
 * 名次跟互驳同一次调用拿到,不额外多打 N 次 provider(agy 一次 10-14 秒)。
 *
 * 容忍:大小写、中文冒号、全角箭头、多余空格、行尾标点、认不出的标签、重复。
 * 没有这一行 → 不投票,**绝不猜**。
 */
export function parsePeerRank(raw: string): { text: string; ranking: string[] } {
  const m = raw.match(/^[ \t]*#\s*rank\s*[:：](.*)$/im)
  if (!m) return { text: raw.trim(), ranking: [] }
  const seen = new Set<string>()
  const ranking: string[] = []
  for (const tok of (m[1] ?? '').split(/[>＞,，、\s]+/)) {
    const t = tok.trim().toUpperCase().replace(/[^A-Z]/g, '')
    if (t.length !== 1 || !LABEL_ALPHABET.includes(t as typeof LABEL_ALPHABET[number])) continue
    if (seen.has(t)) continue
    seen.add(t)
    ranking.push(t)
  }
  const text = (raw.slice(0, m.index) + raw.slice((m.index ?? 0) + m[0].length)).trim()
  return { text, ranking }
}

/**
 * Borda 计票:一张 k 名的票里,第 i 名得 (k - i) 分。
 *
 * **自投不计。** karpathy 的 council 是算自投的;这里刻意不算 —— 我们**知道**
 * 哪个标签是谁写的,已知的偏见没有理由算进最终数字,否则「自评第一」就是
 * 排行榜上的免费分。剔掉之后这个名次才是纯粹的他评。
 */
export function aggregateRanking(votes: PeerVote[], labels: LabeledOpenings): RankedSpeaker[] {
  const score = new Map<ProviderId, number>()
  for (const s of labels.speakerOf.values()) score.set(s, 0)
  let counted = 0
  for (const v of votes) {
    const known = v.ranking.filter(l => labels.speakerOf.has(l))
    if (known.length === 0) continue
    counted++
    known.forEach((label, i) => {
      const speaker = labels.speakerOf.get(label)!
      if (speaker === v.voter) return                      // 自投不计
      score.set(speaker, (score.get(speaker) ?? 0) + (known.length - i))
    })
  }
  if (counted === 0) return []
  return [...score.entries()]
    .map(([speaker, s]) => ({ speaker, score: s }))
    .sort((a, b) => b.score - a.score || a.speaker.localeCompare(b.speaker))
}

/** 一行 footer —— 让「谁真的有用」看得见。空名次返回空串(不制造噪音)。 */
export function formatRankingFooter(ranking: RankedSpeaker[]): string {
  if (ranking.length === 0) return ''
  return `📊 互评（他评，不含自投）：${ranking.map(r => `${r.speaker} ${r.score}`).join(' · ')}`
}

// ── Beat ②c:收敛判定(保留) ────────────────────────────────────────────

export function buildConvergencePrompt(question: string, labels: LabeledOpenings, rebuttals: Opening[]): string {
  return [
    `判断这场关于「${question}」的讨论是否已经收敛(对核心问题已无实质分歧)。`,
    labels.block,
    '',
    rebuttals.map(o => `【回答 ${labels.labelOf.get(o.speaker) ?? '?'} 的补充】\n${o.text}`).join('\n\n'),
    '',
    '只输出一行紧凑 JSON,不要 markdown 围栏,不要解释：',
    '{"converged": true|false, "disagreement": "<若未收敛,一句话说清还在争什么;收敛则空字符串>"}',
  ].join('\n')
}

// ── Beat ③:裁决 ──────────────────────────────────────────────────────

export interface VerdictOpts {
  labels: LabeledOpenings
  rebuttals: Opening[]
  contested: string[]
  ranking: RankedSpeaker[]
}

/**
 * Beat ③ — the deliverable: a JUDGED synthesis. Plain text, no JSON to parse.
 *
 * 裁判**也是模型**,也会看名牌行事,所以这一拍同样匿名。名次以匿名标签的形式
 * 给进去当参考信号,而不是「codex 得了 4 分」—— 后者等于把品牌又塞回去。
 */
export function buildVerdictPrompt(question: string, opts: VerdictOpts): string {
  const { labels, rebuttals, contested, ranking } = opts
  const rankHint = ranking.length
    ? `参与者互评（匿名、不含自投）的高低顺序：${ranking.map(r => `回答 ${labels.labelOf.get(r.speaker) ?? '?'}`).join(' > ')}。这只是参考信号，不要拿它代替你自己的判断。`
    : ''
  return [
    `下面是几位 AI 关于「${question}」的讨论（作者已匿名）。给出最终裁决,不是"两种看法供参考"——要站队。`,
    labels.block,
    ...(rebuttals.length
      ? ['', '互相挑毛病之后各自的补充：',
         rebuttals.map(o => `【回答 ${labels.labelOf.get(o.speaker) ?? '?'} 的补充】\n${o.text}`).join('\n\n')]
      : []),
    ...(contested.length ? ['', `讨论中被识别出的争点：${contested.join('；')}`] : []),
    ...(rankHint ? ['', rankHint] : []),
    '',
    '用这个结构,简短,中文,以 🎯 开头：',
    '🎯 共识：<他们一致的部分>',
    '分歧：<分歧点;哪边更对、为什么>',
    '结论/建议：<可落地的答案>',
    '（不要提"回答 A/B"这样的编号，直接说观点本身。）',
    NO_REPLY_TOOL,
  ].join('\n')
}

// ── /both 的收口 ────────────────────────────────────────────────────────

/**
 * /both（parallel）原本是「N 个模型各答各的,并排丢给用户」—— 合并的活全推
 * 给人,在微信这块屏幕上尤其糟。并排保留(对比本身有价值),末尾补一条收口。
 * 不做互驳:那是 /chat 的事,/both 要的就是便宜和快。
 */
export function buildParallelSynthesisPrompt(question: string, labels: LabeledOpenings): string {
  return [
    `下面是几位 AI 对「${question}」各自独立给出的回答（作者已匿名，它们没有互相看过）。`,
    labels.block,
    '',
    '把它们合成一条**用户可以直接用**的答案：一致的地方直接给结论；不一致的地方指出来并站队，说明为什么。',
    '不要复述每一条、不要"综上所述各有道理"、不要提"回答 A/B"这样的编号。',
    '简短、中文，以 🎯 开头。',
    NO_REPLY_TOOL,
  ].join('\n')
}

/**
 * Tolerant parse of the convergence check. Never throws. Order:
 *  1. JSON.parse the first {...} block (strips ```json fences naturally).
 *  2. On failure (e.g. truncation), regex-extract `converged` + `disagreement`.
 *  3. On total failure, default converged=true (stop — never loop forever).
 */
export function parseConvergence(raw: string): { converged: boolean; disagreement?: string } {
  const block = raw.match(/\{[\s\S]*\}/)
  if (block) {
    try {
      const o = JSON.parse(block[0]) as { converged?: unknown; disagreement?: unknown }
      const converged = o.converged !== false
      return converged
        ? { converged: true }
        : { converged: false, ...(typeof o.disagreement === 'string' && o.disagreement.trim() ? { disagreement: o.disagreement } : {}) }
    } catch { /* fall through to field extraction */ }
  }
  // Truncation / malformed: pull fields out by regex.
  const convM = raw.match(/"converged"\s*:\s*(true|false)/)
  if (convM) {
    if (convM[1] === 'true') return { converged: true }
    const disM = raw.match(/"disagreement"\s*:\s*"([^"]*)/) // tolerate missing closing quote
    return { converged: false, ...(disM && disM[1]?.trim() ? { disagreement: disM[1] } : {}) }
  }
  return { converged: true } // unparseable → stop, don't loop
}

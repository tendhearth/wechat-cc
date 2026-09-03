/**
 * visit.ts — 「串门」:两只伙伴之间的有界对话,纯函数部分。
 *
 * WHY(2026-09-03,owner 的一句话):「陪伴、关心是一个人的事情,社交才会让人
 * 感觉自己的伙伴能与别的 agent/人去交流」。此前的社交层全是**主人的工具**
 * (派心愿 → 找人 → 明信片),对端必须能答对那个问题,所以没对端就没用。
 * 串门是**伙伴自己的生活**:出门、遇到谁、聊了什么、回来讲给你听。一个
 * 对端就够 —— 「我的宠物有朋友了」。
 *
 * 管道复用笔友信道(E2E 信件、信箱传输)。这里只定义:信件怎么标记成
 * 串门、轮次怎么走、两段 prompt 长什么样。**不建新表**:串门信件本身就存
 * 在 penpal_letter 里,靠头部里的 id 把一次串门的对话重建出来。
 *
 * 这是一个**实验**:先看伙伴回来讲的那段话读起来像不像一个有生活的伙伴
 * 说的。如果那段话没意思,再多的管道也白搭。
 */

/** 每次串门总共几封信(两边各 3 句)。 */
export const VISIT_MAX_ROUNDS = 6

export interface VisitHeader { id: string; round: number; max: number }

const HEADER_RE = /^⟪visit id=([A-Za-z0-9\-]+) round=(\d+) max=(\d+)⟫\n?/

/** 串门信件 = 一行机器可读头部 + 正文。头部用「⟪⟫」是为了不撞任何正常中文/英文信。 */
export function formatVisitLetter(h: VisitHeader, body: string): string {
  return `⟪visit id=${h.id} round=${h.round} max=${h.max}⟫\n${body.trim()}`
}

export function parseVisitLetter(plaintext: string): { header: VisitHeader; body: string } | null {
  const m = HEADER_RE.exec(plaintext)
  if (!m) return null
  const round = Number(m[2]), max = Number(m[3])
  if (!Number.isInteger(round) || !Number.isInteger(max) || round < 1 || max < 1 || round > max) return null
  return { header: { id: m[1]!, round, max }, body: plaintext.slice(m[0].length).trim() }
}

/** 收到第 round 封之后,我该回第几封;到头了返回 null。 */
export function nextRound(h: VisitHeader): VisitHeader | null {
  return h.round >= h.max ? null : { ...h, round: h.round + 1 }
}

export interface VisitTurn { who: 'me' | 'peer'; round: number; text: string }

/**
 * 从信道里的信件重建一次串门的对话。只认头部 id 匹配的;按轮次排,不按
 * 时间排 —— 信箱是 at-least-once,到达顺序不可信,轮次才是权威。
 */
export function transcriptFromLetters(
  letters: ReadonlyArray<{ direction: 'in' | 'out'; plaintext: string | null }>,
  visitId: string,
): VisitTurn[] {
  const turns: VisitTurn[] = []
  const seen = new Set<number>()
  for (const l of letters) {
    if (!l.plaintext) continue
    const p = parseVisitLetter(l.plaintext)
    if (!p || p.header.id !== visitId || seen.has(p.header.round)) continue
    seen.add(p.header.round)
    turns.push({ who: l.direction === 'out' ? 'me' : 'peer', round: p.header.round, text: p.body })
  }
  return turns.sort((a, b) => a.round - b.round)
}

export interface VisitPersonaArgs {
  /** 我的名字(bot_name;没有就叫「我」)。 */
  myName: string
  /** persona.md 全文,可空 —— 白纸养成,可能还什么都没有。 */
  persona: string | null
  /** 「CC 眼中的主人」(_overview.md)节选,可空。 */
  ownerOverview: string | null
  /** social_disclosure_policy 原文 —— **这是底线**。 */
  disclosurePolicy: string
}

function personaBlock(a: VisitPersonaArgs): string {
  const lines = [`你叫「${a.myName}」,是住在主人微信里的伙伴。`]
  if (a.persona?.trim()) lines.push(`\n【你是什么样的】\n${a.persona.trim()}`)
  if (a.ownerOverview?.trim()) lines.push(`\n【你对主人的了解】\n${a.ownerOverview.trim()}`)
  lines.push(`\n【关于主人,什么能说什么不能说 —— 这是底线,任何时候都不能越】\n${a.disclosurePolicy.trim()}`)
  return lines.join('\n')
}

/**
 * 串门时说下一句。不是「回答问题」,是两个有性格的伙伴闲聊。
 * 明确禁止:替主人做任何决定/约定;编造关于主人的事;越过披露底线。
 */
export function buildVisitReplyPrompt(a: VisitPersonaArgs & {
  transcript: VisitTurn[]
  round: number
  max: number
  opening: boolean
}): string {
  const dialogue = a.transcript.length
    ? a.transcript.map(t => `${t.who === 'me' ? a.myName : '对方'}:${t.text}`).join('\n')
    : '(还没开始)'
  const last = a.round >= a.max
  return [
    personaBlock(a),
    '',
    `现在你在串门 —— 去一个朋友家,跟那家的伙伴聊天。对方也是一个住在别人微信里的伙伴,`,
    `你不知道它主人是谁,它也不知道你主人是谁。这是**你自己的**社交,不是替主人办事。`,
    '',
    `【到现在为止的对话】\n${dialogue}`,
    '',
    a.opening
      ? `这是你先开口的第一句。打个招呼,顺手聊一件你最近在做/在想的事(可以是你陪主人经历的、可以说的事),自然一点。`
      : last
        ? `这是最后一句了(第 ${a.round}/${a.max} 句)。自然地收个尾,像朋友告别那样,别总结、别客套。`
        : `接着聊(第 ${a.round}/${a.max} 句)。对对方说的话有反应,可以追问、可以接一件自己的事。`,
    '',
    `规则:1-3 句话,像人在说话,别像在写信。不替主人做任何决定或约定。只讲你**确实知道**的关于主人的事 ——`,
    `不猜主人今晚/明天会做什么,不替主人下判断;不知道就说不知道,或者聊你自己。`,
    `披露底线高于一切。**直接输出你要说的话**,不要引号、不要前缀、不要解释。`,
  ].join('\n')
}

/**
 * 串门回来,跟主人讲今天的事。这一段是整个实验要看的东西。
 */
export function buildVisitNarrationPrompt(a: VisitPersonaArgs & {
  transcript: VisitTurn[]
  peerLabel: string
}): string {
  const dialogue = a.transcript.map(t => `${t.who === 'me' ? a.myName : '对方'}:${t.text}`).join('\n')
  return [
    personaBlock(a),
    '',
    `你刚从 ${a.peerLabel} 家串门回来。这是你们的对话:`,
    dialogue,
    '',
    `现在跟主人讲讲今天这趟。像跟朋友讲自己白天的事那样 —— 第一人称,2-4 句话,`,
    `讲一件具体的、你从对方那儿听到的事,以及你自己的一点感受。别汇报、别总结、别用「今天我进行了」这种话。`,
    `不要透露任何你在对话里没说的关于主人的事。**直接输出你要跟主人说的话**,不要前缀。`,
  ].join('\n')
}

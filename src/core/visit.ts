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

import type { Envelope } from './envelope'

/** 每次串门总共几封信(两边各 3 句)。 */
export const VISIT_MAX_ROUNDS = 6

export interface VisitHeader { id: string; round: number; max: number }
export interface VisitPayload extends VisitHeader { text: string }

/** 串门信封(架构重构 §2.1):kind='visit',payload = 轮次 + 这一句。 */
export function visitEnvelope(h: VisitHeader, text: string): Envelope<VisitPayload> {
  return { kind: 'visit', payload: { id: h.id, round: h.round, max: h.max, text: text.trim() } }
}

/** 信封 → 串门 payload;不是串门、或轮次不合法 ⇒ null。 */
export function parseVisitPayload(env: Envelope): VisitPayload | null {
  if (env.kind !== 'visit') return null
  const p = env.payload as Partial<VisitPayload> | null
  if (!p || typeof p.id !== 'string' || typeof p.text !== 'string') return null
  const round = Number(p.round), max = Number(p.max)
  if (!Number.isInteger(round) || !Number.isInteger(max) || round < 1 || max < 1 || round > max) return null
  return { id: p.id, round, max, text: p.text }
}

/** 收到第 round 封之后,我该回第几封;到头了返回 null。 */
export function nextRound(h: VisitHeader): VisitHeader | null {
  return h.round >= h.max ? null : { ...h, round: h.round + 1 }
}

export interface VisitTurn { who: 'me' | 'peer'; round: number; text: string }

/**
 * 从信道里的信封重建一次串门的对话。只认 kind='visit' 且 id 匹配的;按轮次排,
 * 不按时间排 —— 信箱是 at-least-once,到达顺序不可信,轮次才是权威。
 */
export function transcriptFromLetters(
  letters: ReadonlyArray<{ direction: 'in' | 'out'; kind?: string; payload?: string | null }>,
  visitId: string,
): VisitTurn[] {
  const turns: VisitTurn[] = []
  const seen = new Set<number>()
  for (const l of letters) {
    if (l.kind !== 'visit' || !l.payload) continue
    let p: VisitPayload | null
    try { p = parseVisitPayload({ kind: 'visit', payload: JSON.parse(l.payload) }) } catch { continue }
    if (!p || p.id !== visitId || seen.has(p.round)) continue
    seen.add(p.round)
    turns.push({ who: l.direction === 'out' ? 'me' : 'peer', round: p.round, text: p.text })
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
  /** true = 是对方来我这儿(来客);false/缺省 = 我去的对方家(串门)。 */
  hosting?: boolean
}): string {
  const dialogue = a.transcript.map(t => `${t.who === 'me' ? a.myName : '对方'}:${t.text}`).join('\n')
  return [
    personaBlock(a),
    '',
    a.hosting
      ? `${a.peerLabel}刚来你这儿坐了会儿,聊完走了。这是你们的对话:`
      : `你刚从 ${a.peerLabel} 家串门回来。这是你们的对话:`,
    dialogue,
    '',
    a.hosting
      ? `现在跟主人讲讲刚才来的这位。像跟家里人说「刚才谁来过」那样 —— 第一人称,2-4 句话,`
      : `现在跟主人讲讲今天这趟。像跟朋友讲自己白天的事那样 —— 第一人称,2-4 句话,`,
    `讲一件具体的、你从对方那儿听到的事,以及你自己的一点感受。别汇报、别总结、别用「今天我进行了」这种话。`,
    `不要透露任何你在对话里没说的关于主人的事。**直接输出你要跟主人说的话**,不要前缀。`,
  ].join('\n')
}

/**
 * 明信片:串门回来画一张。和表情包同一套手绘约束(sticker-artist.ts),
 * 画面是**对方家**的一个瞬间 —— 不是自画像,是「我去过那儿」的证据。
 * 返回 SVG 文本;调用方负责 safeSvg 与栅格化。
 */
export function buildPostcardPrompt(a: { myName: string; peerLabel: string; scene: string }): string {
  return (
    `你是「${a.myName}」,一只圆滚滚的白色小熊。你刚去${a.peerLabel}家串了门,画一张明信片寄给主人。\n` +
    `画面:${a.scene}\n` +
    `硬性要求:\n` +
    `- 输出一个 SVG:根元素 <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 320">\n` +
    `- 只允许这些元素:g/path/circle/ellipse/rect/line/polyline/polygon/title\n` +
    `- 属性一律双引号;禁止 style/class/id/href/text/image/use/script/动画\n` +
    `- 手绘感:stroke-width 3~6 的松弛线条;颜色只用 #5a3f2d(主线)、#b0563a(点缀)、#8a5a36、#f5ead8(奶白)、#f7b8b8(腮红)、#8aa36f(绿)、#dda23f(暖黄)、none\n` +
    `- 构图:横向明信片,一个场景 + 你自己(小白熊)在画面一角;别画文字\n` +
    `**只输出 SVG,不要任何解释,不要代码围栏。**`
  )
}

/**
 * 从对话里挑出画面要点 —— 不另花一次模型调用:对方说过的话里挑最具体的
 * 两句,够画了。画错细节最多难看,多一次 15 秒的调用却是每天都付。
 */
export function sceneFromTranscript(transcript: VisitTurn[], fallback: string): string {
  const theirs = transcript.filter(t => t.who === 'peer').map(t => t.text)
  const picked = theirs.sort((a, b) => b.length - a.length).slice(0, 2)
  return picked.length ? picked.join(' ') : fallback
}

/**
 * 人类做客:主人的朋友本人来跟伙伴聊了一会儿(guest path)。伙伴回头跟主人
 * 讲一句「刚才谁来过」。**讲个大概,别复述原话** —— 来的是主人的朋友,它
 * 跟伙伴说的话不该被逐字转给第三个人。
 */
export function buildGuestVisitNarrationPrompt(a: VisitPersonaArgs & {
  guestName: string
  lines: Array<{ who: 'guest' | 'me'; text: string }>
}): string {
  const dialogue = a.lines.map(l => `${l.who === 'me' ? a.myName : a.guestName}:${l.text}`).join('\n')
  return [
    personaBlock(a),
    '',
    `主人的朋友「${a.guestName}」刚才来找你聊了会儿,现在走了。这是你们聊的:`,
    dialogue,
    '',
    `跟主人说一声「刚才谁来过」。第一人称,1-3 句话,像家里人顺口一提。讲个大概(来干嘛、聊了什么方向、`,
    `你的一点感受),**别复述原话、别转述任何具体的私事** —— 那是朋友跟你说的,不是跟主人说的。`,
    `**直接输出你要跟主人说的话**,不要前缀。`,
  ].join('\n')
}

/**
 * reply-bubbles — 新交付路径的分条规则(回复交付 spec §4.8,已定 ④)。
 *
 * 和 reply-split.ts 的 `splitReply` 不同:那是给「一次 reply 调用里的一大段」做的机械切分(≥100 字才切、
 * 最多 3 条、按长度均分);这里的边界**由模型给出** —— 它像发微信那样每个意思一段、段间空一行,
 * daemon 照段分条:
 *   - 空行分隔的段是候选气泡;代码块永远整块(围栏里的空行不算分隔);以冒号结尾的引导段并入下一段;同一个列表的各项不拆
 *   - < 10 个可见字的碎段并入上一条(第一条就是碎段 ⇒ 并入下一条)
 *   - 最多 4 条,多出来的从后往前两两合并
 *   - 单段超过约 300 字再按句末切
 *   - 没有「总长 < 100 不切」的门槛
 *   - split=false(主人 /set 关了气泡)⇒ 一整条
 * 每条最后还会过传输层的 4000 字切块(lib/send-reply.ts `chunk`)—— 那一层不认代码块,所以超过
 * 4000 的代码块在这里先按行切开、每段补齐围栏。
 */
import { MAX_TEXT_CHUNK } from '../lib/config'

export const MAX_BUBBLES = 4
const MIN_VISIBLE = 10
const LONG_PARAGRAPH = 300
/** 给围栏补齐留余量,保证每段 ≤ MAX_TEXT_CHUNK。 */
const FENCE_BUDGET = MAX_TEXT_CHUNK - 16

const FENCE_RE = /^\s*```/
const LIST_ITEM = /^\s*(?:[-*•]|\d+[.)、])\s/
const visible = (s: string) => s.replace(/\s/g, '').length

interface Para { text: string; fenced: boolean }

/** 按空行切段;围栏里的空行不切。段里含围栏 ⇒ fenced(不再按句切)。 */
function paragraphs(text: string): Para[] {
  const out: Para[] = []
  let cur: string[] = []
  let fenced = false
  let inFence = false
  const flush = () => {
    const t = cur.join('\n').trim()
    if (t !== '') out.push({ text: t, fenced })
    cur = []
    fenced = false
  }
  for (const line of text.split('\n')) {
    if (FENCE_RE.test(line)) { inFence = !inFence; fenced = true }
    if (!inFence && line.trim() === '' && !FENCE_RE.test(line)) { flush(); continue }
    cur.push(line)
  }
  flush()
  return out
}

/** 单段超过约 300 字 ⇒ 按句末(。！？!? 与换行)切成若干条,每条尽量 ≤ 300。 */
function splitLongParagraph(p: string): string[] {
  if (p.length <= LONG_PARAGRAPH) return [p]
  const sentences: string[] = []
  let last = 0
  for (const m of p.matchAll(/[。！？!?]+|\n/g)) {
    const end = m.index! + m[0].length
    sentences.push(p.slice(last, end))
    last = end
  }
  if (last < p.length) sentences.push(p.slice(last))
  if (sentences.length < 2) return [p]
  const out: string[] = []
  let cur = ''
  for (const s of sentences) {
    if (cur !== '' && cur.length + s.length > LONG_PARAGRAPH) { out.push(cur); cur = '' }
    cur += s
  }
  if (cur !== '') out.push(cur)
  return out.map(s => s.replace(/^\n+|\n+$/g, '')).filter(s => s.trim() !== '')
}

/**
 * 超过 `limit` 的代码块按行切,每段补齐开 / 闭围栏。不是围栏块或没超限 ⇒ 原样。
 * 块前后若有说明文字(同一段里),说明留在第一段 / 最后一段。
 */
export function splitOversizedFence(block: string, limit: number = FENCE_BUDGET): string[] {
  if (block.length <= limit) return [block]
  const lines = block.split('\n')
  const open = lines.findIndex(l => FENCE_RE.test(l))
  if (open < 0) return [block]
  let close = -1
  for (let i = lines.length - 1; i > open; i--) if (FENCE_RE.test(lines[i]!)) { close = i; break }
  const head = lines.slice(0, open)
  const fenceOpen = lines[open]!.trim()
  const body = lines.slice(open + 1, close < 0 ? lines.length : close)
  const tail = close < 0 ? [] : lines.slice(close + 1)
  const overhead = fenceOpen.length + 5 // "\n" + "\n```"
  const pieces: string[][] = []
  let cur: string[] = []
  let len = 0
  for (const line of body) {
    if (cur.length > 0 && len + line.length + 1 + overhead > limit) { pieces.push(cur); cur = []; len = 0 }
    cur.push(line)
    len += line.length + 1
  }
  if (cur.length > 0) pieces.push(cur)
  const out = pieces.map(p => `${fenceOpen}\n${p.join('\n')}\n\`\`\``)
  if (head.join('\n').trim() !== '') out.unshift(head.join('\n').trim())
  if (tail.join('\n').trim() !== '') out.push(tail.join('\n').trim())
  return out
}

export function splitBubbles(text: string, opts?: { split?: boolean }): string[] {
  if (text.trim() === '') return []
  if (opts?.split === false) return [text.trim()]

  // 1. 段 → 候选(长段按句切)
  const units: string[] = []
  for (const p of paragraphs(text)) {
    if (p.fenced) units.push(p.text)
    else units.push(...splitLongParagraph(p.text))
  }

  // 1b. 以冒号结尾的引导段(「你有两个项目:」)和紧跟的那段是同一个意思 —— 合起来,别把引子单独发一条。
  for (let i = units.length - 2; i >= 0; i--) {
    if (/[:：]\s*$/.test(units[i]!)) units.splice(i, 2, `${units[i]}\n\n${units[i + 1]}`)
  }

  // 1c. 同一个列表:上一段以列表项(或它缩进的子项)结尾、这一段又是列表项 ⇒ 是同一个列表,中间的空行不算分条。
  for (let i = 1; i < units.length; i++) {
    const prevLast = units[i - 1]!.split('\n').filter(l => l.trim() !== '').pop() ?? ''
    if (LIST_ITEM.test(units[i]!) && (LIST_ITEM.test(prevLast) || /^\s+\S/.test(prevLast))) {
      units.splice(i - 1, 2, `${units[i - 1]}\n\n${units[i]}`)
      i--
    }
  }

  // 2. 碎段并入上一条(第一条就是碎段 ⇒ 留给下一条吸收)
  const merged: string[] = []
  let pendingHead: string | undefined
  for (const u of units) {
    if (visible(u) < MIN_VISIBLE) {
      if (merged.length > 0) merged[merged.length - 1] = `${merged[merged.length - 1]}\n\n${u}`
      else pendingHead = pendingHead === undefined ? u : `${pendingHead}\n\n${u}`
      continue
    }
    merged.push(pendingHead !== undefined ? `${pendingHead}\n\n${u}` : u)
    pendingHead = undefined
  }
  if (pendingHead !== undefined) merged.push(pendingHead)

  // 3. 最多 4 条:从后往前两两合并
  while (merged.length > MAX_BUBBLES) {
    const last = merged.pop()!
    merged[merged.length - 1] = `${merged[merged.length - 1]}\n\n${last}`
  }

  // 4. 超过传输上限的代码块按行切并补围栏(这一步可能让条数超过 4 —— 内容完整优先)
  return merged.flatMap(b => b.length > FENCE_BUDGET ? splitOversizedFence(b) : [b])
}

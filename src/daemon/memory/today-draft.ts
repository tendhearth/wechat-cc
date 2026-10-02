/**
 * 今天的草稿 today-draft.md —— 治「同日失忆」(2026-10-01,owner 拍板)。
 *
 * 有了 memory.md 之后 profile.md 不再每轮注入,主人早上跟 CC 说的事,别的会话要等 04:00 整理后才看得到。
 * 修法不另造抽取器,复用原来的信号:CC 白天把新情况写进 profile.md(MCP memory_write)。daemon 在
 * 那条写入路由上比对新旧 profile.md,新冒出来的行追加进 `<chat>/today-draft.md`;草稿随 memory.md
 * 一起进每次对话;每晚整理把它当素材读入,成功后清掉读过的那几行。
 *
 * - 只在 `<chat>/memory.md` 已存在时记:没有 memory.md 时 profile.md 本身还在注入,草稿是重复的。
 * - 总长上限 600 字(按字符,不按字节),超了丢最旧的行;单行 200 字封顶,免得一次大改把草稿冲光。
 * - 只有 daemon 写:会话(任何 tier)写 / 删 today-draft.md 被路由拒掉,和 memory.md 同一道闸。
 */
import { posix } from 'node:path'
import type { MemoryFS } from './fs-api'
import { MEMORY_FILENAME } from './curated-doc'

export const TODAY_DRAFT_FILENAME = 'today-draft.md'
export const TODAY_DRAFT_MAX_CHARS = 600
export const TODAY_DRAFT_LINE_MAX = 200

const chars = (s: string): number => Array.from(s).length
const clip = (s: string, n: number): string => (chars(s) > n ? Array.from(s).slice(0, n).join('') : s)

/** 一行 profile 正文的「事实」部分:去掉列表记号与首尾空白;标题、注释、代码围栏、空行 ⇒ null。 */
function factOf(line: string): string | null {
  const t = line.trim()
  if (!t || t.startsWith('#') || t.startsWith('<!--') || t.startsWith('```')) return null
  const body = t.replace(/^(?:[-*+]|\d+[.)])\s+/, '').trim()
  return body || null
}

function facts(text: string | null): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const line of (text ?? '').split('\n')) {
    const f = factOf(line)
    if (f && !seen.has(f)) { seen.add(f); out.push(f) }
  }
  return out
}

/** profile.md 这次写入新冒出来的行(旧文本里没有的),按出现顺序、去重。只是挪了位置 / 换了列表记号不算。 */
export function profileAdditions(before: string | null, after: string): string[] {
  const old = new Set(facts(before))
  return facts(after).filter(f => !old.has(f))
}

/** 草稿里现有的条目(正文,不带「- 」)。 */
function draftFacts(draft: string): string[] {
  return facts(draft)
}

const render = (items: string[]): string => (items.length ? items.map(i => `- ${i}`).join('\n') + '\n' : '')

/** 追加新行(已有的跳过),单行封顶,总长超上限就从最旧的开始丢。 */
export function appendToDraft(existing: string, additions: string[]): string {
  const items = draftFacts(existing)
  const have = new Set(items)
  let added = false
  for (const a of additions) {
    const line = clip(a, TODAY_DRAFT_LINE_MAX)
    if (have.has(line)) continue
    have.add(line)
    items.push(line)
    added = true
  }
  if (!added) return existing
  while (items.length > 1 && chars(render(items)) > TODAY_DRAFT_MAX_CHARS) items.shift()
  return render(items)
}

/** 每晚整理成功后:去掉它读过的那几行,整理途中新记的保留。全清空 ⇒ ''。 */
export function consumeDraft(current: string, consumed: string): string {
  const gone = new Set(draftFacts(consumed))
  return render(draftFacts(current).filter(f => !gone.has(f)))
}

/** 归一后是不是 `<chat>/profile.md`(拼写变体与 memory.md 闸门同一套:./、//、x/../、尾斜杠、大小写)。 */
export function chatOfProfilePath(path: string): string | null {
  const n = posix.normalize(path.replace(/\\/g, '/')).replace(/^(\.\/)+/, '').replace(/\/+$/, '')
  const m = /^([^/]+)\/profile\.md$/i.exec(n)
  return m && m[1] !== '..' && m[1] !== '.' ? m[1]! : null
}

/** daemon 在 profile.md 写入成功后调用。返回是否真的往草稿里记了东西。 */
export function recordProfileWrite(fs: Pick<MemoryFS, 'read' | 'write'>, chatId: string, before: string | null, after: string): boolean {
  if (fs.read(`${chatId}/${MEMORY_FILENAME}`) === null) return false
  const add = profileAdditions(before, after)
  if (!add.length) return false
  const path = `${chatId}/${TODAY_DRAFT_FILENAME}`
  const existing = fs.read(path) ?? ''
  const next = appendToDraft(existing, add)
  if (next === existing) return false
  fs.write(path, next)
  return true
}

/** 给提示词用的草稿正文(去首尾空白);没有 / 空 ⇒ ''。fs 的根是 memory/ 根目录。 */
export function readDraftForPrompt(fs: Pick<MemoryFS, 'read'>, chatId: string): string {
  return (fs.read(`${chatId}/${TODAY_DRAFT_FILENAME}`) ?? '').trim()
}

/**
 * memory.md —— 主人的长期记忆(每晚整理,每次对话都读)。人能直接读和改的 Markdown:
 * 五栏各一个列表,每条尾注挂编号与最后确认日期。编号只给整理用;没编号的条目照常读入,整理时补上。
 * 栏外 / 不认识的栏的内容进 extra,写回时原样放在末尾 —— 主人手写的东西不丢。
 */
export const SECTIONS = ['关于你', '偏好', '承诺', '身边的人', '近况'] as const
export type Section = (typeof SECTIONS)[number]
export const MEMORY_FILENAME = 'memory.md'
export const MEMORY_CAP_CHARS = 3000

export interface MemoryEntry { id: string | null; text: string; seen: string | null }
export interface MemoryDoc { sections: Record<Section, MemoryEntry[]>; extra: string[] }

const HEADER_PREFIX = '<!-- wechat-cc 记忆'
// id 是不透明的编号:生产环境用小写 hex,但解析不该假设发号器只吐 hex(见
// nightly.ts 的 newId 契约,只保证「稳定、每次不同」,不保证字符集)——放宽到
// 小写字母数字,现有 hex id 仍然匹配,不影响任何既有行为。
const ENTRY_RE = /^-\s+(.*?)\s*(?:<!--\s*m:([0-9a-z]{4,})\s*·\s*(\d{4}-\d{2}-\d{2})\s*-->)?\s*$/
const DUE_RE = /(期限 (\d{4}-\d{2}-\d{2}))/

export function emptyDoc(): MemoryDoc {
  return { sections: { 关于你: [], 偏好: [], 承诺: [], 身边的人: [], 近况: [] }, extra: [] }
}

function isSection(s: string): s is Section {
  return (SECTIONS as readonly string[]).includes(s)
}

export function parseMemoryDoc(md: string): MemoryDoc {
  const doc = emptyDoc()
  let cur: Section | null = null
  for (const raw of md.split('\n')) {
    const line = raw.trimEnd()
    if (line.startsWith(HEADER_PREFIX)) continue
    const h = /^##\s+(.+?)\s*$/.exec(line)
    if (h) {
      if (isSection(h[1]!)) { cur = h[1]; continue }
      cur = null
      doc.extra.push(line)
      continue
    }
    const e = cur ? ENTRY_RE.exec(line) : null
    if (cur && e && e[1]) {
      doc.sections[cur].push({ id: e[2] ?? null, text: e[1], seen: e[3] ?? null })
      continue
    }
    if (line.trim()) doc.extra.push(line)
    else if (cur === null && doc.extra.length > 0) doc.extra.push(line)
  }
  while (doc.extra.length > 0 && !doc.extra[doc.extra.length - 1]!.trim()) doc.extra.pop()
  return doc
}

export function serializeMemoryDoc(doc: MemoryDoc, stampIso: string): string {
  const out = [`${HEADER_PREFIX} · 每晚整理 · 最近整理 ${stampIso} · 编号是给整理用的,别删;删了也不会丢,只会被当成新条目 -->`]
  for (const s of SECTIONS) {
    out.push('', `## ${s}`)
    for (const e of doc.sections[s]) out.push(e.id && e.seen ? `- ${e.text} <!-- m:${e.id} · ${e.seen} -->` : `- ${e.text}`)
  }
  if (doc.extra.length) out.push('', ...doc.extra)
  return out.join('\n') + '\n'
}

export function renderForPrompt(doc: MemoryDoc): string {
  const parts: string[] = []
  for (const s of SECTIONS) {
    if (!doc.sections[s].length) continue
    parts.push(`### ${s}`, ...doc.sections[s].map(e => `- ${e.text}`))
  }
  if (doc.extra.length) parts.push('### 其它', ...doc.extra)
  return parts.join('\n')
}

export function docChars(doc: MemoryDoc): number {
  let n = 0
  for (const s of SECTIONS) for (const e of doc.sections[s]) n += e.text.length
  return n
}

export function parseDue(text: string): string | null {
  return DUE_RE.exec(text)?.[2] ?? null
}

export function assignMissingIds(doc: MemoryDoc, newId: () => string, today: string): MemoryDoc {
  const next = structuredClone(doc)
  for (const s of SECTIONS) for (const e of next.sections[s]) if (!e.id) { e.id = newId(); e.seen = today }
  return next
}

/**
 * 主人原话 memory/<chat>/owner.md(设计稿 docs/superpowers/specs/2026-10-23-memory-edits-stick-design.md §1)。
 *
 * 主人在生成的记忆上**加的 / 改写成的**那一行存在这里:优先级最高、合成永远不改写它。
 *  - 唯一的写者是 writeOwnerAssertions(编辑接口调)。CC 的 MCP、桌面整份覆盖、nightly、gardener、合成都不写它
 *    (fs-api 与 lib/memory 的 writeMemoryFile 拒写;scripts/memory-owner-writers.guard.test.ts 守)。
 *  - 只在主人自己的对话里注入(main.ts 的 ownerMemoryFor)。
 *
 * 一行一条:`- <原话> <!-- o:<id> · <日期> · <overview|memory|owner> [· 替换:<更正 id>] -->`。认不出的行原样保留在 extra,不丢。
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from './json-file'
import { invalidateDerivedMemory } from './memory-derived-state'

export const OWNER_FILENAME = 'owner.md'
const HEADER = '<!-- wechat-cc 主人原话:只经记忆编辑写入,CC 和整理都不改它 -->'

export type AssertionOrigin = 'overview' | 'memory' | 'owner'
export interface OwnerAssertion { id: string; text: string; date: string; origin: AssertionOrigin; replaces?: string }
export interface OwnerDoc { assertions: OwnerAssertion[]; extra: string[] }

const LINE_RE = /^-\s+(.*?)\s*<!--\s*o:([0-9a-z]{4,})\s*·\s*(\d{4}-\d{2}-\d{2})\s*·\s*(overview|memory|owner)(?:\s*·\s*替换:([0-9a-z-]+))?\s*-->\s*$/

/** 注释的开头和收尾都不能出现在原话里(主人可能粘进来半截尾注),不然解析会错位。 */
const clean = (text: string) => text.replace(/\s+/g, ' ').replace(/<!--/g, '<!—').replace(/-->/g, '—>').trim()

export function parseOwnerDoc(md: string): OwnerDoc {
  if (md.charCodeAt(0) === 0xfeff) md = md.slice(1)
  const doc: OwnerDoc = { assertions: [], extra: [] }
  for (const raw of md.split('\n')) {
    const line = raw.trimEnd()
    if (!line || line === HEADER) continue
    const m = LINE_RE.exec(line)
    if (m && m[1]) doc.assertions.push({ id: m[2]!, text: m[1], date: m[3]!, origin: m[4] as AssertionOrigin, ...(m[5] ? { replaces: m[5] } : {}) })
    else doc.extra.push(line)
  }
  return doc
}

export function serializeOwnerDoc(doc: OwnerDoc): string {
  const lines = doc.assertions.map(a => `- ${clean(a.text)} <!-- o:${a.id} · ${a.date} · ${a.origin}${a.replaces ? ` · 替换:${a.replaces}` : ''} -->`)
  return [HEADER, ...lines, ...doc.extra].join('\n') + '\n'
}

export function readOwnerDoc(memoryRoot: string): OwnerDoc {
  const p = join(memoryRoot, OWNER_FILENAME)
  if (!existsSync(p)) return { assertions: [], extra: [] }
  return parseOwnerDoc(readFileSync(p, 'utf8'))
}

/** 唯一的写者。写的是源 ⇒ 生成物过期:主人既有加也可能有收回,往藏的方向兜底('retracted')。 */
export function writeOwnerAssertions(memoryRoot: string, doc: OwnerDoc): void {
  mkdirSync(memoryRoot, { recursive: true, mode: 0o700 })
  invalidateDerivedMemory(memoryRoot, 'retracted')
  writeFileAtomic(join(memoryRoot, OWNER_FILENAME), serializeOwnerDoc(doc), { mode: 0o600 })
}

export const OWNER_MEMORY_MAX_CHARS = 1500

/** 注入用:只要原话,不要尾注。没有 ⇒ ''。 */
export function renderOwnerForPrompt(doc: OwnerDoc): string {
  const body = doc.assertions.map(a => `- ${a.text}`).join('\n')
  return body.length > OWNER_MEMORY_MAX_CHARS ? `${body.slice(0, OWNER_MEMORY_MAX_CHARS)}\n(已截断)` : body
}

/** 总览里主人原话那一节的标题(合成时由代码插在最前面;lib/memory-edit 的 overviewTextLines 认它、跳过它)。 */
export const OWNER_OVERVIEW_HEADING = '## 你写的'

/** 总览最前面那一节:主人原话逐字,每行尾注编号。没有原话 ⇒ ''。 */
export function renderOwnerOverviewSection(doc: OwnerDoc): string {
  if (!doc.assertions.length) return ''
  return [OWNER_OVERVIEW_HEADING, ...doc.assertions.map(a => `- ${clean(a.text)} <!-- o:${a.id} -->`)].join('\n')
}

/** 去掉「## 你写的」那一节(从标题到下一个标题之前)。模型照着样子写出一节同名的,也一并去掉。 */
export function stripOwnerOverviewSection(md: string): string {
  const out: string[] = []
  let skipping = false
  for (const line of md.split('\n')) {
    if (/^#{1,6}\s/.test(line.trim())) skipping = /^##\s+你写的\s*$/.test(line.trim())
    if (!skipping) out.push(line)
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n')
}

/**
 * 要把总览带出主人自己的对话(串门「CC 眼中的主人」……)一律经这里:去掉主人原话那一节。
 * 主人是在自己的记忆页上写给 CC 看的,不等于同意说给别人的 CC 听。scripts/memory-overview-readers.guard.test.ts 守。
 */
export function overviewForOthers(overview: string): string {
  return stripOwnerOverviewSection(overview).trim()
}

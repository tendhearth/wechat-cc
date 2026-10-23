/**
 * 主人在生成的记忆上改了什么 —— 纯函数(设计稿 docs/superpowers/specs/2026-10-23-memory-edits-stick-design.md §3、§4)。
 *
 * 主人不编辑原文,编辑的是 view 给的行:每行带一个键(生成的行 = lineKey,主人原话 = assertionId)。
 * 编辑回来的行按键比对,不做模糊 diff:
 *   - 键在、文字没变 ⇒ 什么都不做;键在、文字变了 ⇒ 一条更正(旧文字)+ 一条主人原话(新文字,replaces 指向那条更正);
 *   - view 里有的键回来没了 ⇒ 一条更正(主人原话没了还要从 owner.md 去掉);
 *   - 两个键都没有 ⇒ 一条新的主人原话;
 *   - 键是 view 里没有的 / 同一个键出现两次 ⇒ stale_key,整个请求不算。
 * 这里只算「要做什么」;真正落盘(更正走串行链、写 owner.md)在 daemon/memory/nightly-runtime 的 edit。
 */
import { createHash } from 'node:crypto'
import { normalizeMemoryText } from './memory-corrections'
import type { OwnerDoc } from './memory-owner'

export const EDITABLE_MEMORY_PATHS = ['_overview.md', 'memory.md', 'owner.md'] as const
export type EditableMemoryPath = (typeof EDITABLE_MEMORY_PATHS)[number]
/**
 * 整份覆盖(`wechat-cc memory write`,桌面整份编辑器)能不能写这一份(记忆编辑第 4 步):
 *  - 生成物(_overview.md 等)谁的都不行:下一次合成就盖掉,手改等于白改;
 *  - 主人那一份的 memory.md / owner.md 不行:手改必须经 `memory edit` 比对,删 = 更正、加 = 主人原话,不然又是「改了不算数」;
 *  - 别人对话里的 memory.md 照旧能整份写(那份没有逐行编辑)。
 * 回 null = 可以写;否则回给人看的一句话。ownerChatId 由调用方给(lib 不读 daemon 的配置)。
 */
export function wholeFileWriteRefusal(relPath: string, kind: string, userId: string, ownerChatId: string | null): string | null {
  const p = relPath.split('\\').join('/').replace(/^(\.\/)+/, '').toLowerCase()
  if (kind === 'derived') return `${relPath} 是 CC 整理生成的,手改下次整理就没了;要改请在记忆页上逐行改(需要守护进程运行后才能改这份记忆)`
  if (ownerChatId && userId === ownerChatId && isEditableMemoryPath(p)) return `这份是主人的 ${p},要在记忆页上逐行改(删掉的当成说错了、加的记成你说的);需要守护进程运行后才能改这份记忆`
  return null
}

export const isEditableMemoryPath = (p: unknown): p is EditableMemoryPath => (EDITABLE_MEMORY_PATHS as readonly unknown[]).includes(p)

/** 一次编辑最多这么多行 / 字节;单行最多这么多字。超了 ⇒ memory_edit_too_large(带 limit)。 */
export const EDIT_LIMIT = { lines: 200, bytes: 65_536, lineChars: 500 } as const
/** 一次编辑产生的更正超过这个数 ⇒ memory_edit_bulk,要主人确认(每条更正都会清源头、关待办)。 */
export const BULK_CORRECTIONS = 5

export interface Replaces { correctionId: string; text: string }
export interface ViewLine {
  text: string
  origin: 'generated' | 'owner'
  lineKey?: string
  assertionId?: string
  editedAt?: string
  replaces?: Replaces
}
export interface EditLine { text: string; lineKey?: string; assertionId?: string }

/** 总览 / 记忆里一行生成的话的键:规范化文本 + 同文第几次出现。不含位置 —— 主人在上面插行,下面的键不漂。 */
export function textLineKey(text: string, occurrence: number): string {
  return 'h:' + createHash('sha256').update(`${normalizeMemoryText(text)}#${occurrence}`).digest('hex').slice(0, 16)
}

const LIST_MARK = /^(?:[-*+]|\d+[.)])\s+/
const OWNER_SECTION = /^##\s+你写的\s*$/

/**
 * `_overview.md` 里能编辑的行:去掉生成戳(HTML 注释)、标题、空行、引用块里的过期提示,和「## 你写的」那一节(那一节由 owner.md 给)。
 * 列表记号去掉,只留正文。
 */
export function overviewTextLines(md: string): string[] {
  const out: string[] = []
  let inOwner = false
  for (const raw of md.split('\n')) {
    const line = raw.trim()
    if (/^#{1,6}\s/.test(line)) { inOwner = OWNER_SECTION.test(line); continue }
    if (inOwner || !line || line.startsWith('<!--') || line.startsWith('>')) continue
    const text = line.replace(LIST_MARK, '').trim()
    if (text) out.push(text)
  }
  return out
}

/** 生成的行配上键;`ids[i]` 有值(memory.md 条目的编号)就用 `m:<id>`,否则按文本 + 出现次数。 */
export function keyGeneratedLines(texts: readonly string[], ids?: ReadonlyArray<string | null>): ViewLine[] {
  const seen = new Map<string, number>()
  return texts.map((text, i) => {
    const id = ids?.[i]
    if (id) return { text, origin: 'generated' as const, lineKey: `m:${id}` }
    const n = normalizeMemoryText(text)
    const k = seen.get(n) ?? 0
    seen.set(n, k + 1)
    return { text, origin: 'generated' as const, lineKey: textLineKey(text, k) }
  })
}

/** 主人原话的行;`correctionText` 用来把 replaces 的编号展开成旧话(查不到就不带 replaces)。 */
export function ownerLines(doc: OwnerDoc, correctionText: (id: string) => string | null): ViewLine[] {
  return doc.assertions.map(a => {
    const old = a.replaces ? correctionText(a.replaces) : null
    return { text: a.text, origin: 'owner' as const, assertionId: a.id, editedAt: a.date, ...(a.replaces && old !== null ? { replaces: { correctionId: a.replaces, text: old } } : {}) }
  })
}

export function baseHashOf(fileContent: string, ownerContent: string): string {
  return createHash('sha256').update(fileContent).update('\0').update(ownerContent).digest('hex')
}

export interface EditPlan {
  /** 要更正的旧话。lineKey = 来自生成的行;assertionId = 主人收回 / 改了自己的话。 */
  corrections: Array<{ text: string; lineKey?: string; assertionId?: string }>
  /** 新的主人原话。replacesIndex = corrections 里被它替换的那一条。 */
  assertions: Array<{ text: string; replacesIndex?: number }>
  /** 从 owner.md 去掉的原话编号。 */
  removedAssertionIds: string[]
}
export type PlanResult =
  | { ok: true; plan: EditPlan }
  | { ok: false; code: 'memory_edit_stale_key' }
  | { ok: false; code: 'memory_edit_too_large'; limit: typeof EDIT_LIMIT }
  /** count = deleted + rewritten:改一行也会把旧话当成说错了(一条更正),桌面要分开说「删掉 X 条、改写 Y 条」。 */
  | { ok: false; code: 'memory_edit_bulk'; count: number; deleted: number; rewritten: number }

export function planEdit(view: readonly ViewLine[], lines: readonly EditLine[], opts: { confirmBulk?: boolean } = {}): PlanResult {
  if (lines.length > EDIT_LIMIT.lines || Buffer.byteLength(JSON.stringify(lines), 'utf8') > EDIT_LIMIT.bytes
    || lines.some(l => [...l.text].length > EDIT_LIMIT.lineChars)) return { ok: false, code: 'memory_edit_too_large', limit: EDIT_LIMIT }
  const byKey = new Map(view.filter(v => v.lineKey).map(v => [v.lineKey!, v]))
  const byAssertion = new Map(view.filter(v => v.assertionId).map(v => [v.assertionId!, v]))
  const used = new Set<string>()
  const plan: EditPlan = { corrections: [], assertions: [], removedAssertionIds: [] }
  const addAssertion = (text: string, replacesIndex?: number) => plan.assertions.push(replacesIndex === undefined ? { text } : { text, replacesIndex })
  for (const l of lines) {
    if (l.lineKey !== undefined && l.assertionId !== undefined) return { ok: false, code: 'memory_edit_stale_key' }
    const ref = l.lineKey !== undefined ? `k:${l.lineKey}` : l.assertionId !== undefined ? `a:${l.assertionId}` : null
    if (ref !== null) {
      const was = l.lineKey !== undefined ? byKey.get(l.lineKey) : byAssertion.get(l.assertionId!)
      if (!was || used.has(ref)) return { ok: false, code: 'memory_edit_stale_key' }
      used.add(ref)
      const now = normalizeMemoryText(l.text)
      if (now === normalizeMemoryText(was.text)) continue
      plan.corrections.push(l.lineKey !== undefined ? { text: was.text, lineKey: l.lineKey } : { text: was.text, assertionId: l.assertionId! })
      if (l.assertionId !== undefined) plan.removedAssertionIds.push(l.assertionId)
      // 改成空的 = 删掉,不留一条空的原话
      if (now) addAssertion(now, plan.corrections.length - 1)
      continue
    }
    const text = normalizeMemoryText(l.text)
    if (text) addAssertion(text)
  }
  for (const v of view) {
    if (v.lineKey && !used.has(`k:${v.lineKey}`)) plan.corrections.push({ text: v.text, lineKey: v.lineKey })
    if (v.assertionId && !used.has(`a:${v.assertionId}`)) {
      plan.corrections.push({ text: v.text, assertionId: v.assertionId })
      plan.removedAssertionIds.push(v.assertionId)
    }
  }
  if (plan.corrections.length > BULK_CORRECTIONS && !opts.confirmBulk) {
    const rewritten = new Set(plan.assertions.flatMap(a => a.replacesIndex === undefined ? [] : [a.replacesIndex])).size
    return { ok: false, code: 'memory_edit_bulk', count: plan.corrections.length, deleted: plan.corrections.length - rewritten, rewritten }
  }
  return { ok: true, plan }
}


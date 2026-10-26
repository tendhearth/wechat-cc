/**
 * 从表里的行渲染 memory.md / owner.md 与注入提示词的两段(架构终态 G2,设计稿
 * docs/superpowers/specs/2026-10-25-memory-single-source-design.md §2.2)。纯函数,不碰 I/O。
 *
 * 格式与今天的序列化**逐字节一样**:`src/features/memory/curated-doc.ts` 的 `serializeMemoryDoc` / `renderForPrompt`、
 * `src/lib/memory-owner.ts` 的 `serializeOwnerDoc` / `renderOwnerForPrompt`。src/domain/memory/render.test.ts 拿
 * G0 金样(`src/test-support/fixtures/memory/golden/`)逐字节比 —— 改这里的任何一个字,金样先红。
 * G2 时还没人调它;G4 起导出文件、G6 起注入都走这里,旧的序列化随之删掉。
 *
 * 只渲染 `status = 'active'` 的行。memory.md:五栏按 `MEMORY_SECTIONS` 的顺序,栏内按 `ord`;`m:<id>` 且有日期的带尾注,
 * 别的(`u:` 没编号的)只有正文;认不出的行(`x:`)按 `ord` 原样放在末尾。owner.md:原话按 `ord`,再接认不出的行。
 */
import { MEMORY_SECTIONS, type MemoryFactView } from './facts'

export type RenderableFact = Pick<MemoryFactView, 'key' | 'doc' | 'section' | 'ord' | 'text' | 'status' | 'seenAt' | 'origin' | 'replacesKey'>

const MEMORY_HEADER_PREFIX = '<!-- wechat-cc 记忆'
const OWNER_HEADER = '<!-- wechat-cc 主人原话:只经记忆编辑写入,CC 和整理都不改它 -->'
/** 与 lib/memory-owner 的 OWNER_MEMORY_MAX_CHARS 同值(注入封顶)。 */
export const OWNER_PROMPT_MAX_CHARS = 1500

const isExtra = (f: RenderableFact) => f.key.startsWith('x:')
const byOrd = (a: RenderableFact, b: RenderableFact) => a.ord - b.ord
function live(rows: readonly RenderableFact[], doc: 'memory' | 'owner'): RenderableFact[] {
  return rows.filter(r => r.doc === doc && r.status === 'active').sort(byOrd)
}
function memoryParts(rows: readonly RenderableFact[]): { sections: Array<[string, RenderableFact[]]>; extra: string[] } {
  const mine = live(rows, 'memory')
  const sections = MEMORY_SECTIONS.map(s => [s, mine.filter(r => !isExtra(r) && r.section === s)] as [string, RenderableFact[]])
  return { sections, extra: mine.filter(isExtra).map(r => r.text) }
}
/** 记忆条目的编号(尾注里的 m:<id>),没有编号 ⇒ null。 */
const entryId = (f: RenderableFact) => (f.key.startsWith('m:') ? f.key.slice(2) : null)

/** memory.md 全文。`stampIso` 是头部的「最近整理」(终态:该对话最后一条事件的时间)。 */
export function renderMemoryMd(rows: readonly RenderableFact[], stampIso: string): string {
  const { sections, extra } = memoryParts(rows)
  const out = [`${MEMORY_HEADER_PREFIX} · 每晚整理 · 最近整理 ${stampIso} · 编号是给整理用的,别删;删了也不会丢,只会被当成新条目 -->`]
  for (const [s, entries] of sections) {
    out.push('', `## ${s}`)
    for (const e of entries) {
      const id = entryId(e)
      out.push(id && e.seenAt ? `- ${e.text} <!-- m:${id} · ${e.seenAt} -->` : `- ${e.text}`)
    }
  }
  if (extra.length) out.push('', ...extra)
  return out.join('\n') + '\n'
}

/** 注入用的长期记忆(去尾注)。没有任何内容 ⇒ ''。 */
export function renderMemoryForPrompt(rows: readonly RenderableFact[]): string {
  const { sections, extra } = memoryParts(rows)
  const parts: string[] = []
  for (const [s, entries] of sections) {
    if (!entries.length) continue
    parts.push(`### ${s}`, ...entries.map(e => `- ${e.text}`))
  }
  if (extra.length) parts.push('### 其它', ...extra)
  return parts.join('\n')
}

/** 注释的开头和收尾不能出现在原话里(和 lib/memory-owner 的 clean 同一条规则)。 */
const clean = (text: string) => text.replace(/\s+/g, ' ').replace(/<!--/g, '<!—').replace(/-->/g, '—>').trim()

function ownerParts(rows: readonly RenderableFact[]): { assertions: RenderableFact[]; extra: string[] } {
  const mine = live(rows, 'owner')
  return { assertions: mine.filter(r => r.key.startsWith('o:')), extra: mine.filter(isExtra).map(r => r.text) }
}

/** owner.md 全文。`替换:` 取被替换那一行 `c:<id>` 的编号。 */
export function renderOwnerMd(rows: readonly RenderableFact[]): string {
  const { assertions, extra } = ownerParts(rows)
  const lines = assertions.map(a => {
    const rep = a.replacesKey?.startsWith('c:') ? a.replacesKey.slice(2) : null
    return `- ${clean(a.text)} <!-- o:${a.key.slice(2)} · ${a.seenAt} · ${a.origin}${rep ? ` · 替换:${rep}` : ''} -->`
  })
  return [OWNER_HEADER, ...lines, ...extra].join('\n') + '\n'
}

/** 注入用的主人原话:只要原话,不要尾注,封顶。没有 ⇒ ''。 */
export function renderOwnerForPrompt(rows: readonly RenderableFact[]): string {
  const body = ownerParts(rows).assertions.map(a => `- ${a.text}`).join('\n')
  return body.length > OWNER_PROMPT_MAX_CHARS ? `${body.slice(0, OWNER_PROMPT_MAX_CHARS)}\n(已截断)` : body
}

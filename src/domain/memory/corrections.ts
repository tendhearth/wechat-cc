/**
 * 「收回的话」:今天的 corrections.md ⇄ 表里的墓碑行(架构终态 G3 起,设计稿
 * docs/superpowers/specs/2026-10-25-memory-single-source-design.md §2.3 与「数据怎么搬」)。纯函数。
 *
 * corrections.md 一条 = 一行 `- <日期> <说法>:[<段>( · c:<id>)?] <原话>`,后面跟零到多行缩进的说明
 * (清源头 / 关待办的回执、CC 后来又关掉的待办)。每条变成一行墓碑:
 *  - key:段名里带 `c:<id>` ⇒ `c:<id>`(主人原话的 `替换:` 指向它);不带 ⇒ `c:~<n>`(n = 文件里第几条不带编号的),
 *    渲染时不写编号,和今天逐字节一样;
 *  - section = 段名(去掉编号),seenAt = 日期,status:过时 ⇒ 'outdated',别的 ⇒ 'retracted';
 *  - 说法记在事件的 verdict,说明逐段记在事件的 note(渲染时按 seq 接在那一条底下)。
 * `替换:` 指向的编号在 corrections.md 里找不到 ⇒ 补一行占位墓碑(kind = 'placeholder',空正文,不渲染进 corrections.md)。
 */
import type { NewMemoryFact } from './facts'

export type Verdict = 'wrong' | 'outdated' | 'delete'
export const VERDICT_LINE: Record<Verdict, string> = {
  wrong: '主人说这条记错了,整理时不要再写回',
  outdated: '主人说这条已经过时,整理时不要再写回',
  delete: '主人说这条不用记,整理时不要再写回',
}
const VERDICT_OF = new Map(Object.entries(VERDICT_LINE).map(([v, line]) => [line, v as Verdict]))
/** 被收回的话短于这个(规范化后的字数)就不拿来比对:一个短词会误伤(与 lib/memory-corrections 的 MIN_CORRECTED_CHARS 同值)。 */
export const MIN_RETRACTED_CHARS = 6
export const normalizeFactText = (text: string): string => text.replace(/\s+/g, ' ').trim()

/** 一条墓碑要插的行,外加它的说法与说明(落库时写进事件)。 */
export type Tombstone = NewMemoryFact & { verdict: string; notes: string[] }

const ENTRY = /^- (\d{4}-\d{2}-\d{2}) (.+?):\[([^\]]*)\] (.*)$/
const LABEL_ID = /^(.*?) · c:([0-9a-z-]+)$/

/** 规范化:去 BOM、CRLF、行尾空白、末尾空行。导入核对两边都过它。 */
export function normalizeCorrectionsText(md: string): string {
  if (md.charCodeAt(0) === 0xfeff) md = md.slice(1)
  const lines = md.replace(/\r\n/g, '\n').split('\n').map(l => l.trimEnd())
  while (lines.length && !lines[lines.length - 1]) lines.pop()
  return lines.length ? lines.join('\n') + '\n' : ''
}

/** corrections.md → 墓碑。认不出的开头(第一条之前的非空行)⇒ null:这个对话不搬,留在旧路径。 */
export function tombstonesFromCorrections(chatId: string, md: string): Tombstone[] | null {
  const text = normalizeCorrectionsText(md)
  const out: Tombstone[] = []
  let hidden = 0
  for (const line of text ? text.slice(0, -1).split('\n') : []) {
    const m = ENTRY.exec(line)
    if (m) {
      const [, day, said, label, body] = m
      const lm = LABEL_ID.exec(label!)
      const verdict = VERDICT_OF.get(said!) ?? `raw:${said}`
      out.push({
        chatId, key: lm ? `c:${lm[2]}` : `c:~${++hidden}`, doc: 'memory', subject: 'owner', section: lm ? lm[1]! : label!, ord: out.length,
        text: body!, status: verdict === 'outdated' ? 'outdated' : 'retracted', source: 'legacy_correction', seenAt: day!, verdict, notes: [],
      })
      continue
    }
    const last = out[out.length - 1]
    if (!last) { if (line.trim()) return null; continue }
    if (last.notes.length) last.notes[last.notes.length - 1] += `${line}\n`
    else last.notes.push(`${line}\n`)
  }
  return out
}

/** 被 `替换:` 指到、却不在 corrections.md 里的编号 ⇒ 占位墓碑。 */
export function placeholderTombstone(chatId: string, key: string, ord: number): Tombstone {
  return { chatId, key, doc: 'memory', subject: 'owner', section: null, kind: 'placeholder', ord, text: '', status: 'retracted', source: 'legacy_correction', verdict: 'placeholder', notes: [] }
}

export interface RenderableTombstone { key: string; kind: string | null; section: string | null; ord: number; text: string; seenAt: string | null; verdict: string | null; notes: readonly string[] }

/** 一条收回的话在 corrections.md 里那一行(不含说明)。 */
export function correctionLine(t: Pick<RenderableTombstone, 'key' | 'section' | 'text' | 'seenAt' | 'verdict'>): string {
  const said = t.verdict?.startsWith('raw:') ? t.verdict.slice(4) : VERDICT_LINE[(t.verdict ?? 'wrong') as Verdict] ?? VERDICT_LINE.wrong
  const label = t.key.startsWith('c:~') ? `${t.section ?? ''}` : `${t.section ?? ''} · ${t.key}`
  return `- ${t.seenAt} ${said}:[${label}] ${t.text}`
}

/** 墓碑 → corrections.md 全文(只读导出;与今天追加出来的文件逐字节一样)。占位墓碑不写。 */
export function renderCorrectionsMd(tombstones: readonly RenderableTombstone[]): string {
  return [...tombstones].filter(t => t.kind !== 'placeholder').sort((a, b) => a.ord - b.ord)
    .map(t => `${correctionLine(t)}\n${t.notes.join('')}`).join('')
}

/** 拿来比对的收回名单(规范化后、够长的):整理丢写回、导入判「写回的旧话」、出口过滤都用这一份。 */
export function retractedTextSet(tombstones: ReadonlyArray<{ kind?: string | null; text: string }>): Set<string> {
  const s = new Set<string>()
  for (const t of tombstones) { if (t.kind === 'placeholder') continue; const n = normalizeFactText(t.text); if (n) s.add(n) }
  return s
}

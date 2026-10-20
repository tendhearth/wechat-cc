/**
 * 「任务 对比 <编号> <编号>」(10-20,接两家对比 #451):两件事的改动并排看 —— 几轮、几个文件、加减多少行,
 * 哪些文件只有一边改了。只读,数据来自变更快照(reviewList);撤掉的轮不算。挑哪份由主人定。
 */
import type { ReviewTurn } from './review'

export interface CompareSide { turns: number; files: string[]; added: number; removed: number }

export function compareSide(turns: readonly ReviewTurn[]): CompareSide {
  const live = turns.filter(t => !t.discarded)
  const files = new Set<string>()
  let added = 0, removed = 0
  for (const t of live) for (const f of t.files) {
    files.add(f.path)
    for (const line of (f.diff ?? '').split('\n')) {
      if (line.startsWith('+++') || line.startsWith('---')) continue
      if (line.startsWith('+')) added++
      else if (line.startsWith('-')) removed++
    }
  }
  return { turns: live.length, files: [...files].sort(), added, removed }
}

const LIST_MAX = 8
const list = (paths: string[]) => paths.slice(0, LIST_MAX).join('、') + (paths.length > LIST_MAX ? ` 等 ${paths.length} 个` : '')
const line = (s: string) => s.replace(/[\r\n]+/g, ' ').slice(0, 100)

export function compareReply(a: { id: string; title: string; status: string; turns: readonly ReviewTurn[] | null }, b: typeof a): string {
  const sa = a.turns ? compareSide(a.turns) : null, sb = b.turns ? compareSide(b.turns) : null
  const block = (x: typeof a, s: CompareSide | null) => `${line(x.title)} · ${x.id}\n${x.status}${s && s.turns ? ` · ${s.turns} 轮 · ${s.files.length} 个文件 · +${s.added} −${s.removed}` : ' · 还没有改动可比'}`
  const out = [block(a, sa), block(b, sb)]
  if (sa?.turns && sb?.turns) {
    const inB = new Set(sb.files), inA = new Set(sa.files)
    const both = sa.files.filter(p => inB.has(p)), onlyA = sa.files.filter(p => !inB.has(p)), onlyB = sb.files.filter(p => !inA.has(p))
    out.push([both.length ? `两边都改了:${list(both)}` : '', onlyA.length ? `只有 ${a.id} 改了:${list(onlyA)}` : '', onlyB.length ? `只有 ${b.id} 改了:${list(onlyB)}` : ''].filter(Boolean).join('\n'))
  }
  out.push(`细看:任务 ${a.id} 改动 / 任务 ${b.id} 改动\n留下好的那份「任务 <编号> 合回」,另一份「任务 <编号> 删除工作区」。`)
  return out.filter(Boolean).join('\n\n')
}

/**
 * self-discover-roadmap.ts —— `self discover` 的第二、三个来源:欠账和对标(设计稿 2026-10-23-cc-runs-development §4.8)。
 *
 * 两路会话这些天对标别家产品、记欠的真机账,结论都写进了 `docs/roadmap.md` 的几节(「欠的真机账」「对标…」「已定未做」)。
 * 再起一个登记表就是第二个事实源;这里只把那几节里**没标完成**的条目摘出来,跟日志信号摆在一起给规划者挑。
 *
 * 怎么算「没标完成」(roadmap 的写法,10-23 核对过):
 *   - 划掉的(`~~…~~` 开头)、带 ✅ 的 ⇒ 完成,不收。
 *   - 带 🟡 ⇒ 在做,收,但标 inFlight(规划者别再派一份)。
 *   - 表格行带 PR 号(`#123`)又没 🟡 ⇒ 当作做完了:roadmap 的表做完以后常只补一个 PR 号,不一定改成 ✅。
 * 这是启发式,会把一些其实做完了、只是 roadmap 没更新的条目当成待做 —— 所以输出说的是「roadmap 上没标完成」,
 * 不说「没做」;核对代码是规划者的事。只读,不联网、不调模型。
 */

export interface RoadmapItem {
  /** 所在那一节的标题(去掉 `## `)。 */
  section: string
  /** 条目原文,去掉 Markdown 记号,截断。 */
  text: string
  /** 带 🟡:有人在做。 */
  inFlight: boolean
  /** 在 roadmap 里的行号(1 起)。 */
  line: number
}

/** 收哪几节:欠账和对标挖出来的任务。交付记录、定位、修订记录、有意推迟的都不收。 */
const SECTIONS = /欠的|对标|已定未做/
const DONE = /✅/
const IN_FLIGHT = /🟡/
const PR_REF = /#\d{3,}/
const TEXT_MAX = 160

function plain(s: string): string {
  return s
    .replace(/\*\*|`/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

function cut(s: string): string {
  return s.length > TEXT_MAX ? `${s.slice(0, TEXT_MAX)}…` : s
}

export function roadmapOpenItems(md: string): RoadmapItem[] {
  const out: RoadmapItem[] = []
  let section = ''
  const lines = md.replace(/\r\n/g, '\n').split('\n')
  lines.forEach((raw, i) => {
    const h = /^## (.+)$/.exec(raw)
    if (h) { section = h[1]!.trim(); return }
    if (!SECTIONS.test(section)) return
    const bullet = /^- (.+)$/.exec(raw)
    if (bullet) {
      const body = bullet[1]!
      if (body.startsWith('~~') || DONE.test(body)) return
      out.push({ section, text: cut(plain(body)), inFlight: IN_FLIGHT.test(body), line: i + 1 })
      return
    }
    // 表格行:跳过表头下的分隔行和表头本身(表头那一行之后紧跟 |---|)。
    if (!/^\|.*\|$/.test(raw) || /^\|[\s|:-]+\|$/.test(raw)) return
    if (/^\|[\s|:-]+\|$/.test(lines[i + 1] ?? '')) return
    if (DONE.test(raw)) return
    const inFlight = IN_FLIGHT.test(raw)
    if (!inFlight && PR_REF.test(raw)) return
    const cells = raw.split('|').slice(1, -1).map(c => plain(c))
    // 第一格常常是编号(1 / A / B3),取第一个像句子的格子当正文。
    const text = cells.find(c => c.length > 3) ?? cells.join(' ')
    out.push({ section, text: cut(text), inFlight, line: i + 1 })
  })
  return out
}

export function formatRoadmapItems(items: RoadmapItem[]): string {
  if (!items.length) return 'roadmap 的欠账 / 对标几节里没有没标完成的条目。'
  const out = [`roadmap 上没标完成的(${items.length} 条;是否真没做要对代码核):`]
  let last = ''
  for (const it of items) {
    if (it.section !== last) { out.push(`  ## ${it.section}`); last = it.section }
    out.push(`    ${it.inFlight ? '[在做] ' : ''}${it.text}  (roadmap.md:${it.line})`)
  }
  return out.join('\n')
}

/**
 * build-map.ts — docs/全景导图.md → docs/全景导图.html
 * (2026-08-26, owner: buddy8 的导图形式有点意思,博采众长)
 *
 * 形式抄的是 buddy8 的三条纪律(结论节点 / ⟨why⟩ 折叠 / 做A不做B留痕),
 * 实现刻意不抄它的 markmap+d3 构建链:wechat-cc 姿态是零依赖自包含,
 * 交互用原生 <details>/<summary> 折叠树,⟨why⟩ 点击展开,无 CDN 无
 * node_modules。改了 MD 后跑 `bun scripts/build-map.ts` 重新生成。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MD = join(ROOT, 'docs', '全景导图.md')
const OUT = join(ROOT, 'docs', '全景导图.html')

const md = readFileSync(MD, 'utf8')

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** 行内标记:⟨why⟩ → 点击展开;**b**;~~del~~;[定]/[待] 徽章。 */
function inline(s: string): string {
  let out = esc(s)
  out = out.replace(/⟨([^⟩]*)⟩/g, (_m, w) =>
    `<button class="why" onclick="this.nextElementSibling.hidden=!this.nextElementSibling.hidden">why</button><span class="why-body" hidden>${w}</span>`)
  out = out.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
  out = out.replace(/~~([^~]+)~~/g, '<del>$1</del>')
  out = out.replace(/\[定\]/g, '<span class="badge done">定</span>')
  out = out.replace(/\[待\]/g, '<span class="badge todo">待</span>')
  return out
}

const lines = md.split('\n')
let title = 'wechat-cc 全景导图'
const metaLines: string[] = []
interface Section { name: string; items: string[] }
const sections: Section[] = []
let cur: Section | null = null

for (const line of lines) {
  if (line.startsWith('# ')) { title = line.slice(2).trim(); continue }
  if (line.startsWith('> ')) { metaLines.push(line.slice(2).trim()); continue }
  if (line.startsWith('## ')) { cur = { name: line.slice(3).trim(), items: [] }; sections.push(cur); continue }
  const m = line.match(/^- (.*)$/)
  if (m && cur) cur.items.push(m[1]!)
}

const body = sections.map((sec, i) => `
<details class="sec"${i < 2 ? ' open' : ''}>
  <summary>${inline(sec.name)} <span class="count">${sec.items.length}</span></summary>
  <ul>${sec.items.map(it => `<li>${inline(it)}</li>`).join('\n')}</ul>
</details>`).join('\n')

const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root { --paper:#f5ead8; --ink:#5a3f2d; --soft:#8b5e3c; --accent:#b0563a; --card:#fffdf8; --line:rgba(89,63,44,.25); }
  * { box-sizing:border-box }
  body { margin:0; font-family:system-ui,-apple-system,"PingFang SC",sans-serif; background:var(--paper); color:var(--ink); padding:22px 16px 60px; max-width:860px; margin-inline:auto; line-height:1.75 }
  h1 { font-size:24px; margin:0 0 6px } h1::before { content:"🐻 " }
  .meta { color:var(--soft); font-size:12.5px; border-left:3px solid var(--line); padding-left:10px; margin-bottom:18px }
  .meta p { margin:2px 0 }
  details.sec { background:var(--card); border:1.5px solid var(--line); border-radius:14px 18px 12px 20px; margin-bottom:12px; padding:2px 16px }
  details.sec > summary { cursor:pointer; font-size:17px; font-weight:700; color:var(--accent); padding:11px 0; list-style:none; user-select:none }
  details.sec > summary::before { content:"▸ "; color:var(--soft) } details.sec[open] > summary::before { content:"▾ " }
  details.sec > summary::-webkit-details-marker { display:none }
  .count { font-size:12px; font-weight:400; color:var(--soft); background:rgba(139,94,60,.1); border-radius:999px; padding:1px 8px; vertical-align:2px }
  ul { margin:0 0 12px; padding-left:20px } li { margin-bottom:9px; font-size:14.5px }
  .why { font:inherit; font-size:11px; color:var(--accent); background:none; border:1px solid var(--accent); border-radius:999px; padding:0 7px; margin-left:5px; cursor:pointer; vertical-align:1px }
  .why-body { display:block; margin:7px 0 3px; padding:9px 12px; background:rgba(176,86,58,.06); border-left:3px solid var(--accent); border-radius:0 8px 8px 0; font-size:13px; color:var(--soft) }
  .badge { font-size:11px; border-radius:5px; padding:1px 6px; margin-right:3px; font-weight:700 }
  .badge.done { background:#4a7c59; color:#fff } .badge.todo { background:#c9a227; color:#fff }
  del { color:var(--soft); opacity:.7 }
  footer { color:var(--soft); font-size:12px; text-align:center; margin-top:28px }
</style></head><body>
<h1>${esc(title)}</h1>
<div class="meta">${metaLines.map(l => `<p>${inline(l)}</p>`).join('')}</div>
${body}
<footer>事实源:docs/全景导图.md · 生成:bun scripts/build-map.ts</footer>
</body></html>`

writeFileSync(OUT, html)
console.log(`生成 ${OUT} — ${sections.length} 区 / ${sections.reduce((n, s) => n + s.items.length, 0)} 节点`)

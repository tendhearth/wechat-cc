/**
 * CC 的信:排成信纸。SVG 是纯函数(可测);栅格化只有 macOS(qlmanage,和明信片、表情包同一条路)。
 *
 * qlmanage 出的缩略图永远是正方形 —— 所以画面是「一张信纸放在桌上」的方图,而不是竖长的一页。
 * 正文用 foreignObject 让 WebKit 自己断行;分页靠估算行数,宁可估多(留白)也不估少(被裁掉)。
 */
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from '../../lib/runtime/process'
import type { LetterDraft } from './compose'
import { color, fontFamily } from '../../../packages/design-tokens/src/index'

const VIEW = 1200
const PAPER = { x: 150, y: 70, w: 900, h: 1060 }
const TEXT = { x: 220, y: 175, w: 760, h: 830 }
/** 字号档位:先用最大的;放不下一页就退一档;最小档还放不下才翻页。 */
export const SIZES: ReadonlyArray<{ font: number; line: number }> = [
  { font: 31, line: 54 }, { font: 28, line: 49 }, { font: 26, line: 45 },
]
type Size = { font: number; line: number }
/** 一行能放几个全角字;按少一个估,给标点避头尾留余地。 */
const charsPerLine = (z: Size) => Math.floor(TEXT.w / z.font) - 1
const linesPerPage = (z: Size) => Math.floor(TEXT.h / z.line)
// 颜色与字体跟桌面 / 手机同一份 token(packages/design-tokens):纸 = paper,字 = ink,日期页码 = inkSoft,横线 = hair,桌面 = ground。
const INK = color.ink
const FAINT = color.inkSoft
const RULE = color.hair
const PAPER_FILL = color.paper
const DESK = color.ground
/** 先 Noto Serif SC(装了就用,和 app 一致);没装落到宋体。 */
const FONTS = `'${fontFamily.serifCJK}','Songti SC','STSong','Noto Serif CJK SC','Source Han Serif SC',serif`

export interface LetterLine { text: string; indent: boolean }
export interface LetterPage { lines: LetterLine[]; first: boolean; last: boolean; size: Size }

/** 一个字在正文里占几个全角宽:ASCII 约半个。 */
function widthOf(s: string): number {
  let w = 0
  for (const ch of s) w += ch.charCodeAt(0) < 0x2e80 && ch !== '—' ? 0.5 : 1
  return w
}

export function linesFor(text: string, indent: boolean, z: Size = SIZES[0]!): number {
  return Math.max(1, Math.ceil(((indent ? 2 : 0) + widthOf(text)) / charsPerLine(z)))
}

/** 太长、一页都放不下的段落,在句号处切开(实在没有句号才硬切)。 */
function splitLong(text: string, z: Size): string[] {
  const cap = linesPerPage(z) - 1
  if (linesFor(text, true, z) <= cap) return [text]
  const sentences = text.match(/[^。！？!?]+[。！？!?」』"]*|[^。！？!?]+$/g) ?? [text]
  const out: string[] = []
  let cur = ''
  for (const sen of sentences) {
    if (cur && linesFor(cur + sen, true, z) > cap) { out.push(cur); cur = '' }
    if (linesFor(sen, true, z) > cap) {
      const chars = [...sen]
      const n = cap * charsPerLine(z) - 2
      for (let i = 0; i < chars.length; i += n) out.push(chars.slice(i, i + n).join(''))
      continue
    }
    cur += sen
  }
  if (cur) out.push(cur)
  return out
}

/** 排版:称呼 → 各段(首行缩进)→ 落款小句。先试着整封放进一页(字号逐档缩小);
 *  还放不下就用最小档按段落翻页 —— 段落不跨页,免得一个词被劈成两半。 */
export function paginate(l: LetterDraft): LetterPage[] {
  const blocks: LetterLine[] = [
    { text: l.salutation, indent: false },
    ...l.paragraphs.map(p => ({ text: p, indent: true })),
    ...(l.signoff ? [{ text: l.signoff, indent: true }] : []),
  ]
  for (const z of SIZES) {
    const total = blocks.reduce((n, b) => n + linesFor(b.text, b.indent, z), 0)
    if (total <= linesPerPage(z)) return [{ lines: blocks, first: true, last: true, size: z }]
  }
  const z = SIZES[SIZES.length - 1]!
  const pages: LetterLine[][] = [[]]
  let left = linesPerPage(z)
  for (const b of blocks) {
    for (const piece of b.indent ? splitLong(b.text, z) : [b.text]) {
      const need = linesFor(piece, b.indent, z)
      if (need > left && pages[pages.length - 1]!.length) { pages.push([]); left = linesPerPage(z) }
      pages[pages.length - 1]!.push({ text: piece, indent: b.indent })
      left -= need
    }
  }
  return pages.map((lines, i, all) => ({ lines, first: i === 0, last: i === all.length - 1, size: z }))
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const CN_DIGIT = ['〇', '一', '二', '三', '四', '五', '六', '七', '八', '九']
function cnNumber(n: number): string {
  if (n < 10) return CN_DIGIT[n]!
  if (n < 20) return `十${n % 10 ? CN_DIGIT[n % 10] : ''}`
  return `${CN_DIGIT[Math.floor(n / 10)]}十${n % 10 ? CN_DIGIT[n % 10] : ''}`
}
/** 2026-10-16 → 二〇二六年十月十六日 */
export function chineseDate(day: string): string {
  const [y, m, d] = day.split('-')
  if (!y || !m || !d) return day
  return `${[...y].map(c => CN_DIGIT[Number(c)] ?? c).join('')}年${cnNumber(Number(m))}月${cnNumber(Number(d))}日`
}

export function letterPageSvg(page: LetterPage, o: { day: string; index: number; total: number }): string {
  const rules: string[] = []
  // 横线对齐正文基线:每行行框顶往下约 0.78 个行高(宋体基线略下)
  const z = page.size
  for (let k = 0; k < linesPerPage(z); k++) {
    const y = TEXT.y + k * z.line + Math.round(z.line * 0.78)
    rules.push(`<line x1="${PAPER.x + 40}" y1="${y}" x2="${PAPER.x + PAPER.w - 40}" y2="${y}" stroke="${RULE}" stroke-width="1.2"/>`)
  }
  const body = page.lines.map(l =>
    `<p style="margin:0;${l.indent ? 'text-indent:2em;' : ''}">${xml(l.text)}</p>`).join('')
  const head = page.first
    ? `<text x="${PAPER.x + PAPER.w - 50}" y="${PAPER.y + 66}" text-anchor="end" font-family="${xml(FONTS)}" font-size="24" fill="${FAINT}">${xml(chineseDate(o.day))}</text>`
    : ''
  const sign = page.last
    ? `<text x="${PAPER.x + PAPER.w - 70}" y="${PAPER.y + PAPER.h - 60}" text-anchor="end" font-family="${xml(FONTS)}" font-size="34" fill="${INK}">— CC</text>`
    : ''
  const folio = o.total > 1
    ? `<text x="${VIEW / 2}" y="${PAPER.y + PAPER.h - 28}" text-anchor="middle" font-family="${xml(FONTS)}" font-size="20" fill="${FAINT}">${o.index + 1} / ${o.total}</text>`
    : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${VIEW}" height="${VIEW}" viewBox="0 0 ${VIEW} ${VIEW}">
<defs><filter id="sh" x="-10%" y="-10%" width="120%" height="120%"><feDropShadow dx="0" dy="10" stdDeviation="16" flood-color="${color.ink}" flood-opacity="0.10"/></filter></defs>
<rect width="${VIEW}" height="${VIEW}" fill="${DESK}"/>
<g transform="rotate(${o.index % 2 ? 1.2 : -1.6} ${VIEW / 2} ${VIEW / 2})">
<rect x="${PAPER.x}" y="${PAPER.y}" width="${PAPER.w}" height="${PAPER.h}" rx="4" fill="${PAPER_FILL}" filter="url(#sh)"/>
${rules.join('\n')}
${head}
<foreignObject x="${TEXT.x}" y="${TEXT.y}" width="${TEXT.w}" height="${TEXT.h}">
<div xmlns="http://www.w3.org/1999/xhtml" style="font-family:${FONTS.replace(/"/g, '')};font-size:${z.font}px;line-height:${z.line}px;color:${INK}">${body}</div>
</foreignObject>
${sign}
${folio}
</g>
</svg>`
}

export function letterSvgs(l: LetterDraft, day: string): string[] {
  const pages = paginate(l)
  return pages.map((p, index) => letterPageSvg(p, { day, index, total: pages.length }))
}

/** SVG → 方形 PNG(macOS qlmanage)。别的平台回 null,调用方退回发文字。 */
export function rasterizeLetterPage(svg: string, dir: string, name: string, size = 1600): string | null {
  if (process.platform !== 'darwin') return null
  try {
    mkdirSync(dir, { recursive: true })
    const svgPath = join(dir, `${name}.svg`)
    writeFileSync(svgPath, svg)
    const r = spawnSync(['qlmanage', '-t', '-s', String(size), '-o', dir, svgPath])
    const out = `${svgPath}.png`
    if (r.exitCode !== 0 || !existsSync(out)) return null
    const png = join(dir, `${name}.png`)
    renameSync(out, png)
    return png
  } catch {
    return null
  }
}

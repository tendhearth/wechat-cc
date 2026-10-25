/**
 * archive.ts — 手机「CC 的信」读存档(手机伙伴第 2 步,2026-10-18)。只读:列出寄出去了的信、取某一页的 PNG。
 *
 * 存档在 <stateDir>/letters/<id>/(letter.json + page-N.png,runtime.ts 写)。没寄出去的那封(还在等主人开口 / 等 App)
 * 不列 —— 抽屉里先看见就不是「寄来的信」了。previews/ 是维护者自检的预览,不是信,也不列。
 */
import { existsSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import { letterText } from './compose'
import { LETTERS_DIR, readLetterRecords } from './runtime'

/** 信的 id:`<本地日期>-<6 位 hex>`(runtime.ts 的 file())。路由只认这个形状,别的一律 404(不拼路径)。 */
export const LETTER_ID_RE = /^\d{4}-\d{2}-\d{2}-[a-f0-9]{6}$/
/** 一封信至多这么多页(排版那边一封两三页;这里只是给路由一个上限)。 */
export const LETTER_PAGES_MAX = 12
/** 抽屉一次至多列这么多封(一个月一封,够看好几年)。 */
export const LETTER_LIST_MAX = 60
/** 开头那句至多这么多字。 */
const OPENING_MAX = 60

export interface LetterListItem {
  id: string
  day: string
  /** 寄出的时刻(ms)。 */
  sentAt: number
  requested: boolean
  /** 寄到哪了;老信没记 ⇒ wechat。 */
  via: 'wechat' | 'app'
  /** 第一段的开头,当标题看。 */
  opening: string
  /** 有几页图;0 ⇒ 这封是排不成图、按文字寄的(手机上显示 text)。 */
  pages: number
  /** 只在没有图时给全文(按文字寄的那封);有图时不给,省一帧。 */
  text?: string
}

const isPage = (p: string): boolean => {
  try { const st = lstatSync(p); return st.isFile() } catch { return false }
}

function pageCount(stateDir: string, id: string): number {
  let n = 0
  while (n < LETTER_PAGES_MAX && isPage(join(stateDir, LETTERS_DIR, id, `page-${n + 1}.png`))) n++
  return n
}


export function listLetters(stateDir: string, limit = LETTER_LIST_MAX): LetterListItem[] {
  if (!existsSync(join(stateDir, LETTERS_DIR))) return []
  const out: LetterListItem[] = []
  for (const r of readLetterRecords(stateDir)) {
    if (out.length >= limit) break
    if (!r.sent_at || !LETTER_ID_RE.test(r.id)) continue
    const sentAt = Date.parse(r.sent_at)
    if (!Number.isFinite(sentAt)) continue
    const pages = pageCount(stateDir, r.id)
    const opening = (r.letter.paragraphs[0] ?? '').trim()
    out.push({
      id: r.id, day: r.day, sentAt, requested: r.requested === true, via: r.sent_via === 'app' ? 'app' : 'wechat',
      opening: [...opening].length > OPENING_MAX ? [...opening].slice(0, OPENING_MAX).join('') + '…' : opening,
      pages,
      ...(pages === 0 ? { text: letterText(r.letter) } : {}),
    })
  }
  return out
}

/** 寄出去了的那封的第 page 页(1 起);不是这个形状 / 没寄出 / 没这一页 / 不是普通文件 ⇒ null。 */
export function letterPagePath(stateDir: string, id: string, page: number): string | null {
  if (!LETTER_ID_RE.test(id) || !Number.isInteger(page) || page < 1 || page > LETTER_PAGES_MAX) return null
  const rec = readLetterRecords(stateDir).find(r => r.id === id)
  if (!rec || !rec.sent_at) return null
  const p = join(stateDir, LETTERS_DIR, id, `page-${page}.png`)
  return isPage(p) ? p : null
}

/**
 * journal-store.ts — 伙伴的日志(v36 建为 journal,v40 改名 journal)。
 *
 * 架构重构 §2.4:主人看到的是一条时间线 —— 今天干了什么、遇到了谁、带回了
 * 什么。kind 决定每条是什么:hunt(打猎带回的东西,见 hunt-catch.ts)|
 * visit(串门/来客的见闻,可带明信片)。背包是它的一个视图。
 */
import type { Db } from '../lib/db'
import { parseCatch } from './hunt-catch'

export type CatchStatus = 'new' | 'tried' | 'using' | 'dropped'
/**
 * 'hunt' = 打猎带回的东西;'visit' = 串门带回的见闻(v37);
 * 'postcard' = 别人回心愿的明信片(spec 2026-09-04-wish-postcard);
 * 'recollection' = CC 自己判断值得记、自己写的一段记述(spec
 * 2026-09-23-delegation-report-design.md「回忆」,不问主人就写,但能删)。
 */
export type CatchKind = 'hunt' | 'visit' | 'postcard' | 'recollection'
export const CATCH_STATUSES: readonly CatchStatus[] = ['new', 'tried', 'using', 'dropped']

export interface CatchRow {
  id: string
  ts: string
  chat_id: string
  title: string
  url: string | null
  note: string
  status: CatchStatus
  kind: CatchKind
  /** 明信片(v38):已 safeSvg 的 SVG 文本;没有就 null。 */
  image_svg: string | null
  favorite?: number
  /**
   * v67:这条记述来自哪件事(目前只有 kind='recollection' 会写;其它 kind
   * 恒为 null,历史行也是 null——没有 matter 可补,查不到不算错)。既是回
   * 忆的持久去重键(见 hasRecollection),也是面板回溯"这条回忆是哪件事"
   * 的产品缺陷修复(评审修复轮 2)。
   */
  matter_id: string | null
}

export interface Journal {
  /**
   * 记下一次打猎发出去的整段文本。返回入库条数。
   *
   * 同一条链接**同一天**重复入库会被跳过 —— 打猎轮次可能因重启补跑,
   * 而列表里出现两条一模一样的东西看起来像 bug。跨天的重复保留:主人
   * 隔一周又被推同一个东西,这件事本身值得看见。
   */
  recordHunt(args: { chatId: string; text: string; nowIso?: string }): number
  /**
   * 记一段串门见闻(kind='visit')。一段一条,不拆:见闻是一段话,不是清单。
   * 状态对见闻没意义(没有「试过没有」),但列上有,固定 'new'。
   */
  recordVisit(args: { chatId: string; text: string; peerLabel: string; nowIso?: string; imageSvg?: string | null }): string | null
  /**
   * 记一张明信片(kind='postcard'):别人的伙伴回了主人的心愿。一张一条,
   * title = `${peerLabel} 回了你的心愿`;没有链接、没有状态档意义(固定 'new')。
   */
  recordPostcard(args: { chatId: string; text: string; peerLabel: string; nowIso?: string }): string | null
  /**
   * 记一段回忆(kind='recollection'):CC 自己判断这件事值得记、自己写的
   * 一段记述(见 matters/recollection.ts 的 maybeRecollect,判据是故事性
   * 不是产出)。不问主人就写(标题固定,没有像 peerLabel 那样天然的身份
   * 字段可用);跟其它条目一样能被 remove() 摘掉 —— 这就是 spec 已定 #6
   * 「不问、可删」里「可删」那一半,不需要另开一条删除路径。
   *
   * `matterId`(v67)必填:这是持久去重的键(见 hasRecollection),也是
   * 面板回溯"这条回忆是哪件事"的依据——调用方(recollect-sink.ts)永远
   * 拿得到它(matter 是查出来的),没有"没有 matter 也要写"这种场景。
   */
  recordRecollection(args: { chatId: string; text: string; matterId: string; nowIso?: string }): string | null
  /**
   * 这个 matter 是否已经写过一段回忆(v67,持久去重键;评审修复轮 2 新
   * Important):recollect-sink.ts 在问便宜模型之前先查一次,daemon 重启
   * 之后也认得——不像纯内存的 Set,重启就归零、同一个 matter 会被再问、
   * 再写一条几乎一样的记述。
   */
  hasRecollection(matterId: string): boolean
  /** 明信片画得慢(又一次模型调用 + 栅格化),先记见闻再补图。 */
  attachImage(id: string, svg: string): void
  list(limit?: number): CatchRow[]
  listPostcards(options: { limit?: number; offset?: number; favoritesOnly?: boolean }): { items: CatchRow[]; total: number }
  setFavorite(id: string, favorite: boolean): boolean
  setStatus(id: string, status: CatchStatus): boolean
  remove(id: string): boolean
  /**
   * 桌宠的包袱(spec 2026-09-03-companion-presence §2.3):水位之后有几条、
   * 最新一条是什么。seenUntil = null ⇒ 从没看过,全算。
   */
  summary(seenUntil: string | null): { unread: number; latest: { kind: string; title: string; ts: string } | null }
}

const PRUNE_KEEP = 500
/** recordRecollection 的固定标题 —— 回忆没有像 peerLabel 那样天然的身份字段,记述本身在 note 里。 */
const RECOLLECTION_TITLE = '一段回忆'

export function makeJournal(db: Db): Journal {
  const ins = db.query<unknown, [string, string, string, string, string | null, string]>(
    `INSERT INTO journal(id, ts, chat_id, title, url, note, status, kind)
     VALUES (?, ?, ?, ?, ?, ?, 'new', 'hunt')`,
  )
  const insVisit = db.query<unknown, [string, string, string, string, string, string | null]>(
    `INSERT INTO journal(id, ts, chat_id, title, url, note, status, kind, image_svg)
     VALUES (?, ?, ?, ?, NULL, ?, 'new', 'visit', ?)`,
  )
  const insPostcard = db.query<unknown, [string, string, string, string, string]>(
    `INSERT INTO journal(id, ts, chat_id, title, url, note, status, kind, image_svg)
     VALUES (?, ?, ?, ?, NULL, ?, 'new', 'postcard', NULL)`,
  )
  const insRecollection = db.query<unknown, [string, string, string, string, string, string]>(
    `INSERT INTO journal(id, ts, chat_id, title, url, note, status, kind, image_svg, matter_id)
     VALUES (?, ?, ?, ?, NULL, ?, 'new', 'recollection', NULL, ?)`,
  )
  const selHasRecollection = db.query<{ cnt: number }, [string]>(
    "SELECT COUNT(*) AS cnt FROM journal WHERE kind = 'recollection' AND matter_id = ?",
  )
  const setImage = db.query<unknown, [string, string]>('UPDATE journal SET image_svg = ? WHERE id = ?')
  const selAll = db.query<CatchRow, [number]>('SELECT * FROM journal ORDER BY ts DESC, rowid DESC LIMIT ?')
  const selDupe = db.query<{ cnt: number }, [string, string]>(
    "SELECT COUNT(*) AS cnt FROM journal WHERE url = ? AND substr(ts, 1, 10) = ?",
  )
  const upd = db.query<unknown, [string, string]>('UPDATE journal SET status = ? WHERE id = ?')
  const del = db.query<unknown, [string]>('DELETE FROM journal WHERE id = ?')
  const exists = db.query<{ cnt: number }, [string]>('SELECT COUNT(*) AS cnt FROM journal WHERE id = ?')
  const prune = db.query<unknown, [number]>(
    'DELETE FROM journal WHERE favorite = 0 AND id NOT IN (SELECT id FROM journal WHERE favorite = 0 ORDER BY ts DESC, rowid DESC LIMIT ?)',
  )
  const cntAll = db.query<{ cnt: number }, []>('SELECT COUNT(*) AS cnt FROM journal')
  const cntAfter = db.query<{ cnt: number }, [string]>('SELECT COUNT(*) AS cnt FROM journal WHERE ts > ?')
  const selLatest = db.query<{ kind: string; title: string; ts: string }, []>(
    'SELECT kind, title, ts FROM journal ORDER BY ts DESC, rowid DESC LIMIT 1',
  )

  return {
    recordHunt({ chatId, text, nowIso }) {
      const ts = nowIso ?? new Date().toISOString()
      const day = ts.slice(0, 10)
      let n = 0
      for (const item of parseCatch(text)) {
        if (item.url !== null && (selDupe.get(item.url, day)?.cnt ?? 0) > 0) continue
        ins.run(`${ts}:${n}:${Math.random().toString(36).slice(2, 8)}`, ts, chatId, item.title, item.url, item.note)
        n++
      }
      if (n > 0) prune.run(PRUNE_KEEP)
      return n
    },
    recordVisit({ chatId, text, peerLabel, nowIso, imageSvg }) {
      const ts = nowIso ?? new Date().toISOString()
      const body = text.trim()
      if (body === '') return null
      const id = `${ts}:visit:${Math.random().toString(36).slice(2, 8)}`
      insVisit.run(id, ts, chatId, peerLabel, body, imageSvg ?? null)
      prune.run(PRUNE_KEEP)
      return id
    },
    recordPostcard({ chatId, text, peerLabel, nowIso }) {
      const ts = nowIso ?? new Date().toISOString()
      const body = text.trim()
      if (body === '') return null
      const id = `${ts}:postcard:${Math.random().toString(36).slice(2, 8)}`
      insPostcard.run(id, ts, chatId, `${peerLabel} 回了你的心愿`, body)
      prune.run(PRUNE_KEEP)
      return id
    },
    recordRecollection({ chatId, text, matterId, nowIso }) {
      const ts = nowIso ?? new Date().toISOString()
      const body = text.trim()
      if (body === '') return null
      const id = `${ts}:recollection:${Math.random().toString(36).slice(2, 8)}`
      insRecollection.run(id, ts, chatId, RECOLLECTION_TITLE, body, matterId)
      prune.run(PRUNE_KEEP)
      return id
    },
    hasRecollection(matterId) { return (selHasRecollection.get(matterId)?.cnt ?? 0) > 0 },
    attachImage(id, svg) { setImage.run(svg, id) },
    list(limit = 200) { return selAll.all(limit) },
    listPostcards({ limit = 24, offset = 0, favoritesOnly = false }) {
      const where = "kind = 'visit' AND image_svg IS NOT NULL AND trim(image_svg) != ''" + (favoritesOnly ? ' AND favorite = 1' : '')
      const items = db.query<CatchRow, [number, number]>(`SELECT * FROM journal WHERE ${where} ORDER BY ts DESC, rowid DESC LIMIT ? OFFSET ?`).all(limit, offset)
      const total = db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM journal WHERE ${where}`).get()?.n ?? 0
      return { items, total }
    },
    setFavorite(id, favorite) {
      const result = db.query("UPDATE journal SET favorite = ? WHERE id = ? AND kind = 'visit' AND image_svg IS NOT NULL AND trim(image_svg) != ''").run(favorite ? 1 : 0, id)
      return result.changes > 0
    },
    setStatus(id, status) {
      if ((exists.get(id)?.cnt ?? 0) === 0) return false
      upd.run(status, id)
      return true
    },
    remove(id) {
      if ((exists.get(id)?.cnt ?? 0) === 0) return false
      del.run(id)
      return true
    },
    summary(seenUntil) {
      const unread = seenUntil === null ? (cntAll.get()?.cnt ?? 0) : (cntAfter.get(seenUntil)?.cnt ?? 0)
      return { unread, latest: selLatest.get() ?? null }
    },
  }
}

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
/** 'hunt' = 打猎带回的东西;'visit' = 串门带回的见闻(v37)。 */
export type CatchKind = 'hunt' | 'visit'
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
  /** 明信片画得慢(又一次模型调用 + 栅格化),先记见闻再补图。 */
  attachImage(id: string, svg: string): void
  list(limit?: number): CatchRow[]
  setStatus(id: string, status: CatchStatus): boolean
  remove(id: string): boolean
}

const PRUNE_KEEP = 500

export function makeJournal(db: Db): Journal {
  const ins = db.query<unknown, [string, string, string, string, string | null, string]>(
    `INSERT INTO journal(id, ts, chat_id, title, url, note, status, kind)
     VALUES (?, ?, ?, ?, ?, ?, 'new', 'hunt')`,
  )
  const insVisit = db.query<unknown, [string, string, string, string, string, string | null]>(
    `INSERT INTO journal(id, ts, chat_id, title, url, note, status, kind, image_svg)
     VALUES (?, ?, ?, ?, NULL, ?, 'new', 'visit', ?)`,
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
    'DELETE FROM journal WHERE id NOT IN (SELECT id FROM journal ORDER BY ts DESC, rowid DESC LIMIT ?)',
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
    attachImage(id, svg) { setImage.run(svg, id) },
    list(limit = 200) { return selAll.all(limit) },
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
  }
}

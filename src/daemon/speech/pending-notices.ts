/**
 * 「待说」队列:report / blocking 被推后了不能丢(第三批 3a「defer 不是不送」,整合者评审 #528 / #530)。
 *
 * 只发一次的那几句(社交的来信 / 结果、定时被暂停、升级完、开机有几样没起来 …)被门推后、或放行了却没发出去 ⇒ 进这里;
 * 门这一层定时 flush:每条对话合成一句(「刚才没顾上跟你说的几件事」),放行就说完、删掉。
 * initiative 不进来 —— 那一类推后就是这一句不说(S2c 起新贴纸那一句、见闻例外,带自己的过期时间)。
 *
 * S2b 起落在主库 `speech_pending`(lane = 'say',v101),以前是 speech/pending-notices.json:
 *  - 每一行有过期时间(缺省 24 小时,`RETRY_WINDOW_MS`):过了 flush 时删掉、记一行账「过期作废」,不再说;
 *  - 补说失败的退避记在行上(`next_at` / `attempts` / `first_failed_at`,`lib/delivery-backoff` 的 backoffMs),重启不归零;
 *  - 超过每条对话的上限 ⇒ 最老的变成 overflow(不说,说的时候带一句「还有 N 件更早的」,说过就删),记一行日志,不悄悄少。
 * 旧文件里有的,第一次开机时读进来(INSERT OR IGNORE,id 原样),然后改名成 `.migrated`(同 activity / events 那几张表的做法)。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Db } from '../../lib/db'
import { renameMigrated } from '../../lib/db'
import { readJsonFile } from '../../lib/read-json-file'
import { backoffMs, RETRY_WINDOW_MS } from '../../lib/delivery-backoff'
import type { SpeechKind } from '../../domain/speech/kinds'

/** 随这句一起发的图(S2c):新贴纸 / 明信片。 */
export type PendingAttach = { sticker: { mood: string; path: string } } | { file: string }

/** id:入队时给,说完只删这次真说了的那几条(flush 发送途中又进来的不会被一并删掉;整合者评审 #531)。 */
export interface PendingNotice { id: string; kind: SpeechKind; chatId: string; text: string; at: string; attach?: PendingAttach }

export const MAX_PENDING_PER_CHAT = 20

export interface PendingNoticeInput {
  kind: SpeechKind
  chatId: string
  text: string
  id?: string
  /** 入队时刻(ISO);缺省 = 时钟。 */
  at?: string
  /** 过期时刻(毫秒);缺省 = 入队后 24 小时。 */
  expiresAt?: number
  attach?: PendingAttach
}

export interface PendingNotices {
  add(n: PendingNoticeInput): void
  /**
   * 到点的那几条对话(按最早入队排),每组带上被挤掉的条数。**一条对话里还有在退避的 ⇒ 整条对话这一拍不说**
   * (同一条对话的话合成一句,线断了再撞也没用)。最多 limit 组(每一拍有上限,静音一结束不一口气冒一串)。
   */
  groups(nowMs?: number, limit?: number): Array<{ chatId: string; items: PendingNotice[]; dropped: number }>
  /** 这几条说完了:只删这几个 id;再删掉这次提过的 droppedTold 条 overflow。 */
  remove(chatId: string, ids: readonly string[], droppedTold: number): void
  /** 这几条补说发失败了:次数 +1、按 backoffMs 排下一次;回这一组现在的次数。 */
  failed(chatId: string, ids: readonly string[], nowMs?: number): number
  /** 过期的删掉,回给调用方记账。 */
  expire(nowMs?: number): Array<{ id: string; kind: SpeechKind; chatId: string }>
}

interface Row { id: string; kind: string; chat_id: string; body: string; attach: string | null; created_at: number; next_at: number; attempts: number }

const newId = (): string => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

export function makePendingNotices(o: {
  db: Db
  log: (tag: string, line: string) => void
  now?: () => number
  /** 给了 ⇒ 第一次开机把旧的 speech/pending-notices.json 读进表。 */
  stateDir?: string
}): PendingNotices {
  const { db } = o
  const now = o.now ?? Date.now
  const insert = (n: PendingNoticeInput & { status?: 'pending' | 'overflow' }, orIgnore = false): void => {
    const at = n.at ? Date.parse(n.at) : now()
    const created = Number.isFinite(at) ? at : now()
    db.query(`INSERT ${orIgnore ? 'OR IGNORE ' : ''}INTO speech_pending(id,lane,chat_id,kind,body,attach,ref,created_at,next_at,attempts,first_failed_at,expires_at,status)
      VALUES(?,'say',?,?,?,?,NULL,?,0,0,NULL,?,?)`)   // next_at = 0:新进来的下一拍就能说(退避只由 failed 排)
      .run(n.id ?? newId(), n.chatId, n.kind, n.text, n.attach ? JSON.stringify(n.attach) : null, created, n.expiresAt ?? created + RETRY_WINDOW_MS, n.status ?? 'pending')
  }
  const capChat = (chatId: string): void => {
    const ids = db.query<{ id: string }, [string]>("SELECT id FROM speech_pending WHERE lane='say' AND status='pending' AND chat_id=? ORDER BY created_at DESC, rowid DESC").all(chatId).map(r => r.id)
    const over = ids.slice(MAX_PENDING_PER_CHAT)
    if (over.length === 0) return
    for (const id of over) db.query("UPDATE speech_pending SET status='overflow' WHERE id=?").run(id)
    o.log('SPEECH', `pending notices for chat=${chatId} over ${MAX_PENDING_PER_CHAT} — dropped the oldest ${over.length} (the things themselves are still recorded elsewhere)`)
  }
  if (o.stateDir) importLegacy(o.stateDir, insert, capChat, o.log)
  const toNotice = (r: Row): PendingNotice => ({
    id: r.id, kind: r.kind as SpeechKind, chatId: r.chat_id, text: r.body, at: new Date(r.created_at).toISOString(),
    ...(r.attach ? { attach: JSON.parse(r.attach) as PendingAttach } : {}),
  })
  return {
    add(input) {
      db.transaction(() => { insert(input); capChat(input.chatId) })()
    },
    groups(nowMs = now(), limit = Number.MAX_SAFE_INTEGER) {
      const chats = db.query<{ chat_id: string }, [number]>(`SELECT chat_id FROM speech_pending WHERE lane='say' AND status='pending'
        GROUP BY chat_id HAVING MAX(next_at) <= ? ORDER BY MIN(created_at), MIN(rowid) LIMIT ${Math.max(0, Math.trunc(Math.min(limit, 1_000_000)))}`).all(nowMs)
      return chats.map(({ chat_id: chatId }) => ({
        chatId,
        items: db.query<Row, [string]>("SELECT id,kind,chat_id,body,attach,created_at,next_at,attempts FROM speech_pending WHERE lane='say' AND status='pending' AND chat_id=? ORDER BY created_at, rowid").all(chatId).map(toNotice),
        dropped: db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM speech_pending WHERE lane='say' AND status='overflow' AND chat_id=?").get(chatId)!.n,
      }))
    },
    remove(chatId, ids, droppedTold) {
      db.transaction(() => {
        for (const id of ids) db.query("DELETE FROM speech_pending WHERE lane='say' AND chat_id=? AND id=?").run(chatId, id)
        if (droppedTold > 0) {
          db.query(`DELETE FROM speech_pending WHERE id IN (SELECT id FROM speech_pending WHERE lane='say' AND status='overflow' AND chat_id=? ORDER BY created_at, rowid LIMIT ?)`).run(chatId, droppedTold)
        }
      })()
    },
    failed(chatId, ids, nowMs = now()) {
      let attempts = 0
      db.transaction(() => {
        for (const id of ids) {
          db.query("UPDATE speech_pending SET attempts=attempts+1, first_failed_at=COALESCE(first_failed_at, ?) WHERE lane='say' AND chat_id=? AND id=?").run(nowMs, chatId, id)
        }
        // 这一组按最多的那一次退避(同一条对话的话一起说,一起等)
        attempts = db.query<{ n: number | null }, [string]>("SELECT MAX(attempts) AS n FROM speech_pending WHERE lane='say' AND status='pending' AND chat_id=?").get(chatId)!.n ?? 1
        const next = nowMs + backoffMs(Math.max(1, attempts))
        for (const id of ids) db.query("UPDATE speech_pending SET next_at=? WHERE lane='say' AND chat_id=? AND id=?").run(next, chatId, id)
      })()
      return attempts
    },
    expire(nowMs = now()) {
      return db.transaction(() => {
        // overflow 的本来就不说了(只是计数),过期了悄悄删;在等的那几条回给调用方记「过期作废」
        const rows = db.query<{ id: string; kind: string; chat_id: string }, [number]>("SELECT id,kind,chat_id FROM speech_pending WHERE lane='say' AND status='pending' AND expires_at <= ? ORDER BY created_at, rowid").all(nowMs)
        db.query("DELETE FROM speech_pending WHERE lane='say' AND expires_at <= ?").run(nowMs)
        return rows.map(r => ({ id: r.id, kind: r.kind as SpeechKind, chatId: r.chat_id }))
      })()
    },
  }
}

/**
 * 旧的 speech/pending-notices.json(S2b 之前)读进表:每一条 id 原样(INSERT OR IGNORE ⇒ 读到一半崩了再开机不会重复),
 * 被挤掉的计数变成同样条数的 overflow 行(说的时候照样带「还有 N 件更早的」)。读完改名 `.migrated`。
 * 过期时间按入队时刻 + 24 小时算:早就过了的,下一拍 flush 记一行「过期作废」,不补说。
 */
function importLegacy(
  stateDir: string,
  insert: (n: PendingNoticeInput & { status?: 'pending' | 'overflow' }, orIgnore?: boolean) => void,
  capChat: (chatId: string) => void,
  log: (tag: string, line: string) => void,
): void {
  const file = join(stateDir, 'speech', 'pending-notices.json')
  if (!existsSync(file)) return
  let v: { items?: unknown; dropped?: unknown }
  try { v = readJsonFile<{ items?: unknown; dropped?: unknown }>(file) } catch (err) {
    log('SPEECH', `pending-notices.json unreadable, left in place: ${err instanceof Error ? err.message : String(err)}`)
    return
  }
  const items = Array.isArray(v.items) ? v.items as Array<Partial<PendingNotice>> : []
  const dropped = v.dropped && typeof v.dropped === 'object' ? v.dropped as Record<string, unknown> : {}
  let n = 0
  const chats = new Set<string>()
  for (const it of items) {
    if (typeof it.chatId !== 'string' || typeof it.text !== 'string' || typeof it.kind !== 'string') continue
    insert({ kind: it.kind as SpeechKind, chatId: it.chatId, text: it.text, ...(typeof it.id === 'string' ? { id: it.id } : {}), ...(typeof it.at === 'string' ? { at: it.at } : {}) }, true)
    chats.add(it.chatId); n++
  }
  for (const [chatId, count] of Object.entries(dropped)) {
    const c = typeof count === 'number' && Number.isFinite(count) ? Math.min(Math.trunc(count), 1000) : 0
    for (let i = 0; i < c; i++) insert({ kind: 'boot_notice', chatId, text: '', id: `legacy-dropped-${chatId}-${i}`, status: 'overflow' }, true)
  }
  for (const c of chats) capChat(c)
  renameMigrated(file)
  log('SPEECH', `imported ${n} pending notice(s) from speech/pending-notices.json into speech_pending`)
}

/** 一条对话压着的几句合成一句。 */
export function mergePending(items: readonly PendingNotice[], dropped: number): string {
  const more = dropped > 0 ? `\n(还有 ${dropped} 件更早的,去 App 或电脑上看)` : ''
  if (items.length === 1 && dropped === 0) return items[0]!.text
  return `刚才没顾上跟你说的几件事:\n${items.map(i => `· ${i.text}`).join('\n')}${more}`
}

/** 多久把压着的几句再问一次门。 */
export const PENDING_FLUSH_MS = 5 * 60_000

/** 每一拍最多补说几条对话(每条对话合成一句)。 */
export const MAX_FLUSH_CHATS_PER_TICK = 3

/**
 * 「待说」的那一拍:门这一层自己起,main.ts 用 lc.register 登记,关机停。只有这一个触发点
 * (不挂在伙伴那一拍上 —— 主动关心关了那一拍就不跑;整合者评审 #528)。
 */
export function startPendingFlush(speech: { flushPending(): Promise<void> }, log: (tag: string, line: string) => void, intervalMs = PENDING_FLUSH_MS): import('../../lib/lifecycle').Lifecycle {
  const timer = setInterval(() => {
    void speech.flushPending().catch(err => log('SPEECH', `pending flush failed: ${err instanceof Error ? err.message : String(err)}`))
  }, intervalMs)
  timer.unref?.()
  return { name: 'speech-pending-flush', stop: async () => { clearInterval(timer) } }
}

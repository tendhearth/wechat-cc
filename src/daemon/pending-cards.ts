/**
 * 重启前挂着的拍板卡(v91 pending_cards,主人 2026-10-28 定)。
 *
 * 待批登记处(pending-permissions.ts)只在内存里:daemon 一停,挂着的卡就没了 —— 关机那一轮按「拒」答回执行者,
 * 重启后主人回的「y」是普通聊天,什么都批不了(这是要的:重启前的东西重启后一律不放行)。缺的是告诉主人。
 *
 * 所以登记处每开一张发给某个 chat 的卡就落一行(chat + 一句话说要做什么),卡了结(批 / 拒 / 过期 / 没送到)就删。
 * 落在开卡的时候而不是关机的时候:daemon 崩了、被 SIGKILL,没走关机,也留得下。
 * 下次开机(地基里、任何新卡之前)把上一个进程留下的读出来;开机走完,按 chat 各说一次「作废了」,再删掉。
 * 写表失败只记日志,绝不影响拍板本身。
 */
import type { Db } from '../lib/db'
import { redactSecrets } from '../domain/cli-transcript'
import type { PendingCardJournal } from './pending-permissions'

export interface PendingCardRow { hash: string; chatId: string; summary: string; createdAt: number; expiresAt: number }

/** 卡上一句话:最多这么多个字(微信里一行看得完)。 */
export const CARD_SUMMARY_MAX = 40

/**
 * 卡片正文 → 一句话说要做什么。「Codex 想执行命令:\nrm -rf dist」⇒「Codex 想执行命令:rm -rf dist」:
 * 头一行以冒号收尾就接上第二行;空白压成一个空格;密钥先打码;超长截断加「…」。
 */
export function cardSummary(prompt: string): string {
  const lines = redactSecrets(prompt).split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean)
  if (lines.length === 0) return '一项操作'
  let s = lines[0]!
  if (/[:：]$/.test(s) && lines[1]) s = `${s}${lines[1]}`
  const chars = [...s]
  return chars.length <= CARD_SUMMARY_MAX ? s : `${chars.slice(0, CARD_SUMMARY_MAX - 1).join('')}…`
}

/** 给主人的那一句:一张 ⇒ 带着那一句话;几张 ⇒ 一条消息里逐行列出来。 */
export function voidedCardsNotice(summaries: readonly string[]): string {
  if (summaries.length === 1) return `重启前那张「${summaries[0]}」的卡作废了，还要的话再说一次。`
  return `重启前有 ${summaries.length} 张卡作废了：\n${summaries.map(s => `「${s}」`).join('\n')}\n还要的话再说一次。`
}

export function makePendingCardsStore(db: Db) {
  return {
    add(r: PendingCardRow): void {
      db.query('INSERT OR REPLACE INTO pending_cards(hash,chat_id,summary,created_at,expires_at) VALUES(?,?,?,?,?)')
        .run(r.hash, r.chatId, r.summary, r.createdAt, r.expiresAt)
    },
    remove(hash: string): void {
      db.query('DELETE FROM pending_cards WHERE hash=?').run(hash)
    },
    /** 这一刻之前开的(= 上一个进程留下的),按开卡先后。 */
    before(ts: number): PendingCardRow[] {
      return db.query<PendingCardRow, [number]>('SELECT hash,chat_id AS chatId,summary,created_at AS createdAt,expires_at AS expiresAt FROM pending_cards WHERE created_at<? ORDER BY created_at,hash').all(ts)
    },
    clearBefore(ts: number): number {
      return db.query('DELETE FROM pending_cards WHERE created_at<?').run(ts).changes
    },
  }
}

export type PendingCardsStore = ReturnType<typeof makePendingCardsStore>

export function makePendingCardJournal(store: PendingCardsStore, log: (tag: string, line: string) => void): PendingCardJournal {
  const why = (e: unknown) => (e instanceof Error ? e.message : String(e))
  return {
    opened(hash, meta, createdAt, expiresAt) {
      // 没有 chat 的(只登记、手机拍板,没绑微信)重启后没处说,不记
      if (!meta.chatId) return
      try { store.add({ hash, chatId: meta.chatId, summary: cardSummary(meta.prompt), createdAt, expiresAt }) }
      catch (e) { log('PERMISSION', `pending card journal add failed: ${why(e)}`) }
    },
    settled(hash) {
      try { store.remove(hash) } catch (e) { log('PERMISSION', `pending card journal remove failed: ${why(e)}`) }
    },
  }
}

/** 地基开机时取一次:上一个进程留下的卡,以及说完以后怎么清。 */
export interface VoidedCards {
  cards: PendingCardRow[]
  clear(): void
}

export function takeVoidedCards(store: PendingCardsStore, bootAt: number, log: (tag: string, line: string) => void): VoidedCards {
  let cards: PendingCardRow[] = []
  try { cards = store.before(bootAt) } catch (e) { log('PERMISSION', `voided cards read failed: ${e instanceof Error ? e.message : String(e)}`) }
  return {
    cards,
    clear() { try { store.clearBefore(bootAt) } catch (e) { log('PERMISSION', `voided cards clear failed: ${e instanceof Error ? e.message : String(e)}`) } },
  }
}

/**
 * 开机走完后说一次:每个 chat 一条。已经过了有效期的卡不提(不重启它也已经过期了)。
 * 交给 CC 开口那道门(restart_voided_cards,report):发不出去 / 被推后由门的待说队列接住,这里不重试。
 * 交出去就清表 —— 下次开机不再说第二遍。
 */
export function reportVoidedCards(d: {
  voided: VoidedCards
  now: number
  speech: { tell(kind: 'restart_voided_cards', chatId: string, text: string): Promise<boolean> }
  log: (tag: string, line: string) => void
}): void {
  const byChat = new Map<string, string[]>()
  for (const c of d.voided.cards) {
    if (c.expiresAt <= d.now) continue
    byChat.set(c.chatId, [...(byChat.get(c.chatId) ?? []), c.summary])
  }
  d.voided.clear()
  if (d.voided.cards.length) d.log('PERMISSION', `voided ${d.voided.cards.length} card(s) from before the restart; telling ${byChat.size} chat(s)`)
  for (const [chatId, summaries] of byChat) {
    void d.speech.tell('restart_voided_cards', chatId, voidedCardsNotice(summaries))
      .then(sent => { if (!sent) d.log('PERMISSION', `voided-cards notice to ${chatId} not sent now (deferred or send failed)`) })
      .catch(err => d.log('PERMISSION', `voided-cards notice to ${chatId} failed: ${err instanceof Error ? err.message : String(err)}`))
  }
}

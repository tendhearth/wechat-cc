/**
 * 「待说」队列:report / blocking 被推后了不能丢(第三批 3a「defer 不是不送」,9d 评审 #528 / #530)。
 *
 * 只发一次的那几句(社交的来信 / 结果、定时被暂停、升级完、开机有几样没起来 …)被门推后 ⇒ 落盘在这里;
 * 门这一层定时 flush:每条对话合成一句(「刚才没顾上跟你说的几件事」),放行就说完、清掉。
 * initiative 不进来 —— 那一类推后就是这一句不说。
 * 落盘:speech/pending-notices.json(读用 readJsonFile 容忍 BOM;写 tmp + rename)。超过上限丢最老的,记一行日志,
 * 说的时候带一句「还有 N 件更早的」,不悄悄少。
 */
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readJsonFile } from '../../lib/read-json-file'
import type { SpeechKind } from '../../core/speech/kinds'

export interface PendingNotice { kind: SpeechKind; chatId: string; text: string; at: string }

export const MAX_PENDING_PER_CHAT = 20

export interface PendingNotices {
  add(n: PendingNotice): void
  /** 按对话分组;每组带上因为超过上限丢掉的条数。 */
  groups(): Array<{ chatId: string; items: PendingNotice[]; dropped: number }>
  /** 这条对话说完了:清掉它的条目和丢弃计数。 */
  clear(chatId: string): void
}

type Store = { items: PendingNotice[]; dropped: Record<string, number> }

export function makePendingNotices(o: { stateDir: string; log: (tag: string, line: string) => void; now?: () => number }): PendingNotices {
  const dir = join(o.stateDir, 'speech')
  const path = join(dir, 'pending-notices.json')
  const read = (): Store => {
    if (!existsSync(path)) return { items: [], dropped: {} }
    try {
      const v = readJsonFile<Partial<Store>>(path)
      return { items: Array.isArray(v.items) ? v.items : [], dropped: v.dropped && typeof v.dropped === 'object' ? v.dropped : {} }
    } catch { return { items: [], dropped: {} } }
  }
  const write = (s: Store): void => {
    mkdirSync(dir, { recursive: true })
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
    writeFileSync(tmp, JSON.stringify(s))
    renameSync(tmp, path)
  }
  return {
    add(n) {
      const s = read()
      const mine = [...s.items.filter(i => i.chatId === n.chatId), n]
      const over = Math.max(0, mine.length - MAX_PENDING_PER_CHAT)
      if (over > 0) o.log('SPEECH', `pending notices for chat=${n.chatId} over ${MAX_PENDING_PER_CHAT} — dropped the oldest ${over} (the things themselves are still recorded elsewhere)`)
      write({
        items: [...s.items.filter(i => i.chatId !== n.chatId), ...mine.slice(over)],
        dropped: { ...s.dropped, ...(over > 0 ? { [n.chatId]: (s.dropped[n.chatId] ?? 0) + over } : {}) },
      })
    },
    groups() {
      const s = read()
      const chats = [...new Set(s.items.map(i => i.chatId))]
      return chats.map(chatId => ({ chatId, items: s.items.filter(i => i.chatId === chatId), dropped: s.dropped[chatId] ?? 0 }))
    },
    clear(chatId) {
      const s = read()
      const { [chatId]: _gone, ...dropped } = s.dropped
      write({ items: s.items.filter(i => i.chatId !== chatId), dropped })
    },
  }
}

/** 一条对话压着的几句合成一句。 */
export function mergePending(items: readonly PendingNotice[], dropped: number): string {
  const more = dropped > 0 ? `\n(还有 ${dropped} 件更早的,去 App 或电脑上看)` : ''
  if (items.length === 1 && dropped === 0) return items[0]!.text
  return `刚才没顾上跟你说的几件事:\n${items.map(i => `· ${i.text}`).join('\n')}${more}`
}

/** 多久把压着的几句再问一次门。 */
export const PENDING_FLUSH_MS = 5 * 60_000

/**
 * 「待说」的那一拍:门这一层自己起,main.ts 用 lc.register 登记,关机停。只有这一个触发点
 * (不挂在伙伴那一拍上 —— 主动关心关了那一拍就不跑;9d 评审 #528)。
 */
export function startPendingFlush(speech: { flushPending(): Promise<void> }, log: (tag: string, line: string) => void, intervalMs = PENDING_FLUSH_MS): import('../../lib/lifecycle').Lifecycle {
  const timer = setInterval(() => {
    void speech.flushPending().catch(err => log('SPEECH', `pending flush failed: ${err instanceof Error ? err.message : String(err)}`))
  }, intervalMs)
  timer.unref?.()
  return { name: 'speech-pending-flush', stop: async () => { clearInterval(timer) } }
}

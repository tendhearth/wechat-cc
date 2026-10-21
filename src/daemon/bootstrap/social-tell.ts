/**
 * 告诉主人一句社交上的事(笔友来信、心愿的答复、介绍、串门见闻)—— 第三批 3a。
 * 先问 CC 开口那道门(kind 决定别烦我 / 免打扰拦不拦,见 core/speech/kinds 的 social_*),放行才经 sendAssistantText 发:
 * 它还管 App 那头的回话截获和旁听,投递不动,只把「能不能说」交给门。门取不到 ⇒ 不发、记一行,不退回直接发。
 *
 * **report / blocking 推后不是不送**(9d 评审 #528):别人写给主人的(来信、结果)和等主人拍板的(介绍)被推后 ⇒
 * 落盘进一个「待说」小队列(companion/pending-social-notices.json),伙伴下一拍调 `flush()`,门放行时一次说完
 * (几条合成一句)。以前社交通知不看免打扰,半夜来信主人会收到一句;推后了就再也不说,对 report 来说比以前更差。
 * CC 自己的见闻(initiative)推后就是这一句不说 —— 东西在背包里,不排队。
 */
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readJsonFile } from '../../lib/read-json-file'
import { originOf, type SocialNotice } from '../../core/speech/kinds'
import type { SpeechPolicy } from '../speech/policy'

interface PendingNotice { kind: SocialNotice; text: string; at: string }
/** 压着的超过这么多条 ⇒ 丢最老的(主人在信箱 / 觅食台里照样看得到内容,这里只是「提一句」)。 */
const MAX_PENDING = 20

export interface TellOwner {
  tell(kind: SocialNotice, text: string): Promise<void>
  /** 有压着的就再问一次门;放行 ⇒ 合成一句说完、清空。伙伴每一拍调。 */
  flush(): Promise<void>
}

export function makeTellOwner(d: {
  stateDir: string
  resolveOperatorChatId: () => string | null
  sendAssistantText: ((chatId: string, text: string) => Promise<unknown>) | undefined
  speech?: () => SpeechPolicy | null
  log: (tag: string, line: string) => void
}): TellOwner {
  const path = join(d.stateDir, 'companion', 'pending-social-notices.json')
  /** 压着的几条 + 因为超过上限丢掉的条数(说的时候要提一句,不悄悄少)。 */
  type Queue = { items: PendingNotice[]; dropped: number }
  const read = (): Queue => {
    if (!existsSync(path)) return { items: [], dropped: 0 }
    try {
      const v = readJsonFile<unknown>(path)   // 容忍 BOM(Windows 真机踩过);仓库守卫不许裸的 JSON.parse(readFileSync)
      if (Array.isArray(v)) return { items: v as PendingNotice[], dropped: 0 }
      const q = v as Partial<Queue>
      return { items: Array.isArray(q.items) ? q.items : [], dropped: typeof q.dropped === 'number' ? q.dropped : 0 }
    } catch { return { items: [], dropped: 0 } }
  }
  const write = (q: Queue): void => {
    mkdirSync(join(d.stateDir, 'companion'), { recursive: true })
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
    writeFileSync(tmp, JSON.stringify(q))
    renameSync(tmp, path)
  }
  const ready = (): { op: string; send: (chatId: string, text: string) => Promise<unknown>; speech: SpeechPolicy } | null => {
    const op = d.resolveOperatorChatId()
    const send = d.sendAssistantText
    if (!op || !send) return null
    const speech = d.speech?.()
    if (!speech) { d.log('SOCIAL', 'notice not sent: speech policy not wired yet'); return null }
    return { op, send, speech }
  }

  return {
    async tell(kind, text) {
      const r = ready()
      if (!r) return
      try {
        const o = await r.speech.say({ kind, chatId: r.op }, async () => { await r.send(r.op, text) })
        if ('allow' in o) return
        if ('defer' in o && originOf(kind) !== 'initiative') {
          const q = read()
          const all = [...q.items, { kind, text, at: new Date().toISOString() }]
          const over = Math.max(0, all.length - MAX_PENDING)
          if (over > 0) d.log('SOCIAL', `pending notices over ${MAX_PENDING} — dropped the oldest ${over} (content stays in the mailbox / records)`)
          write({ items: all.slice(over), dropped: q.dropped + over })
          d.log('SOCIAL', `${kind} notice deferred (${o.reason}) — kept to say later (${all.length - over} pending)`)
          return
        }
        d.log('SOCIAL', `${kind} notice ${'defer' in o ? 'deferred' : 'dropped'}: ${o.reason}`)
      } catch (err) {
        d.log('SOCIAL', `${kind} notice failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
    async flush() {
      const { items, dropped } = read()
      if (items.length === 0) return
      const r = ready()
      if (!r) return
      // 有等主人拍板的就按 blocking 问(免打扰不拦);否则按 report(免打扰推后)
      const kind: SocialNotice = items.some(i => i.kind === 'social_ask') ? 'social_ask' : 'social_result'
      const more = dropped > 0 ? `\n(还有 ${dropped} 件更早的,去信箱看)` : ''
      const text = (items.length === 1 && dropped === 0 ? items[0]!.text : `刚才没顾上跟你说的几件事:\n${items.map(i => `· ${i.text}`).join('\n')}`) + more
      try {
        const o = await r.speech.say({ kind, chatId: r.op }, async () => { await r.send(r.op, text) })
        if ('allow' in o) { write({ items: [], dropped: 0 }); d.log('SOCIAL', `told ${items.length} pending notice(s)${dropped ? ` (+${dropped} older, pointed to the mailbox)` : ''}`) }
      } catch (err) {
        d.log('SOCIAL', `pending notices not told: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
  }
}

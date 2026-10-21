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
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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
  const read = (): PendingNotice[] => {
    if (!existsSync(path)) return []
    try { const v = JSON.parse(readFileSync(path, 'utf8')) as unknown; return Array.isArray(v) ? v as PendingNotice[] : [] } catch { return [] }
  }
  const write = (items: PendingNotice[]): void => {
    mkdirSync(join(d.stateDir, 'companion'), { recursive: true })
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
    writeFileSync(tmp, JSON.stringify(items))
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
          const items = [...read(), { kind, text, at: new Date().toISOString() }].slice(-MAX_PENDING)
          write(items)
          d.log('SOCIAL', `${kind} notice deferred (${o.reason}) — kept to say later (${items.length} pending)`)
          return
        }
        d.log('SOCIAL', `${kind} notice ${'defer' in o ? 'deferred' : 'dropped'}: ${o.reason}`)
      } catch (err) {
        d.log('SOCIAL', `${kind} notice failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
    async flush() {
      const items = read()
      if (items.length === 0) return
      const r = ready()
      if (!r) return
      // 有等主人拍板的就按 blocking 问(免打扰不拦);否则按 report(免打扰推后)
      const kind: SocialNotice = items.some(i => i.kind === 'social_ask') ? 'social_ask' : 'social_result'
      const text = items.length === 1 ? items[0]!.text : `刚才没顾上跟你说的几件事:\n${items.map(i => `· ${i.text}`).join('\n')}`
      try {
        const o = await r.speech.say({ kind, chatId: r.op }, async () => { await r.send(r.op, text) })
        if ('allow' in o) { write([]); d.log('SOCIAL', `told ${items.length} pending notice(s)`) }
      } catch (err) {
        d.log('SOCIAL', `pending notices not told: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
  }
}

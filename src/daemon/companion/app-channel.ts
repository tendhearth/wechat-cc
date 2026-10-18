/**
 * app-channel.ts — CC 主动找你落到 App 的那一头(proactive-channel.ts 的 AppChannel 实现)。
 *
 * 「送到 App」= 两件事:
 *   1. 记成主人对话里 CC 的一行 —— 与 App 对话页(/m/api/chat)读的同一张 messages 表、同一个 chat,
 *      source 记 `phone`(App 上看到的「来自手机」,这一句确实只送到了手机);再捅一下主题,开着的 App 立刻刷新。
 *   2. 整轮一条 `companion` 推送(协议包 PushKind;iOS category th.companion,安卓渠道 updates),
 *      点开去对话页。正在连着的设备跳过推送(它正看着主题,与其它推送同一规矩)。
 *
 * 「送得到」= 这是主人那条对话(手机对话认的同一个 chat),且至少一台**还配对着**的设备登记了推送,
 * 或者此刻正连着。没开中继 v2 / 没配对 ⇒ 这里根本不接线(proactive-channel 只剩微信)。
 */
import type { MessageRecord } from '../../lib/messages-store'
import type { PushPayload } from '../phone-push'
import type { AppChannel } from './proactive-channel'

/** 推送正文上限(同终端会话推送 cli-app-push 的 280 字,超出截断加「…」;phone-push 自己还有 300 的硬上限)。 */
export const COMPANION_PUSH_BODY_MAX = 280

export function companionPushPayload(text: string): PushPayload {
  const a = [...text.trim()]
  const body = a.length <= COMPANION_PUSH_BODY_MAX ? a.join('') : a.slice(0, COMPANION_PUSH_BODY_MAX - 1).join('') + '…'
  return { kind: 'companion', title: 'CC', body }
}

export interface AppChannelDeps {
  /** 手机对话认的主人 chat(makePhoneChatId);没有 ⇒ null。 */
  ownerChatId(): string | null
  /** 登记了推送、且还配对着的设备 id。 */
  pushDevices(): string[]
  /** 此刻连着(订阅着主题)的设备 id。 */
  onlineDevices(): Set<string>
  append(rec: MessageRecord): Promise<number>
  /** 记了一行之后:「一件事」活动时间 + 手机主题重算。 */
  touched(): void
  /** = fanoutPush(在线的跳过)。 */
  push(p: PushPayload): { sent: number; online: number } | null
  now?: () => number
  log(tag: string, line: string): void
}

export function makeAppChannel(deps: AppChannelDeps): AppChannel {
  const now = deps.now ?? (() => Date.now())
  let seq = 0
  return {
    deliverable(chatId) {
      const owner = deps.ownerChatId()
      if (!owner || owner !== chatId) return false
      return deps.pushDevices().length > 0 || deps.onlineDevices().size > 0
    },
    async record(chatId, text) {
      const t = now()
      try {
        await deps.append({ id: `app:companion:${t}:${seq++}:out`, chatId, ts: new Date(t).toISOString(), direction: 'out', kind: 'text', text, source: 'phone' })
      } catch (e) {
        deps.log('COMPANION_APP', `record failed: ${e instanceof Error ? e.message : String(e)}`)
        return false
      }
      try { deps.touched() } catch { /* 刷新只是提早看见,下次拉取照样有 */ }
      return true
    },
    push(text) {
      const r = deps.push(companionPushPayload(text))
      // 正文不进日志。
      deps.log('COMPANION_APP', r ? `push companion: sent to ${r.sent} device(s)${r.online ? `, ${r.online} online skipped` : ''}` : 'push companion: no push channel')
    },
  }
}

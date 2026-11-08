/**
 * proactive-channel.ts — CC 主动找你的两条路(主人 2026-10-18 拍板,手机伙伴第 1 步)。
 *
 * 伙伴推送(到点的跟进 / 问候 / 打猎)与提醒,以前只有微信一条路:微信断线 / 主动推送窗口关了,
 * 这句话就没了。现在 App 是第二条路,规矩只有一条 —— **微信能用就走微信,不能用才落到 App**:
 *
 *   1. 微信能用(没 degraded、主人那条的推送窗口没有已知关闭)⇒ 照旧发微信。成功的那一行由
 *      ilink-glue 记进消息库,App 对话页本来就看得见;不推 App(免得响两次)。
 *   2. 微信不能用,或发了失败(-2 / 别的送达失败),而 App 送得到(主人那条对话,至少一台配对
 *      设备登记了推送或正连着)⇒ 记成主人对话里 CC 的一行(App 对话页读的同一张表),整轮收尾时
 *      推一条 `companion` 通知(在线的设备跳过,它正看着主题)。
 *   3. 两条都不通 ⇒ 同改造前(微信该怎么失败还怎么失败,不多记一行)。
 *
 * 一轮里落定一条路就不再换(粘住):第一条在微信上成功,后面几条也走微信;落到 App,后面的也落 App
 * —— 一段话不会一半在微信、一半在手机。每条路每条消息只试一次,这里不重试(断线时停掉外发,
 * memory: no-retry-storm-when-disconnected);频率、care 档、无回复暂停仍只由 calibration 的
 * shouldSpeak 管,这里只管「往哪儿送」。投递不是模型调用,网络守护不管这一段。
 */

import type { TurnAttachment } from '../../domain/turn-reply'
import type { WechatSend } from '../../ports/wechat'
import type { AppAttachment } from '../app-reply'

export type ProactiveChannel = 'wechat' | 'app'

/** App 那条路(pipeline-deps 里接线:消息库 + 手机主题 + 中继 v2 推送)。 */
export interface AppChannel {
  /** 这个 chat 的话 App 收得到:是主人那条对话,且至少一台配对设备登记了推送(或正连着)。 */
  deliverable(chatId: string): boolean
  /** 记成主人对话里 CC 的一行 + 捅一下主题(App 对话页会刷新)。带附件 ⇒ 放 extras(信的几页)。成功 ⇒ true。 */
  record(chatId: string, text: string, attachments?: readonly AppAttachment[], metadata?: ProactiveMetadata): Promise<boolean>
  /** 一条 `companion` 推送(在线的设备跳过)。只投不等,失败只记日志。 */
  push(text: string): void
  /**
   * 一轮里的一个附件(表情 / 文件 / 语音)记成主人对话里 CC 的一行(附件在 extras,App 对话页照常画)。
   * 成功 ⇒ 推送里替它说的那几个字(语音 = 那段字;表情 / 文件 = 「[表情:开心]」这样的一小段);失败 ⇒ null。
   * 没有 ⇒ 第 1 步的样子(附件不发,语音改发字)。
   */
  recordAttachment?(chatId: string, a: TurnAttachment): Promise<string | null>
}

export interface ProactiveChannelDeps {
  /** 微信连接确认坏了(health.shouldSuspend('wechat'))。 */
  wechatDegraded(): boolean
  /** 这个 chat 的主动推送窗口已知关闭的时刻(ilink.proactiveClosedSince);开着 ⇒ null。 */
  wechatClosedSince(chatId: string): string | null
  sendWechat(chatId: string, text: string, metadata?: ProactiveMetadata): Promise<{ msgId: string; error?: string }>
  /** 微信那头发一个本地文件(ilink.sendFile;抛错由调用方折成 {error})。没接 ⇒ 微信那条路发不了文件。 */
  sendWechatFile?(chatId: string, path: string): Promise<{ error?: string }>
  /** 没开中继 v2 / 没配对 ⇒ null(只剩微信,即改造前)。懒取:App 那头比伙伴的 tick 晚接线。 */
  app(): AppChannel | null
  log(tag: string, line: string): void
}

/** 纯判断:微信能用就微信;否则 App 送得到就 App;都不行 ⇒ null。 */
export function chooseChannel(s: { wechatUsable: boolean; appDeliverable: boolean }): ProactiveChannel | null {
  if (s.wechatUsable) return 'wechat'
  if (s.appDeliverable) return 'app'
  return null
}

export type { ProactiveTurn } from '../../ports/proactive-turn'
import type { ProactiveTurn } from '../../ports/proactive-turn'

export type ProactiveMetadata = NonNullable<Parameters<WechatSend['sendMessage']>[2]>

export interface ProactiveOutbound {
  /** App 收得到这个 chat 的话吗(伙伴那一拍的闸要用)。 */
  appDeliverable(chatId: string): boolean
  /** 有没有哪条路送得到:微信没断,或 App 收得到。 */
  canDeliver(chatId: string): boolean
  /** 一轮(可能多条)的出口,路选定后粘住。 */
  open(chatId: string, metadata?: ProactiveMetadata): ProactiveTurn
  /** 单条(提醒):选路、送一次、落在 App 就推一次。 */
  sendOnce(chatId: string, text: string): Promise<{ ok: boolean; channel?: ProactiveChannel; error?: string }>
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

export function makeProactiveOutbound(deps: ProactiveChannelDeps): ProactiveOutbound {
  const appFor = (chatId: string): AppChannel | null => {
    try {
      const a = deps.app()
      return a && a.deliverable(chatId) ? a : null
    } catch (e) {
      deps.log('COMPANION_APP', `deliverable check failed (treated as not deliverable): ${errMsg(e)}`)
      return null
    }
  }
  const degraded = (): boolean => { try { return deps.wechatDegraded() } catch { return false } }
  const wechatUsable = (chatId: string): boolean => {
    if (degraded()) return false
    try { return deps.wechatClosedSince(chatId) === null } catch { return true }
  }

  function open(chatId: string, metadata?: ProactiveMetadata): ProactiveTurn {
    let sticky: ProactiveChannel | null = null
    const appTexts: string[] = []
    let app: AppChannel | null = null
    let seq = 0

    const toApp = async (a: AppChannel, text: string, silent = false): Promise<{ msgId: string; error?: string }> => {
      let ok = false
      try { ok = await (metadata ? a.record(chatId, text, undefined, metadata) : a.record(chatId, text)) } catch (e) { deps.log('COMPANION_APP', `chat=${chatId} record threw: ${errMsg(e)}`) }
      if (!ok) return { msgId: `err:${Date.now()}`, error: 'app_record_failed' }
      if (!silent) appTexts.push(text)
      return { msgId: `app:${Date.now()}:${seq++}` }
    }

    return {
      async sendText(_c, text) {
        if (sticky === 'app' && app) return toApp(app, text)
        if (sticky === 'wechat') return deps.sendWechat(chatId, text, ...(metadata ? [metadata] as const : []))
        const a = appFor(chatId)
        const pick = chooseChannel({ wechatUsable: wechatUsable(chatId), appDeliverable: !!a })
        if (pick === 'app' && a) {
          deps.log('COMPANION_APP', `chat=${chatId} wechat not usable (${degraded() ? 'degraded' : 'window closed'}) — delivering to the app`)
          sticky = 'app'; app = a
          return toApp(a, text)
        }
        // 微信能用 —— 或者两条都不通(⇒ 同改造前:照试微信一次,该怎么失败就怎么失败)。
        const r = await deps.sendWechat(chatId, text, ...(metadata ? [metadata] as const : []))
        if (!r.error) { sticky = 'wechat'; return r }
        if (a) {
          deps.log('COMPANION_APP', `chat=${chatId} wechat send failed (${r.error}) — delivering to the app instead`)
          sticky = 'app'; app = a
          return toApp(a, text)
        }
        return r
      },
      channel: () => sticky,
      textOnly: () => sticky === 'app',
      async sendTextWith(_c, text, wechat, o) {
        const silent = !!o?.silent
        const viaApp = async (a: AppChannel): Promise<{ ok: boolean; channel: ProactiveChannel | null }> => {
          if (o?.ready && !o.ready()) return { ok: false, channel: null }
          sticky = 'app'; app = a
          return { ok: !(await toApp(a, text, silent)).error, channel: 'app' as const }
        }
        const viaWechat = async (): Promise<'sent' | 'not_sent' | 'final'> => {
          try { return await wechat() } catch (e) { deps.log('COMPANION_APP', `chat=${chatId} own wechat sender threw: ${errMsg(e)}`); return 'final' }
        }
        if (sticky === 'app' && app) return viaApp(app)
        if (sticky === 'wechat') { const r = await viaWechat(); return { ok: r === 'sent', channel: 'wechat' } }
        const a = appFor(chatId)
        if (chooseChannel({ wechatUsable: wechatUsable(chatId), appDeliverable: !!a }) === 'app' && a) {
          deps.log('COMPANION_APP', `chat=${chatId} wechat not usable (${degraded() ? 'degraded' : 'window closed'}) — delivering to the app`)
          return viaApp(a)
        }
        const r = await viaWechat()
        if (r === 'sent') { sticky = 'wechat'; return { ok: true, channel: 'wechat' } }
        if (r === 'not_sent' && a) {
          deps.log('COMPANION_APP', `chat=${chatId} own wechat sender did not send — delivering to the app instead`)
          return viaApp(a)
        }
        return { ok: false, channel: null }
      },
      async sendSticker(_c, tag, path) {
        const toAppSticker = async (a: AppChannel): Promise<boolean> => {
          if (!a.recordAttachment) return false
          let said: string | null = null
          try { said = await a.recordAttachment(chatId, { kind: 'sticker', ref: { tag } }) } catch (e) { deps.log('COMPANION_APP', `chat=${chatId} record sticker threw: ${errMsg(e)}`) }
          if (said === null) return false
          sticky = 'app'; app = a
          if (said.trim()) appTexts.push(said)
          return true
        }
        const toWechatFile = async (): Promise<string | null> => {
          if (!deps.sendWechatFile) return 'no_wechat_file_sender'
          try { return (await deps.sendWechatFile(chatId, path)).error ?? null } catch (e) { return errMsg(e) }
        }
        if (sticky === 'app' && app) return toAppSticker(app)
        if (sticky === 'wechat') return (await toWechatFile()) === null
        const a = appFor(chatId)
        if (chooseChannel({ wechatUsable: wechatUsable(chatId), appDeliverable: !!a }) === 'app' && a) return toAppSticker(a)
        const err = await toWechatFile()
        if (err === null) { sticky = 'wechat'; return true }
        if (a) {
          deps.log('COMPANION_APP', `chat=${chatId} wechat sticker failed (${err}) — delivering to the app instead`)
          return toAppSticker(a)
        }
        return false
      },
      async sendAttachment(_c, a) {
        if (sticky !== 'app' || !app?.recordAttachment) return false
        let said: string | null = null
        try { said = await app.recordAttachment(chatId, a) } catch (e) { deps.log('COMPANION_APP', `chat=${chatId} record attachment threw: ${errMsg(e)}`) }
        if (said === null) return false
        if (said.trim()) appTexts.push(said)
        return true
      },
      finish() {
        if (sticky !== 'app' || !app || appTexts.length === 0) return
        const body = appTexts.join('\n\n')
        appTexts.length = 0
        try { app.push(body) } catch (e) { deps.log('COMPANION_APP', `chat=${chatId} push threw: ${errMsg(e)}`) }
      },
    }
  }

  return {
    appDeliverable: (chatId) => !!appFor(chatId),
    canDeliver: (chatId) => !degraded() || !!appFor(chatId),
    open,
    async sendOnce(chatId, text) {
      const t = open(chatId)
      let r: { msgId: string; error?: string }
      try { r = await t.sendText(chatId, text) } catch (e) { r = { msgId: `err:${Date.now()}`, error: errMsg(e) } }
      t.finish()
      const ch = t.channel()
      return r.error ? { ok: false, error: r.error } : { ok: true, ...(ch ? { channel: ch } : {}) }
    },
  }
}

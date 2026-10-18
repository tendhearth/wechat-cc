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

export type ProactiveChannel = 'wechat' | 'app'

/** App 那条路(pipeline-deps 里接线:消息库 + 手机主题 + 中继 v2 推送)。 */
export interface AppChannel {
  /** 这个 chat 的话 App 收得到:是主人那条对话,且至少一台配对设备登记了推送(或正连着)。 */
  deliverable(chatId: string): boolean
  /** 记成主人对话里 CC 的一行 + 捅一下主题(App 对话页会刷新)。成功 ⇒ true。 */
  record(chatId: string, text: string): Promise<boolean>
  /** 一条 `companion` 推送(在线的设备跳过)。只投不等,失败只记日志。 */
  push(text: string): void
}

export interface ProactiveChannelDeps {
  /** 微信连接确认坏了(health.shouldSuspend('wechat'))。 */
  wechatDegraded(): boolean
  /** 这个 chat 的主动推送窗口已知关闭的时刻(ilink.proactiveClosedSince);开着 ⇒ null。 */
  wechatClosedSince(chatId: string): string | null
  sendWechat(chatId: string, text: string): Promise<{ msgId: string; error?: string }>
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

export interface ProactiveTurn {
  /** 给回复交付用的一条文字出口(同 ilink.sendMessage 的形状)。 */
  sendText(chatId: string, text: string): Promise<{ msgId: string; error?: string }>
  /** 已经落在哪条路上;还没送出过 ⇒ null。 */
  channel(): ProactiveChannel | null
  /** 落在 App 上 ⇒ 附件不发(这一步只做文字;语音改发同样的字)。 */
  textOnly(): boolean
  /** 这一轮收尾:落在 App ⇒ 整轮的文字合成一条推送。没落在 App ⇒ 什么都不做。 */
  finish(): void
}

export interface ProactiveOutbound {
  /** App 收得到这个 chat 的话吗(伙伴那一拍的闸要用)。 */
  appDeliverable(chatId: string): boolean
  /** 有没有哪条路送得到:微信没断,或 App 收得到。 */
  canDeliver(chatId: string): boolean
  /** 一轮(可能多条)的出口,路选定后粘住。 */
  open(chatId: string): ProactiveTurn
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

  function open(chatId: string): ProactiveTurn {
    let sticky: ProactiveChannel | null = null
    const appTexts: string[] = []
    let app: AppChannel | null = null
    let seq = 0

    const toApp = async (a: AppChannel, text: string): Promise<{ msgId: string; error?: string }> => {
      let ok = false
      try { ok = await a.record(chatId, text) } catch (e) { deps.log('COMPANION_APP', `chat=${chatId} record threw: ${errMsg(e)}`) }
      if (!ok) return { msgId: `err:${Date.now()}`, error: 'app_record_failed' }
      appTexts.push(text)
      return { msgId: `app:${Date.now()}:${seq++}` }
    }

    return {
      async sendText(_c, text) {
        if (sticky === 'app' && app) return toApp(app, text)
        if (sticky === 'wechat') return deps.sendWechat(chatId, text)
        const a = appFor(chatId)
        const pick = chooseChannel({ wechatUsable: wechatUsable(chatId), appDeliverable: !!a })
        if (pick === 'app' && a) {
          deps.log('COMPANION_APP', `chat=${chatId} wechat not usable (${degraded() ? 'degraded' : 'window closed'}) — delivering to the app`)
          sticky = 'app'; app = a
          return toApp(a, text)
        }
        // 微信能用 —— 或者两条都不通(⇒ 同改造前:照试微信一次,该怎么失败就怎么失败)。
        const r = await deps.sendWechat(chatId, text)
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

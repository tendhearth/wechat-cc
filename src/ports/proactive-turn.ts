export type ProactiveChannel = 'wechat' | 'app'

import type { TurnAttachment } from '../domain/turn-reply'

export interface ProactiveTurn {
  /** External authorized delivery adapter has a successful receipt. */
  confirmDelivery?(channel: ProactiveChannel): void
  /** 给回复交付用的一条文字出口(同 ilink.sendMessage 的形状)。 */
  sendText(chatId: string, text: string): Promise<{ msgId: string; error?: string }>
  /** 已经落在哪条路上;还没送出过 ⇒ null。 */
  channel(): ProactiveChannel | null
  /** 落在 App 上 ⇒ 附件不进微信(第 2 步起由 sendAttachment 记进 App 对话页;记不了才退回语音改发字)。 */
  textOnly(): boolean
  /** 落在 App 上的这一轮的附件:记进 App 对话页。没落在 App / 记不了 ⇒ false(调用方退回第 1 步)。 */
  sendAttachment(chatId: string, a: TurnAttachment): Promise<boolean>
  /**
   * 主动发一张表情(新贴纸那一句,第三批 3a):跟 sendText 同一套选路、同样粘住。微信 ⇒ 发那张图的文件;
   * App ⇒ 记成表情引用(`{kind:'sticker', ref:{tag}}`,App 画成表情)。两条都不通 / 记不了 ⇒ false ——
   * 调用方就什么都别发,**不退成一句文字说明**(整合者评审)。
   * 跟 sendAttachment 分开:那个是回复交付用的(没落在 App 就回 false、让回复走它自己的微信路),语义不能动。
   */
  sendSticker(chatId: string, tag: string, path: string): Promise<boolean>
  /**
   * 一句文字,但**微信那条腿用调用方自己的发送口**(工作台通知:幂等 client_id + 绑定核对 + 服务端回执,不能换成
   * sendWechat;第三批 3a)。选路、粘住同 sendText。`wechat()` 回:
   *  - 'sent'      落在微信;
   *  - 'not_sent'  确定没发出去(推送窗口关了 / 还没有 context token)⇒ App 送得到就落 App;
   *  - 'final'     不许换路(被拦,或结果不明 —— 可能已经到了,换路会说两遍)。
   * `silent` ⇒ 落在 App 时只记进对话、收尾不推这一句(同一件事 App 已有自己的原生推送,免得响两次)。
   * `ready` ⇒ 落 App 前同步再核一次(工作台:请求还在等、绑定没变);不过 ⇒ 不记,回没送到。
   * 回 ok = 送到了,channel = 落在哪。可选:测试里的假通道不用实现;没有 ⇒ 调用方当没送到。
   */
  sendTextWith?(chatId: string, text: string, wechat: () => Promise<'sent' | 'not_sent' | 'final'>, o?: { silent?: boolean; ready?: () => boolean }): Promise<{ ok: boolean; channel: ProactiveChannel | null }>
  /** 这一轮收尾:落在 App ⇒ 整轮的文字合成一条推送。没落在 App ⇒ 什么都不做。 */
  finish(): void
}


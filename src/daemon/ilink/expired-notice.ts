/**
 * 账号被顶替(ilink errcode=-14,在别处重新扫码绑了同一个账号)时的通知。
 *
 * 以前发给「这个账号下聊过的每一个对话」,访客也收到「到桌面 dashboard 重新扫一次码」这种只对主人有意义的话
 * (2026-10-21 盘点主动发送时查到;红线:主人才该知道的事不给访客)。现在只发给 admin:
 * lib/access 的 isAdmin —— 没设 admins 的老装机,allowFrom 里的人全算 admin,跟权限模型一致。
 * 一个 admin 都没聊过 ⇒ 不发;桌面角标与面板(PR4 Task 16)照样看得见。
 */
export const EXPIRED_NOTIFY_TEXT = `这个微信号已经在别处重新扫码绑定了（你或别人把同一个微信号绑到了另一台电脑上的 CC 或 OpenClaw）。
这台电脑上的 CC 从现在起收不到新消息。
要继续在这台用，打开电脑上的 Tendhearth CC，重新扫一次码。`

export function expiredNoticeRecipients(chatsOnAccount: readonly string[], isAdmin: (chatId: string) => boolean): string[] {
  return chatsOnAccount.filter(c => isAdmin(c))
}

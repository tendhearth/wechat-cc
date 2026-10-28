import type { MessageKey } from '../i18n'

/**
 * 一件事从哪来的(2026-10-19):头像组旁边一个单色小字形,读屏念「从微信来的」这类话。
 * 只画出生地(daemon 建这件事时写一次),不画露过面的多端;老的事 / 老 daemon 不带 ⇒ 不画。
 * 跟桌面 / 手机网页的 apps/desktop/src/shared/agent-avatars.js 同一组字形(这里是同一份路径渲成的 PNG)。
 * 纯函数;画法在 ui/OriginMark.tsx。
 */
export const MATTER_ORIGINS = ['wechat', 'desktop', 'app', 'web', 'cli', 'companion'] as const
export type MatterOrigin = typeof MATTER_ORIGINS[number]

/** 认得的出生地才算;别的(空的 / 未来的新值)当不知道。 */
export function matterOrigin(value: unknown): MatterOrigin | null {
  return typeof value === 'string' && (MATTER_ORIGINS as readonly string[]).includes(value) ? value as MatterOrigin : null
}

/** 读屏 / 详情里的那句话的词条。 */
export function originKey(origin: MatterOrigin): MessageKey {
  return `origin.${origin}` as MessageKey
}

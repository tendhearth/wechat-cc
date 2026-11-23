import { typeScale, type TypeRole } from '@wechat-cc/design-tokens'

export type TextVoice = 'cc'

// 手写字字面偏小，沿用桌面 15 → 18.5 的比例，取半点并按角色放开行高。
// 手机回复 16 → 19.5，「地方」现状和审批意见 13 → 16。
const CC_VOICE_SCALE = 18.5 / 15
const CC_VOICE_FAMILY = 'THPenHand-Regular'

export function phoneFont(role: TypeRole | 'code', { content = 'ui', text, voice }: {
  content?: 'ui' | 'user'; text?: string; voice?: TextVoice
} = {}) {
  if (role === 'code') return { fontFamily: 'mono', fontSize: 13, lineHeight: 19, letterSpacing: 0 }
  const s = typeScale[role]
  // 顶栏的普通标题也沿用 wordmark 的字号阶梯，只有字标本身保留原字体。
  const wordmark = role === 'wordmark' && content === 'ui' && (text === 'Tendhearth' || text === 'CC')
  const hand = voice === 'cc' && !wordmark
  const fontSize = hand ? Math.round(s.phone * CC_VOICE_SCALE * 2) / 2 : s.phone
  return {
    fontFamily: wordmark ? 'THSerif4-Medium' : hand ? CC_VOICE_FAMILY : undefined,
    ...(s.weight === 'medium' && !wordmark && !hand ? { fontWeight: '500' as const } : {}),
    fontSize,
    lineHeight: Math.round(fontSize * s.lineHeight),
    letterSpacing: s.phone * s.tracking,
  }
}

/** Txt 的 children 里能读出的纯文本(字符串 / 数字 / 它们的数组);有别的节点 ⇒ undefined(不知道内容)。 */
export function plainText(children: unknown): string | undefined {
  if (typeof children === 'string' || typeof children === 'number') return String(children)
  if (children === null || children === undefined || typeof children === 'boolean') return ''
  if (Array.isArray(children)) {
    let out = ''
    for (const ch of children) { const s = plainText(ch); if (s === undefined) return undefined; out += s }
    return out
  }
  return undefined
}

/** 字体没好也没错 ⇒ 等;好了或出错 ⇒ 放行(出错时 fontFamily 找不到,iOS / Android 退回系统无衬线,绝不卡住页面)。 */
export function fontGate(loaded: boolean, error: Error | null): 'wait' | 'go' {
  return loaded || error ? 'go' : 'wait'
}

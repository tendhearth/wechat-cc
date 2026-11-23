import { typeScale, type TypeRole } from '@wechat-cc/design-tokens'

/** cc:CC 自己说的、写的话,用它的手写字。brand:品牌的字标(欢迎页上的名字),留原来的衬线字。别的一律系统字。 */
export type TextVoice = 'cc' | 'brand'

// 手写字的字面比系统字小一圈:同一个角色下放大 1.125 倍(正文 16 → 18,小字 13 → 14.5),看起来和正文一样大。
// 桌面是 15 → 18.5,有意比正文大;手机一行只有十几个字,再大,长一点的回复就太碎。
const CC_VOICE_SCALE = 1.125
const CC_VOICE_FAMILY = 'THPenHand-Regular'

/** 字体只看角色和「谁的话」,不看文字内容。 */
export function phoneFont(role: TypeRole | 'code', { content = 'ui', voice }: { content?: 'ui' | 'user'; voice?: TextVoice } = {}) {
  if (role === 'code') return { fontFamily: 'mono', fontSize: 13, lineHeight: 19, letterSpacing: 0 }
  const s = typeScale[role]
  const brand = voice === 'brand' && content === 'ui'
  const hand = voice === 'cc'
  const fontSize = hand ? Math.round(s.phone * CC_VOICE_SCALE * 2) / 2 : s.phone
  return {
    fontFamily: brand ? (s.weight === 'medium' ? 'THSerif4-Medium' : 'THSerif4-Regular') : hand ? CC_VOICE_FAMILY : undefined,
    ...(s.weight === 'medium' && !brand && !hand ? { fontWeight: '500' as const } : {}),
    fontSize,
    lineHeight: Math.round(fontSize * s.lineHeight),
    letterSpacing: s.phone * s.tracking,
  }
}

/** 字体没好也没错 ⇒ 等;好了或出错 ⇒ 放行(出错时 fontFamily 找不到,iOS / Android 退回系统无衬线,绝不卡住页面)。 */
export function fontGate(loaded: boolean, error: Error | null): 'wait' | 'go' {
  return loaded || error ? 'go' : 'wait'
}

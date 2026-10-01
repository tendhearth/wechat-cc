// 纯 TS:字号 / 行高 / 家族的选择(spec §2.2、§3)。字重永远靠家族名,不设 fontWeight。
// 裁决 D1:只打包 Noto Serif SC Regular ⇒ 中文(界面或用户内容)一律 NotoSerifSC-Regular;只有拉丁界面的 medium 角色用 SourceSerif4-Medium。
import { typeScale, type TypeRole } from '@wechat-cc/design-tokens'
import type { Lang } from '../i18n'

export function phoneFont(role: TypeRole | 'code', lang: Lang, content: 'ui' | 'user' = 'ui') {
  if (role === 'code') return { fontFamily: 'mono', fontSize: 13, lineHeight: 19, letterSpacing: 0 }
  const s = typeScale[role]
  const cjk = content === 'user' || lang === 'zh-Hans'
  const fontFamily = cjk ? 'NotoSerifSC-Regular' : s.weight === 'medium' ? 'SourceSerif4-Medium' : 'SourceSerif4-Regular'
  return {
    fontFamily,
    fontSize: s.phone,
    lineHeight: Math.round(s.phone * s.lineHeight),
    letterSpacing: s.phone * s.tracking,
  }
}

/** 字体没好也没错 ⇒ 等;好了或出错 ⇒ 放行(出错退回系统衬线,绝不卡住页面)。 */
export function fontGate(loaded: boolean, error: Error | null): 'wait' | 'go' {
  return loaded || error ? 'go' : 'wait'
}

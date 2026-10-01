// 纯 TS:字号 / 行高 / 家族的选择(spec §2.2、§3)。字重永远靠家族名,不设 fontWeight。
// 裁决 D1:只打包 Noto Serif SC Regular ⇒ 中文(界面或用户内容)一律 NotoSerifSC-Regular;只有拉丁界面的 medium 角色用 SourceSerif4-Medium。
import { typeScale, type TypeRole } from '@wechat-cc/design-tokens'
import type { Lang } from '../i18n'

/** 中日韩字(汉字、假名、谚文、全角标点与符号、扩展区)。 */
const CJK = /[⺀-鿿가-힯豈-﫿︰-﹏＀-￯]|[\u{20000}-\u{3134F}]/u

/**
 * `text`:这段字的实际内容(知道就传)。一个中文字都没有 ⇒ 拉丁衬线 —— Noto Serif SC 的弯引号 ’ “ ” 是全角字形,
 * 英文里的 week’s 会被撑开;反过来只要有一个中文字就用 Noto(中文永不落到无衬线)。不知道内容 ⇒ 照语言 / content 定。
 */
export function phoneFont(role: TypeRole | 'code', lang: Lang, content: 'ui' | 'user' = 'ui', text?: string) {
  if (role === 'code') return { fontFamily: 'mono', fontSize: 13, lineHeight: 19, letterSpacing: 0 }
  const s = typeScale[role]
  const cjk = text !== undefined ? CJK.test(text) : content === 'user' || lang === 'zh-Hans'
  const fontFamily = cjk ? 'NotoSerifSC-Regular' : s.weight === 'medium' ? 'SourceSerif4-Medium' : 'SourceSerif4-Regular'
  return {
    fontFamily,
    fontSize: s.phone,
    lineHeight: Math.round(s.phone * s.lineHeight),
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

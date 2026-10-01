import { Text, type TextProps } from 'react-native'
import type { TypeRole } from '@wechat-cc/design-tokens'
import { useLang } from '../i18n/useLang'
import { monoFamily } from './fonts'
import { phoneFont, plainText } from './type'
import { useTheme } from './useTheme'

export type Tone = 'ink' | 'inkSoft' | 'accent' | 'bad' | 'onAccent'
/** `role` 是排版角色(不是 RN 的无障碍 role,那个用 accessibilityRole);所以从 TextProps 里去掉 RN 的 role。
 * 标题加 accessibilityRole="header"。
 * 手机上所有文字的出口:字号 / 行高 / 家族来自 phoneFont,颜色来自 tone。界面文案 content='ui',用户写的东西 content='user'。 */
export function Txt({ role = 'body', tone = 'ink', content = 'ui', style, children, ...rest }: Omit<TextProps, 'role'> & { role?: TypeRole | 'code'; tone?: Tone; content?: 'ui' | 'user' }) {
  const { c } = useTheme()
  const lang = useLang()
  // 按实际文字挑家族:没有中文字 ⇒ 拉丁衬线(弯引号不变全角);读不出纯文本 ⇒ 按语言 / content
  const f = phoneFont(role, lang, content, plainText(children))
  return <Text {...rest} children={children} style={[{ ...f, fontFamily: f.fontFamily === 'mono' ? monoFamily : f.fontFamily, color: c[tone] }, style]} />
}

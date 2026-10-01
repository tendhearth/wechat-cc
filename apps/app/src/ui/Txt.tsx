import { Text, type TextProps } from 'react-native'
import type { TypeRole } from '@wechat-cc/design-tokens'
import { useLang } from '../i18n/useLang'
import { monoFamily } from './fonts'
import { phoneFont } from './type'
import { useTheme } from './useTheme'

export type Tone = 'ink' | 'inkSoft' | 'accent' | 'bad' | 'onAccent'
/** `role` 是排版角色(不是 RN 的无障碍 role,那个用 accessibilityRole);所以从 TextProps 里去掉 RN 的 role。
 * 手机上所有文字的出口:字号 / 行高 / 家族来自 phoneFont,颜色来自 tone。界面文案 content='ui',用户写的东西 content='user'。 */
export function Txt({ role = 'body', tone = 'ink', content = 'ui', style, ...rest }: Omit<TextProps, 'role'> & { role?: TypeRole | 'code'; tone?: Tone; content?: 'ui' | 'user' }) {
  const { c } = useTheme()
  const lang = useLang()
  const f = phoneFont(role, lang, content)
  return <Text {...rest} style={[{ ...f, fontFamily: f.fontFamily === 'mono' ? monoFamily : f.fontFamily, color: c[tone] }, style]} />
}

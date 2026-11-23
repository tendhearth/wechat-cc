import { Text, type TextProps } from 'react-native'
import type { TypeRole } from '@wechat-cc/design-tokens'
import { monoFamily } from './fonts'
import { phoneFont, type TextVoice } from './type'
import { useTheme } from './useTheme'

export type Tone = 'ink' | 'inkSoft' | 'accent' | 'bad' | 'onAccent'
/** `role` 是排版角色(不是 RN 的无障碍 role,那个用 accessibilityRole);所以从 TextProps 里去掉 RN 的 role。
 * 标题加 accessibilityRole="header"。
 * 手机上所有文字的出口:字号 / 行高 / 家族来自 phoneFont,颜色来自 tone。界面文案 content='ui',用户写的东西 content='user'。 */
export function Txt({ role = 'body', tone = 'ink', content = 'ui', voice, style, children, ...rest }: Omit<TextProps, 'role'> & { role?: TypeRole | 'code'; tone?: Tone; content?: 'ui' | 'user'; voice?: TextVoice }) {
  const { c } = useTheme()
  const f = phoneFont(role, { content, voice })
  return <Text {...rest} children={children} style={[{ ...f, fontFamily: f.fontFamily === 'mono' ? monoFamily : f.fontFamily, color: c[tone] }, style]} />
}

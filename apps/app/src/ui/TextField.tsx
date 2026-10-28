import { forwardRef } from 'react'
import { TextInput, type TextInputProps } from 'react-native'
import type { TypeRole } from '@wechat-cc/design-tokens'
import { useLang } from '../i18n/useLang'
import { monoFamily } from './fonts'
import { phoneFont } from './type'
import { useTheme } from './useTheme'

/** `role` 是排版角色,不是 RN 的无障碍 role(用 accessibilityRole)。
 * 手机上所有输入框的出口:默认正文字号、用户内容家族(Noto Serif SC),占位字 inkSoft。 */
export const TextField = forwardRef<TextInput, Omit<TextInputProps, 'role'> & { role?: TypeRole | 'code'; content?: 'ui' | 'user' }>(function TextField({ role = 'body', content = 'user', style, ...rest }, ref) {
  const { c } = useTheme()
  const lang = useLang()
  // role='code':等宽(命令原文这类),与 Txt 同一个 monoFamily
  const f = phoneFont(role, lang, content)
  return <TextInput ref={ref} placeholderTextColor={c.inkSoft} {...rest} style={[{ ...f, fontFamily: f.fontFamily === 'mono' ? monoFamily : f.fontFamily, color: c.ink }, style]} />
})

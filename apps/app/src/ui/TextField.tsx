import { forwardRef } from 'react'
import { TextInput, type TextInputProps } from 'react-native'
import type { TypeRole } from '@wechat-cc/design-tokens'
import { useLang } from '../i18n/useLang'
import { phoneFont } from './type'
import { useTheme } from './useTheme'

/** `role` 是排版角色,不是 RN 的无障碍 role(用 accessibilityRole)。
 * 手机上所有输入框的出口:默认正文字号、用户内容家族(Noto Serif SC),占位字 inkSoft。 */
export const TextField = forwardRef<TextInput, Omit<TextInputProps, 'role'> & { role?: TypeRole; content?: 'ui' | 'user' }>(function TextField({ role = 'body', content = 'user', style, ...rest }, ref) {
  const { c } = useTheme()
  const lang = useLang()
  return <TextInput ref={ref} placeholderTextColor={c.inkSoft} {...rest} style={[{ ...phoneFont(role, lang, content), color: c.ink }, style]} />
})

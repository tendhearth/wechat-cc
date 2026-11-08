import { forwardRef, useState } from 'react'
import { TextInput, type TextInputProps } from 'react-native'
import type { TypeRole } from '@wechat-cc/design-tokens'
import { useLang } from '../i18n/useLang'
import { monoFamily } from './fonts'
import { phoneFont } from './type'
import { componentAppearance } from './tokens'
import { useTheme } from './useTheme'

export type TextFieldVariant = 'plain' | 'chat' | 'search' | 'comment'
/** role 管文字角色；variant 管使用场景。plain 留给全页书写区与尚未纳入本批的入口。 */
export const TextField = forwardRef<TextInput, Omit<TextInputProps, 'role'> & { role?: TypeRole | 'code'; content?: 'ui' | 'user'; variant?: TextFieldVariant }>(function TextField({ role = componentAppearance.textField.role, content = 'user', variant = 'plain', style, onFocus, onBlur, ...rest }, ref) {
  const { c } = useTheme()
  const lang = useLang()
  const [focused, setFocused] = useState(false)
  const f = phoneFont(role, lang, content)
  const contract = componentAppearance.textField
  const shape = variant === 'plain' ? null : contract[variant]
  const appearance = shape ? {
    borderRadius: shape.radius, borderWidth: shape.borderWidth,
    borderBottomWidth: variant === 'comment' ? contract.comment.borderBottomWidth : shape.borderWidth,
    borderColor: c[focused ? contract.focusBorder : contract.border],
    backgroundColor: variant === 'comment' ? 'transparent' : c.paper,
    paddingHorizontal: shape.paddingX, paddingVertical: shape.paddingY, minHeight: shape.minHeight.phone,
    opacity: rest.editable === false ? contract.disabledOpacity : 1,
  } : {}
  return <TextInput ref={ref} placeholderTextColor={c.inkSoft} {...rest}
    onFocus={event => { setFocused(true); onFocus?.(event) }} onBlur={event => { setFocused(false); onBlur?.(event) }}
    style={[{ ...f, fontFamily: f.fontFamily === 'mono' ? monoFamily : f.fontFamily, color: c.ink }, appearance, style]} />
})

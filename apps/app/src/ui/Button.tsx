import { ActivityIndicator, Pressable } from 'react-native'
import { componentAppearance, space } from './tokens'
import { Txt } from './Txt'
import { useTheme } from './useTheme'

export type ButtonProps = {
  kind: 'primary' | 'secondary'
  label: string
  onPress: () => void
  disabled?: boolean
  busy?: boolean
  testID?: string
}

// 主 = 唯一的强调色(深绿)实底;次 = 透明底 + 细线。没有阴影、没有渐变。
export function Button({ kind, label, onPress, disabled, busy, testID }: ButtonProps) {
  const { c } = useTheme()
  const inactive = !!disabled || !!busy
  const appearance = componentAppearance.button
  const primary = kind === 'primary'
  return (
    <Pressable
      accessibilityRole="button"
      testID={testID}
      accessibilityLabel={label}
      accessibilityState={{ disabled: inactive, busy: !!busy }}
      disabled={inactive}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: appearance.minHeight.phone,
        paddingHorizontal: appearance.paddingX.phone,
        paddingVertical: appearance.paddingY.phone,
        borderRadius: appearance.radius,
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'row',
        gap: space.s,
        backgroundColor: primary ? c[appearance.primary.background] : appearance.secondary.background,
        borderWidth: appearance.borderWidth,
        borderColor: c[primary ? appearance.primary.border : appearance.secondary.border],
        opacity: inactive ? appearance.disabledOpacity : pressed ? appearance.pressedOpacity : 1,
      })}
    >
      {busy ? <ActivityIndicator color={primary ? c.onAccent : c.ink} /> : null}
      <Txt role={appearance.role.phone} tone={primary ? 'onAccent' : 'ink'}>{label}</Txt>
    </Pressable>
  )
}

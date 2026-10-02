import { ActivityIndicator, Pressable } from 'react-native'
import { radius, space } from './tokens'
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
        minHeight: 48,
        paddingHorizontal: space.xl,
        borderRadius: radius.control,
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'row',
        gap: space.s,
        backgroundColor: primary ? c.accent : 'transparent',
        borderWidth: primary ? 0 : 1,
        borderColor: c.hair,
        opacity: inactive ? 0.55 : pressed ? 0.85 : 1,
      })}
    >
      {busy ? <ActivityIndicator color={primary ? c.onAccent : c.ink} /> : null}
      <Txt role="body" tone={primary ? 'onAccent' : 'ink'}>{label}</Txt>
    </Pressable>
  )
}

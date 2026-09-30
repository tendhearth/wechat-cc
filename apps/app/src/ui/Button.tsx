import { ActivityIndicator, Pressable, Text } from 'react-native'
import { radius, space } from './tokens'
import { useTheme } from './useTheme'

export type ButtonProps = {
  kind: 'primary' | 'secondary'
  label: string
  onPress: () => void
  disabled?: boolean
  busy?: boolean
}

export function Button({ kind, label, onPress, disabled, busy }: ButtonProps) {
  const { c } = useTheme()
  const inactive = !!disabled || !!busy
  const primary = kind === 'primary'
  const fg = primary ? c.primaryInk : c.ink
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: inactive, busy: !!busy }}
      disabled={inactive}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 48,
        paddingHorizontal: space.xl,
        borderRadius: radius.button,
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'row',
        gap: space.s,
        backgroundColor: primary ? c.primary : 'transparent',
        borderWidth: primary ? 0 : 1,
        borderColor: c.line,
        opacity: inactive ? 0.55 : pressed ? 0.85 : 1,
      })}
    >
      {busy ? <ActivityIndicator color={fg} /> : null}
      <Text style={{ color: fg, fontSize: 16, fontWeight: '600' }}>{label}</Text>
    </Pressable>
  )
}

import { ActivityIndicator, Pressable } from 'react-native'
import { Icon, type IconName } from './Icon'
import { componentAppearance } from './tokens'
import { useTheme } from './useTheme'

export function IconButton({ name, label, onPress, testID, disabled = false, busy = false }: { name: IconName; label: string; onPress: () => void; testID?: string; disabled?: boolean; busy?: boolean }) {
  const appearance = componentAppearance.iconButton
  const { c } = useTheme()
  return <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: disabled || busy, busy }} disabled={disabled || busy} onPress={onPress}
    style={({ pressed }) => ({ minWidth: appearance.size.phone, minHeight: appearance.size.phone, borderRadius: appearance.radius, alignItems: 'center', justifyContent: 'center', opacity: disabled || busy ? appearance.disabledOpacity : pressed ? appearance.pressedOpacity : 1 })}>
    {busy ? <ActivityIndicator color={c.inkSoft} /> : <Icon name={name} color={c.inkSoft} />}
  </Pressable>
}

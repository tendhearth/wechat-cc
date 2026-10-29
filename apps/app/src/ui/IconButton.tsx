import { ActivityIndicator, Pressable } from 'react-native'
import { Icon, type IconName } from './Icon'
import { useTheme } from './useTheme'

export function IconButton({ name, label, onPress, testID, disabled = false, busy = false }: { name: IconName; label: string; onPress: () => void; testID?: string; disabled?: boolean; busy?: boolean }) {
  const { c } = useTheme()
  return <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: disabled || busy, busy }} disabled={disabled || busy} onPress={onPress}
    style={({ pressed }) => ({ minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center', opacity: disabled || busy ? 0.55 : pressed ? 0.7 : 1 })}>
    {busy ? <ActivityIndicator color={c.inkSoft} /> : <Icon name={name} color={c.inkSoft} />}
  </Pressable>
}

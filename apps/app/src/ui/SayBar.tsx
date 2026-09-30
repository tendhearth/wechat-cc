import { Pressable, Text } from 'react-native'
import { radius, space } from './tokens'
import { useTheme } from './useTheme'

// 随处可见的输入入口:点开才进入写作页,所以这里只是一个长得像输入框的按钮。
export function SayBar({ placeholder, onPress }: { placeholder: string; onPress: () => void }) {
  const { c } = useTheme()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={placeholder}
      onPress={onPress}
      style={{
        minHeight: 52,
        justifyContent: 'center',
        paddingHorizontal: space.l,
        borderRadius: radius.card,
        backgroundColor: c.card,
        borderWidth: 1,
        borderColor: c.line,
      }}
    >
      <Text style={{ color: c.muted, fontSize: 16 }}>{placeholder}</Text>
    </Pressable>
  )
}

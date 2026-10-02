import { Pressable, View } from 'react-native'
import { radius, space } from './tokens'
import { Txt } from './Txt'
import { useTheme } from './useTheme'

// 底部「跟 CC 说一句…」:整条是一个按钮(点开进 /chat 写)。右端的圆钮只是这条按钮的一部分,不是另一个动作。
export function SayBar({ placeholder, onPress, testID }: { placeholder: string; onPress: () => void; testID?: string }) {
  const { c } = useTheme()
  return (
    <Pressable accessibilityRole="button" testID={testID} accessibilityLabel={placeholder} onPress={onPress}
      style={({ pressed }) => ({ minHeight: 56, flexDirection: 'row', alignItems: 'center', paddingLeft: space.xl - 2, paddingRight: space.s, borderRadius: radius.control, borderWidth: 1, borderColor: pressed ? c.accent : c.hair, backgroundColor: c.paper })}>
      <Txt tone="inkSoft" style={{ flex: 1 }}>{placeholder}</Txt>
      <View importantForAccessibility="no" accessibilityElementsHidden style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: c.accent, alignItems: 'center', justifyContent: 'center' }}>
        <Txt tone="onAccent" role="item">➤</Txt>
      </View>
    </Pressable>
  )
}

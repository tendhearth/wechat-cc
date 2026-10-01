import { Pressable, View } from 'react-native'
import { space } from './tokens'
import { Txt } from './Txt'
import { useTheme } from './useTheme'

// 列表行:不画色块,行间一条细线。

// 单选的一行:不画色块。字一律墨色(没选中不能读成「不可用」);选中 = 行尾一个墨色 ✓(强调色只给动作,终审 M7)。行间一条细线。
export function ChoiceRow({ label, on, onPress, testID, content = 'ui' }: { label: string; on: boolean; onPress: () => void; testID?: string; content?: 'ui' | 'user' }) {
  const { c } = useTheme()
  return (
    <Pressable
      testID={testID}
      accessibilityRole="radio"
      accessibilityState={{ checked: on }}
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: space.m, minHeight: 48, borderBottomWidth: 1, borderBottomColor: c.hair, opacity: pressed ? 0.7 : 1 })}
    >
      <Txt role="body" tone="ink" content={content} numberOfLines={1} style={{ flex: 1 }}>{label}</Txt>
      <View style={{ width: 20, alignItems: 'flex-end' }}>{on ? <Txt role="body" tone="ink">✓</Txt> : null}</View>
    </Pressable>
  )
}

// 进下一页的一行:文字 + 行尾 ›(设置里的「CC 的连接」「电脑上的会话」等)。
export function LinkRow({ label, onPress, testID }: { label: string; onPress: () => void; testID?: string }) {
  const { c } = useTheme()
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: space.m, minHeight: 48, borderBottomWidth: 1, borderBottomColor: c.hair, opacity: pressed ? 0.7 : 1 })}
    >
      <Txt role="body" numberOfLines={1} style={{ flex: 1 }}>{label}</Txt>
      <Txt role="title" tone="inkSoft">›</Txt>
    </Pressable>
  )
}

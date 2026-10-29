import { Pressable, View } from 'react-native'
import { space } from './tokens'
import { Txt } from './Txt'
import { useTheme } from './useTheme'
import { Icon, type IconName } from './Icon'

// 列表行:留白分隔,不画色块或重复分隔线。

// 单选的一行:字一律墨色;选中由行尾的勾号表示。
export function ChoiceRow({ label, on, onPress, testID, content = 'ui' }: { label: string; on: boolean; onPress: () => void; testID?: string; content?: 'ui' | 'user' }) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="radio"
      accessibilityState={{ checked: on }}
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: space.m, minHeight: 52, paddingVertical: space.s, opacity: pressed ? 0.7 : 1 })}
    >
      <Txt role="body" tone="ink" content={content} numberOfLines={1} style={{ flex: 1 }}>{label}</Txt>
      <View style={{ width: 20, alignItems: 'flex-end' }}>{on ? <Icon name="check" /> : null}</View>
    </Pressable>
  )
}

// 进下一页的一行:文字 + 行尾 ›(设置里的「CC 的连接」「电脑上的会话」等)。
export function LinkRow({ label, onPress, testID, icon, detail }: { label: string; onPress: () => void; testID?: string; icon?: IconName; detail?: string }) {
  const { c } = useTheme()
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: space.m, minHeight: 56, paddingVertical: space.s, opacity: pressed ? 0.7 : 1 })}
    >
      {icon ? <Icon name={icon} color={c.inkSoft} /> : null}
      <View style={{ flex: 1 }}><Txt role="body">{label}</Txt>{detail ? <Txt role="meta" tone="inkSoft">{detail}</Txt> : null}</View>
      <Icon name="chevronRight" size={16} color={c.inkSoft} />
    </Pressable>
  )
}

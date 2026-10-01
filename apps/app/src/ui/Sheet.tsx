import { useState, type ReactNode } from 'react'
import { Pressable, Text, View } from 'react-native'
import { radius, space } from './tokens'
import { useTheme } from './useTheme'

// 可展开区块:标题一行,点开看内容。
export function Sheet({ title, children, defaultOpen = false, testID }: { title: string; children: ReactNode; defaultOpen?: boolean; testID?: string }) {
  const { c } = useTheme()
  const [open, setOpen] = useState(defaultOpen)
  return (
    <View style={{ borderRadius: radius.card, borderWidth: 1, borderColor: c.line, backgroundColor: c.card, overflow: 'hidden' }}>
      <Pressable
        accessibilityRole="button"
        testID={testID}
        accessibilityState={{ expanded: open }}
        accessibilityLabel={title}
        onPress={() => setOpen((v) => !v)}
        style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: space.l }}
      >
        <Text style={{ color: c.ink, fontSize: 15 }}>{title}</Text>
        <Text style={{ color: c.muted, fontSize: 16 }}>{open ? '–' : '+'}</Text>
      </Pressable>
      {open ? <View style={{ padding: space.l, paddingTop: 0 }}>{children}</View> : null}
    </View>
  )
}

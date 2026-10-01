import { useState, type ReactNode } from 'react'
import { Pressable, View } from 'react-native'
import { radius, space } from './tokens'
import { Txt } from './Txt'
import { useTheme } from './useTheme'

// 可展开区块:标题一行,点开看内容。单层:纸色 + 细线,里面不再套卡。
export function Sheet({ title, children, defaultOpen = false, testID }: { title: string; children: ReactNode; defaultOpen?: boolean; testID?: string }) {
  const { c } = useTheme()
  const [open, setOpen] = useState(defaultOpen)
  return (
    <View style={{ borderRadius: radius.sheet, borderWidth: 1, borderColor: c.hair, backgroundColor: c.paper, overflow: 'hidden' }}>
      <Pressable
        accessibilityRole="button"
        testID={testID}
        accessibilityState={{ expanded: open }}
        accessibilityLabel={title}
        onPress={() => setOpen((v) => !v)}
        style={{ minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: space.l }}
      >
        <Txt role="bubble" style={{ flex: 1 }}>{title}</Txt>
        <Txt role="body" tone="inkSoft">{open ? '–' : '+'}</Txt>
      </Pressable>
      {open ? <View style={{ padding: space.l, paddingTop: 0 }}>{children}</View> : null}
    </View>
  )
}

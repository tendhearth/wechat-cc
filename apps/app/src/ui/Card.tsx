import type { ReactNode } from 'react'
import { View, type StyleProp, type ViewStyle } from 'react-native'
import { radius, space } from './tokens'
import { useTheme } from './useTheme'

// 一层卡片就够:纸色底 + 细线,无阴影。卡里不再放卡(style.guard 钉住)。
export function Card({ children, style, testID }: { children: ReactNode; style?: StyleProp<ViewStyle>; testID?: string }) {
  const { c } = useTheme()
  return (
    <View
      testID={testID}
      style={[
        { backgroundColor: c.paper, borderColor: c.hair, borderWidth: 1, borderRadius: radius.sheet, padding: space.l },
        style,
      ]}
    >
      {children}
    </View>
  )
}

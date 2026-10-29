import type { ReactNode } from 'react'
import { View, type StyleProp, type ViewStyle } from 'react-native'
import { space } from './tokens'
import { useTheme } from './useTheme'

// 单层内容容器:以留白分组,不重复画卡片边框。卡里不再放卡(style.guard 钉住)。
export function Card({ children, style, testID }: { children: ReactNode; style?: StyleProp<ViewStyle>; testID?: string }) {
  const { c } = useTheme()
  return (
    <View
      testID={testID}
      style={[
        { backgroundColor: c.paper, paddingVertical: space.l },
        style,
      ]}
    >
      {children}
    </View>
  )
}

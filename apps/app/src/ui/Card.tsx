import type { ReactNode } from 'react'
import { View, type StyleProp, type ViewStyle } from 'react-native'
import { radius, space } from './tokens'
import { useTheme } from './useTheme'

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const { c } = useTheme()
  return (
    <View
      style={[
        { backgroundColor: c.card, borderColor: c.line, borderWidth: 1, borderRadius: radius.card, padding: space.l },
        style,
      ]}
    >
      {children}
    </View>
  )
}

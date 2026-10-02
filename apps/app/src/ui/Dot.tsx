import { View } from 'react-native'
import type { Dot as DotKind } from '../view/connections'
import { useTheme } from './useTheme'

// 圆点只是辅助:旁边一定有文字。状态色只用在这里(ok / warn / bad / unknown 同名 token);unknown 是灰,绝不默认绿。
export function Dot({ kind, size = 10 }: { kind: DotKind; size?: number }) {
  const { c } = useTheme()
  return <View accessibilityElementsHidden importantForAccessibility="no" style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: c[kind] }} />
}

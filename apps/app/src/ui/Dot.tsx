import { View } from 'react-native'
import type { Dot as DotKind } from '../view/connections'
import { useTheme } from './useTheme'

// 圆点只是辅助:旁边一定有文字。unknown 用 muted,绝不默认绿。
export function Dot({ kind, size = 10 }: { kind: DotKind; size?: number }) {
  const { c } = useTheme()
  const color = kind === 'ok' ? c.ok : kind === 'warn' ? c.warn : kind === 'bad' ? c.danger : c.muted
  return <View accessibilityElementsHidden importantForAccessibility="no" style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />
}

import type { ReactNode } from 'react'
import { View } from 'react-native'
import { componentAppearance, space } from './tokens'
import { useTheme } from './useTheme'

export function MessageBubble({ children, testID, mine, failed = false }: {
  children: ReactNode; testID: string; mine: boolean; failed?: boolean
}) {
  const { c } = useTheme()
  const appearance = componentAppearance.message
  return <View testID={testID} style={{
    alignSelf: mine ? 'flex-end' : 'flex-start',
    maxWidth: '88%', paddingVertical: appearance.paddingY, paddingHorizontal: mine ? appearance.paddingX : 0,
    gap: space.s, borderRadius: appearance.radius,
    backgroundColor: mine ? c[appearance.userBackground] : appearance.replyBackground,
    opacity: failed ? 0.8 : 1,
  }}>{children}</View>
}

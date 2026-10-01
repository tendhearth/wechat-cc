import { useEffect } from 'react'
import { Pressable, Text } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { Banner } from '../push/banner'
import { radius, space } from './tokens'
import { useTheme } from './useTheme'

// app 在前台时自己的横幅(spec §7,只在 iOS 出现):不动画(减少动态效果也一样),6 秒后自己收起;点一下去中转页。
export function PushBanner({ banner, onOpen, onClose, openLabel }: { banner: Banner; onOpen(): void; onClose(): void; openLabel: string }) {
  const { c } = useTheme()
  const insets = useSafeAreaInsets()
  useEffect(() => { const id = setTimeout(onClose, 6000); return () => clearTimeout(id) }, [banner, onClose])
  return (
    <Pressable testID="push-banner" accessibilityRole="button" accessibilityLabel={`${banner.title}. ${banner.body}. ${openLabel}`} onPress={onOpen}
      style={{ position: 'absolute', top: insets.top + space.s, left: space.l, right: space.l, padding: space.l, gap: space.xs,
        borderRadius: radius.card, borderWidth: 1, borderColor: c.line, backgroundColor: c.card }}>
      <Text style={{ color: c.ink, fontSize: 15 }} numberOfLines={1}>{banner.title}</Text>
      <Text style={{ color: c.muted, fontSize: 14, lineHeight: 20 }} numberOfLines={2}>{banner.body}</Text>
    </Pressable>
  )
}

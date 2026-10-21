import { Image, View } from 'react-native'
import { space } from './tokens'
import { Txt } from './Txt'

/** 显示宽度(pt);电脑给的是 512px 方图。 */
const SIZE = 200

/**
 * 「CC 画的你」(收敛清单 ④,2026-10-21):电脑把 SVG 画成 PNG(macOS qlmanage)随 /m/api/state 的 portraitPng 给过来,
 * 这里只是一张 <Image>。没有 PNG ⇒ 调用方不画这一块。
 */
export function Portrait({ png, label }: { png: string; label: string }) {
  return (
    <View testID="portrait" style={{ alignItems: 'center', gap: space.s }}>
      <Image accessibilityLabel={label} source={{ uri: `data:image/png;base64,${png}` }} style={{ width: SIZE, height: SIZE }} resizeMode="contain" />
      <Txt role="caption" tone="inkSoft">{label}</Txt>
    </View>
  )
}

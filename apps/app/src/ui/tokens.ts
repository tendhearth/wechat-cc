// 色值、字号、形状的唯一出处是 @wechat-cc/design-tokens(spec 2026-10-01 §2)。只有一套:页面永远是同一张暖纸。
import { color, radius, space } from '@wechat-cc/design-tokens'
export const palette = color
export type Palette = typeof color
export { radius, space }

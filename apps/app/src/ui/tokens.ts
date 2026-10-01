// 色值、字号、形状的唯一出处是 @wechat-cc/design-tokens(spec 2026-10-01 §2)。只有一套:页面永远是同一张暖纸。
import { color, radius as sharedRadius, space } from '@wechat-cc/design-tokens'
export const palette = color
export type Palette = typeof color
/**
 * 共用圆角 + 旧键名过渡别名(card / button / pill → sheet / control / nav)。
 * 旧键名随 Task 6 换组件时删掉,届时这里只剩共用包里那一份。
 */
export const radius = { ...sharedRadius, card: sharedRadius.sheet, button: sharedRadius.control, pill: sharedRadius.nav } as const
export { space }

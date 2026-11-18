import type { PlacesResponseT } from '@wechat-cc/protocol'
/** 「地方」读写口(设计稿 2026-11-18-cc-two-sides-design.md §3):读同名单;顺序 / 收起存 places 表。 */
export interface PlacesReader {
  read(scope: 'operator' | 'device'): PlacesResponseT
  move(key: string, to: number): boolean
  hide(key: string, hidden: boolean): boolean
}

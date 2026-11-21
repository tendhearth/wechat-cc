import type { PlacesResponseT, PlaceMapResponseT, PlaceMapPinRequestT } from '@wechat-cc/protocol'
/** 「地方」读写口(设计稿 2026-11-18-cc-two-sides-design.md §3):读同名单;顺序 / 收起存 places 表。 */
export interface PlacesReader {
  read(scope: 'operator' | 'device'): PlacesResponseT
  map(key: string): Promise<PlaceMapResponseT | null>
  pin(input: PlaceMapPinRequestT): Promise<'place_not_found' | 'place_map_item_not_found' | 'place_map_item_fixed' | null>
  move(key: string, to: number): boolean
  hide(key: string, hidden: boolean): boolean
  /** 主人看了这一行:之后那一句先说从这以后变了什么(「坐回来」)。 */
  seen(key: string): boolean
}

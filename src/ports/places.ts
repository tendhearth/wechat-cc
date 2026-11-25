import type { PlacedItem } from '../domain/place-map-prompt'
import type { PlacesResponseT, PlaceMapResponseT, PlaceMapPinRequestT, PlaceOutlineRunResponseT } from '@wechat-cc/protocol'
/** 「地方」读写口(设计稿 2026-11-18-cc-two-sides-design.md §3):读同名单;顺序 / 收起存 places 表。 */
export interface PlacesReader {
  recapEnabled?(): boolean
  setRecapEnabled?(enabled: boolean): void
  recap?(id: string): import('@wechat-cc/protocol').SessionRecapT | undefined
  read(scope: 'operator' | 'device', frameBudget?: number): PlacesResponseT
  placeMapEnabled(): boolean
  setPlaceMap(enabled: boolean): boolean
  placeForPath(path: string): string | null
  placeForEntries(owner: string, entryIds: readonly string[]): string | null
  placedItems(key: string): Promise<PlacedItem[]>
  startOutline?(key: string): Promise<PlaceOutlineRunResponseT | 'outline_quota' | 'lab_off' | 'place_not_found' | 'unavailable'>
  map(key: string, includeOutline?: boolean): Promise<PlaceMapResponseT | null>
  pin(input: PlaceMapPinRequestT): Promise<'lab_off' | 'place_not_found' | 'place_map_item_not_found' | 'place_map_item_fixed' | null>
  move(key: string, to: number): boolean
  hide(key: string, hidden: boolean): boolean
  /** 主人看了这一行:之后那一句先说从这以后变了什么(「坐回来」)。 */
  seen(key: string, desktop?: boolean): boolean
}

export type PlaceMapPromptReader = Pick<PlacesReader, 'placeMapEnabled' | 'placedItems'>

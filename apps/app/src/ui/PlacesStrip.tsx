/**
 * PlacesStrip —— 正面上半「现在」:一个地方一行,位置由主人在桌面上定(设计稿 2026-11-18-cc-two-sides-design.md §3)。
 * 点一行 = 把下面的说话筛成这个地方,再点回全部;「›」打开那个地方最该看的那一件(在等你的那件 / 最近的一件)。
 * 手机上批准要带这一轮的 runId,行上不直接答,「›」进那一件去答。
 */
import { Pressable, ScrollView, View } from 'react-native'
import type { PlaceT } from '@wechat-cc/protocol'
import { useLang } from '../i18n/useLang'
import { placeHref, placeLine, placeTime } from '../view/places'
import { Txt } from './Txt'
import { space } from './tokens'
import { useTheme } from './useTheme'

export function PlacesStrip({ places, stale, selected, onSelect, onOpen, now = Date.now() }: {
  places: PlaceT[]; stale: boolean; selected: string | null
  onSelect: (place: PlaceT | null) => void; onOpen: (href: string, place: PlaceT) => void; now?: number
}) {
  const lang = useLang(), { c } = useTheme(), zh = lang === 'zh-Hans'
  if (!places.length) return null
  return <View testID="places-strip" style={{ borderBottomWidth: 1, borderBottomColor: c.hair, backgroundColor: c.rail }}>
    {stale ? <Txt role="small" tone="inkSoft" style={{ paddingHorizontal: space.l, paddingTop: space.s }}>{zh ? '家里的电脑暂时连不上,下面是上一次的样子' : "Can't reach your computer — showing the last update"}</Txt> : null}
    <ScrollView style={{ maxHeight: 4 * 48 }} nestedScrollEnabled>
      {places.map((p, i) => {
        const isOn = p.key === selected, waiting = !!p.waiting && !stale, strong = waiting || p.unseen
        const href = placeHref(p), line = placeLine(p, lang)
        return <View key={p.key} style={{ flexDirection: 'row', alignItems: 'center', borderTopWidth: i ? 1 : 0, borderTopColor: c.hair, backgroundColor: isOn ? c.paper : 'transparent' }}>
          <Pressable testID={`place-row-${i}`} accessibilityRole="button" accessibilityState={{ selected: isOn }}
            accessibilityLabel={`${p.name}${waiting ? (zh ? ',在等你' : ', waiting for you') : ''}${line ? `,${line}` : ''}`}
            onPress={() => onSelect(isOn ? null : p)}
            style={{ flex: 1, minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: space.m, paddingLeft: space.l }}>
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: waiting ? c.accent : 'transparent' }} />
            <Txt role="item" numberOfLines={1} style={{ maxWidth: '35%' }}>{p.name}</Txt>
            <Txt role="small" tone={strong || p.moving ? 'ink' : 'inkSoft'} numberOfLines={1} content="user" style={{ flex: 1 }}>{line}</Txt>
            <Txt role="caption" tone="inkSoft">{placeTime(p, now, lang)}</Txt>
          </Pressable>
          {href ? <Pressable testID={`place-open-${i}`} accessibilityRole="button" accessibilityLabel={zh ? `打开 ${p.name} 那一件` : `Open ${p.name}`} onPress={() => onOpen(href, p)}
            style={{ minWidth: 44, minHeight: 48, alignItems: 'center', justifyContent: 'center' }}><Txt role="item" tone="inkSoft">›</Txt></Pressable> : <View style={{ width: 44 }} />}
        </View>
      })}
    </ScrollView>
  </View>
}

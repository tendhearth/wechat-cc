import { useState } from 'react'
import { Linking, Pressable, View } from 'react-native'
import { t } from '../i18n'
import { useLang } from '../i18n/useLang'
import type { CompanionCard as CardData } from '../view/companion'
import { relAgo } from '../view/terminal'
import { Card } from './Card'
import { Icon } from './Icon'
import { Expansion } from './Sheet'
import { space } from './tokens'
import { Txt } from './Txt'

/**
 * CC 带回来的最新一样(打猎找到的 / 明信片),此刻页唯一一张卡。点一下 ⇒ 记「看到这里了」(电脑上的同一个水位);
 * 有 http(s) 链接就打开,没有就原地展开全文(收起时标题两行、附言一行)。展开着的那张留在本机,收起才消失(记过看过,下次不再端上来)。
 * 明信片的图是 SVG,原生端没有 SVG 渲染,这里只放文字。
 */
export function CompanionCard({ card, onSeen }: { card: CardData | null; onSeen: (ts: string) => void }) {
  const lang = useLang()
  const [open, setOpen] = useState<CardData | null>(null)
  const shown = open ?? card
  if (!shown) return null
  const kind = t(lang, shown.kind === 'hunt' ? 'companion.hunt' : 'companion.postcard')
  const onPress = () => {
    if (shown.url) {
      onSeen(shown.ts)
      void Linking.openURL(shown.url).catch(() => {})
      return
    }
    if (open) { setOpen(null); return }
    onSeen(shown.ts)
    if (shown.note) setOpen(shown) // 没有附言就没什么可展开的:记过看过,卡片直接收走
  }
  return (
    <Pressable testID="now-companion-card" accessibilityRole={shown.url ? 'link' : 'button'} accessibilityState={shown.url ? undefined : { expanded: open !== null }}
      accessibilityLabel={t(lang, 'companion.cardLabel', { kind, title: shown.title })} onPress={onPress}
      style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}>
      <Card style={{ gap: space.xs }}>
        <Txt role="caption" tone="inkSoft">{`${kind} · ${relAgo(shown.at, Date.now(), lang)}`}</Txt>
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: space.l }}>
          <Txt role="item" content="user" numberOfLines={open ? undefined : 2} style={{ flex: 1 }}>{shown.title}</Txt>
          {shown.url ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs }}><Txt role="bubble" tone="inkSoft">{t(lang, 'companion.openLink')}</Txt><Icon name="chevronRight" /></View> : null}
        </View>
        {shown.note ? <>
          {!open ? <Txt testID="now-companion-note" role="meta" tone="inkSoft" content="user" numberOfLines={1}>{shown.note}</Txt> : null}
          <Expansion open={!!open}><Txt testID="now-companion-expanded-note" role="meta" tone="inkSoft" content="user">{shown.note}</Txt></Expansion>
        </> : null}
      </Card>
    </Pressable>
  )
}

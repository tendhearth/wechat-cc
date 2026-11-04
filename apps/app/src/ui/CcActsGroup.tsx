import { useRouter } from 'expo-router'
import { useState } from 'react'
import { Pressable, View } from 'react-native'
import { t } from '../i18n'
import { useLang } from '../i18n/useLang'
import type { CcActsView } from '../view/cc-acts'
import { Icon } from './Icon'
import { Expansion } from './Sheet'
import { space } from './tokens'
import { Txt } from './Txt'
import { useTheme } from './useTheme'

/**
 * 主页最末一组「CC 最近在忙」(M5c):默认折叠,点标题展开;一行 = 发起方 + 最近那一轮那一句 · 多久前,点进那件事的详情。
 * 没有行(老 daemon 不给 act)⇒ 整组不出现。和上面的一件事列表分开(主人 10-31 定不混排),不上强调色。
 */
export function CcActsGroup({ view }: { view: CcActsView }) {
  const { c } = useTheme()
  const lang = useLang()
  const router = useRouter()
  const [open, setOpen] = useState(false)
  if (view.rows.length === 0) return null
  return (
    <View>
      <Pressable testID="home-group-cc-acts" accessibilityRole="button" accessibilityState={{ expanded: open }}
        accessibilityLabel={t(lang, open ? 'ccActs.hide' : 'ccActs.show')} onPress={() => setOpen(o => !o)}
        style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: space.s, minHeight: 44, paddingTop: space.l, opacity: pressed ? 0.7 : 1 })}>
        <Txt role="caption" tone="inkSoft" accessibilityRole="header">{t(lang, 'ccActs.title')}</Txt>
        <View style={{ transform: [{ rotate: open ? '0deg' : '-90deg' }] }}><Icon name="chevronDown" size={14} color={c.inkSoft} /></View>
      </Pressable>
      <Expansion open={open}>
        {view.rows.map(r => {
          const sub = [r.line, r.when].filter(Boolean).join(' · ')
          return (
            <Pressable key={r.id} testID={`row-act-${r.id}`} accessibilityRole="button" accessibilityLabel={[r.title, sub].join(', ')} onPress={() => router.push(r.href)}
              style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: space.m, minHeight: 56, paddingVertical: space.s, opacity: pressed ? 0.7 : 1 })}>
              <View style={{ flex: 1, gap: space.xs }}>
                <Txt role="item">{r.title}</Txt>
                <Txt testID={`row-act-line-${r.id}`} role="caption" tone="inkSoft" numberOfLines={1}>{sub}</Txt>
              </View>
              <Icon name="chevronRight" size={16} color={c.inkSoft} />
            </Pressable>
          )
        })}
      </Expansion>
    </View>
  )
}

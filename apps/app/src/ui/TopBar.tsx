import { Pressable, Text, View } from 'react-native'
import { useLang } from '../i18n/useLang'
import { t } from '../i18n'
import { serifFamily } from './fonts'
import { space } from './tokens'
import { useTheme } from './useTheme'

export type Connection = 'online' | 'offline'

// 右上:「家里的电脑」状态点 + 头像(进设置,由调用方经 onAvatar 接线)。
export function TopBar({
  title,
  onBack,
  connection,
  onAvatar,
}: {
  title?: string
  onBack?: () => void
  connection: Connection
  onAvatar?: () => void
}) {
  const { c } = useTheme()
  const lang = useLang()
  const online = connection === 'online'
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', minHeight: 56, paddingHorizontal: space.l, gap: space.m }}>
      {onBack ? (
        <Pressable accessibilityRole="button" accessibilityLabel={t(lang, 'common.back')} onPress={onBack} hitSlop={12}>
          <Text style={{ color: c.ink, fontSize: 22 }}>‹</Text>
        </Pressable>
      ) : null}
      <Text numberOfLines={1} style={{ flex: 1, color: c.ink, fontSize: 20, fontFamily: serifFamily }}>
        {title ?? ''}
      </Text>
      <View
        accessible
        accessibilityLabel={`${t(lang, 'common.computerHome')}, ${online ? 'online' : t(lang, 'common.computerOffline')}`}
        style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs + 2 }}
      >
        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: online ? c.ok : c.muted }} />
        <Text style={{ color: c.muted, fontSize: 12 }}>{t(lang, 'common.computerHome')}</Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t(lang, 'settings.title')}
        onPress={onAvatar}
        hitSlop={8}
        style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: c.navOnBg, alignItems: 'center', justifyContent: 'center' }}
      >
        <Text style={{ color: c.navOnInk, fontSize: 14, fontWeight: '600' }}>N</Text>
      </Pressable>
    </View>
  )
}

import { Image, Pressable, Text, View } from 'react-native'
import { useLang } from '../i18n/useLang'
import { t } from '../i18n'
import { serifFamily } from './fonts'
import { space } from './tokens'
import { useTheme } from './useTheme'

export type Connection = 'online' | 'offline'

const lit = require('../../assets/cc/lit.png')
const unlit = require('../../assets/cc/unlit.png')

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
  const { c, scheme } = useTheme()
  const lang = useLang()
  const online = connection === 'online'
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', minHeight: 56, paddingHorizontal: space.l, gap: space.m }}>
      {onBack ? (
        <Pressable accessibilityRole="button" testID="topbar-back" accessibilityLabel={t(lang, 'common.back')} onPress={onBack} hitSlop={12}>
          <Text style={{ color: c.ink, fontSize: 22 }}>‹</Text>
        </Pressable>
      ) : null}
      <Text numberOfLines={1} style={{ flex: 1, color: c.ink, fontSize: 20, fontFamily: serifFamily }}>
        {title ?? ''}
      </Text>
      <View
        accessible
        testID="topbar-connection"
        accessibilityLabel={`${t(lang, 'common.computerHome')}, ${online ? t(lang, 'common.computerOnline') : t(lang, 'common.computerOffline')}`}
        style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs + 2 }}
      >
        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: online ? c.ok : c.muted }} />
        <Text style={{ color: c.muted, fontSize: 12 }}>{t(lang, 'common.computerHome')}</Text>
      </View>
      <Pressable
        accessibilityRole="button"
        testID="topbar-settings"
        accessibilityLabel={t(lang, 'settings.title')}
        onPress={onAvatar}
        hitSlop={8}
        style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: c.navOnBg, alignItems: 'center', justifyContent: 'center' }}
      >
        {/* 还没有主人的名字可用,头像先放一个小 CC,不写死字母。 */}
        <Image source={scheme === 'dark' ? unlit : lit} style={{ width: 24, height: 24 }} resizeMode="contain" />
      </Pressable>
    </View>
  )
}

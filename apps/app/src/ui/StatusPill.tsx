import { Text, View } from 'react-native'
import { useLang } from '../i18n/useLang'
import { t, type MessageKey } from '../i18n'
import { radius, space } from './tokens'
import { useTheme } from './useTheme'

export type StatusKey = 'working' | 'waiting' | 'replied' | 'done' | 'failed' | 'stopped'

// 所有状态都有文字;颜色只是辅助。不显示百分比。
export function StatusPill({ status }: { status: StatusKey }) {
  const { c } = useTheme()
  const lang = useLang()
  const tone =
    status === 'waiting' || status === 'failed' ? c.warn : status === 'done' || status === 'replied' ? c.ok : c.muted
  return (
    <View
      style={{
        alignSelf: 'flex-start',
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.xs + 2,
        paddingHorizontal: space.m,
        paddingVertical: space.xs + 1,
        borderRadius: radius.pill,
        backgroundColor: c.accentSoft,
      }}
    >
      <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: tone }} />
      <Text style={{ color: c.ink, fontSize: 13, fontWeight: '600' }}>{t(lang, `status.${status}` as MessageKey)}</Text>
    </View>
  )
}

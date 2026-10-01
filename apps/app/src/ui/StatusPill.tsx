import { View } from 'react-native'
import { useLang } from '../i18n/useLang'
import { t, type MessageKey } from '../i18n'
import type { Dot as DotKind } from '../view/connections'
import { Dot } from './Dot'
import { space } from './tokens'
import { Txt } from './Txt'

export type StatusKey = 'working' | 'waiting' | 'replied' | 'done' | 'failed' | 'stopped'

const DOT: Record<StatusKey, DotKind> = { waiting: 'warn', failed: 'bad', done: 'ok', replied: 'ok', working: 'unknown', stopped: 'unknown' }

// 所有状态都有文字;颜色只上点(没有底块)。不显示百分比。
export function StatusPill({ status }: { status: StatusKey }) {
  const lang = useLang()
  return (
    <View style={{ alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: space.s }}>
      <Dot kind={DOT[status]} size={8} />
      <Txt role="small" tone="inkSoft">{t(lang, `status.${status}` as MessageKey)}</Txt>
    </View>
  )
}

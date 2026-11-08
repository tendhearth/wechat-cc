import { useRouter } from 'expo-router'
import { View } from 'react-native'
import { t } from '../i18n'
import { useLang } from '../i18n/useLang'
import type { HomeView } from '../view/home'
import { Button } from './Button'
import { MatterRow } from './MatterRow'
import { BusyIndicator } from './motion'
import { StatusHint } from './StatusHint'
import { space } from './tokens'
import { Txt } from './Txt'

/**
 * 主页与「全部」共用的一份列表(设计稿 2026-10-31 U):分组标题 + MatterRow;读不到 / 读旧了 / 空 三种状态说清楚。
 * 只有「等你」的组标题上强调色;一行只打开详情,不在这里批准。等你组只有第一行主动请求说明标题。
 */
export function WorkList({ view, prefix, known, loading, error, onRetry, emptyText }: {
  view: HomeView
  /** testID 前缀:'home' / 'all'。 */
  prefix: string
  /** 一件事列表读到过没有。 */
  known: boolean
  loading: boolean
  error: unknown
  onRetry: () => void
  /** 读到了、一行都没有时说的话;null ⇒ 什么都不说。 */
  emptyText: string | null
}) {
  const lang = useLang()
  const router = useRouter()
  const retry = <Button kind="secondary" testID={`${prefix}-retry`} label={t(lang, 'common.retry')} busy={loading} onPress={onRetry} />
  const rows = view.groups.reduce((n, g) => n + g.rows.length, 0)
  return (
    <View>
      {!known && error ? <View style={{ paddingVertical: space.m, gap: space.s }}>
        <StatusHint testID={`${prefix}-unavailable`} icon="alert" label={t(lang, 'feedback.loadingFailed')} shortLabel={t(lang, 'feedback.loadingFailed')} description={t(lang, 'feedback.loadingFailed')} />
        {retry}
      </View> : !known ? <View style={{ paddingVertical: space.l }}><BusyIndicator testID={`${prefix}-loading`} label={t(lang, 'progress.loading')} /></View> : error ? (
        <StatusHint testID={`${prefix}-stale`} icon="clock" label={t(lang, 'feedback.stale')} shortLabel={t(lang, 'feedback.stale')} description={t(lang, 'feedback.stale')}>{retry}</StatusHint>
      ) : null}
      {view.waitingUnknown ? <StatusHint testID={`${prefix}-waiting-unknown`} icon="help" label={t(lang, 'now.waitingUnknown')} description={t(lang, 'now.waitingUnknown')} /> : null}
      {view.groups.map(g => (
        <View key={g.key}>
          <View style={{ paddingTop: space.xl, paddingBottom: space.s }}>
            <Txt testID={`${prefix}-group-${g.key}`} role="caption" tone={g.key === 'waiting' ? 'accent' : 'inkSoft'} accessibilityRole="header">{g.title}</Txt>
          </View>
          {g.rows.map((r, i) => <MatterRow key={`${r.source}:${r.id}`} row={r} fetchTitle={g.key === 'waiting' && i === 0} onOpen={() => router.push(r.href)} />)}
        </View>
      ))}
      {known && rows === 0 && emptyText ? <View style={{ paddingVertical: space.xxl }}>
        <Txt testID={`${prefix}-empty`} role="bubble" tone="inkSoft" style={{ textAlign: 'center' }}>{emptyText}</Txt>
      </View> : null}
    </View>
  )
}

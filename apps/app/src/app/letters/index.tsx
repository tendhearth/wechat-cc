import { useRouter } from 'expo-router'
import { Pressable, ScrollView, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { t } from '../../i18n'
import { useLang } from '../../i18n/useLang'
import { useBackendCtx } from '../../state/BackendProvider'
import { useQuery } from '../../state/hooks'
import { Button } from '../../ui/Button'
import { ConnectionNotice } from '../../ui/ConnectionNotice'
import { BusyIndicator } from '../../ui/motion'
import { StatusHint } from '../../ui/StatusHint'
import { space } from '../../ui/tokens'
import { TopBar } from '../../ui/TopBar'
import { Txt } from '../../ui/Txt'
import { useTheme } from '../../ui/useTheme'
import { letterRows } from '../../view/letters'

// 「CC 的信」(2026-10-18):寄出去了的信,新的在前 —— 一行是日期 + 开头那句;点开逐页看信纸。从设置进来,不占标签页。
export default function Letters() {
  const { c } = useTheme()
  const lang = useLang()
  const router = useRouter()
  const { backend } = useBackendCtx()
  const q = useQuery('letters', () => backend.letters(), { refreshOnMount: true })
  const rows = q.data ? letterRows(q.data, lang) : []
  return (
    <SafeAreaView edges={['top', 'bottom']} style={{ flex: 1, backgroundColor: c.paper }}>
      <TopBar title={t(lang, 'letters.title')} onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
      <View style={{ paddingHorizontal: space.xl }}><ConnectionNotice /></View>
      <ScrollView contentContainerStyle={{ paddingHorizontal: space.xl, paddingBottom: space.xl }}>
        {q.data && q.error ? <StatusHint testID="letters-stale" icon="clock" label={t(lang, 'feedback.stale')} shortLabel={t(lang, 'feedback.stale')} description={t(lang, 'feedback.stale')}>
          <Button kind="secondary" testID="letters-refresh" label={t(lang, 'common.retry')} busy={q.loading} onPress={() => void q.refresh()} />
        </StatusHint> : null}
        {!q.data && q.error ? (
          <View style={{ gap: space.m, paddingVertical: space.l }}>
            <StatusHint testID="letters-unavailable" icon="alert" label={t(lang, 'letters.unavailable')} shortLabel={t(lang, 'feedback.loadingFailed')} description={t(lang, 'letters.unavailable')} />
            <Button kind="secondary" testID="letters-retry" label={t(lang, 'common.retry')} onPress={() => void q.refresh()} />
          </View>
        ) : !q.data ? (
          <View style={{ paddingVertical: space.l }}><BusyIndicator testID="letters-loading" label={t(lang, 'progress.loading')} /></View>
        ) : rows.length === 0 ? (
          <Txt testID="letters-empty" role="bubble" tone="inkSoft" style={{ paddingVertical: space.l }}>{t(lang, 'letters.empty')}</Txt>
        ) : (
          <View style={{ gap: space.s }}>
            {rows.map(r => (
              <Pressable key={r.id} testID={`letters-row-${r.id}`} accessibilityRole="button" accessibilityLabel={`${r.date} ${r.opening}`}
                onPress={() => router.push({ pathname: '/letters/[id]', params: { id: r.id } })}
                style={({ pressed }) => ({ minHeight: 64, paddingVertical: space.m, gap: space.xs, opacity: pressed ? 0.7 : 1 })}>
                <Txt role="body" content="user" numberOfLines={2}>{r.opening}</Txt>
                <Txt role="meta" tone="inkSoft">{r.date}</Txt>
              </Pressable>
            ))}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  )
}

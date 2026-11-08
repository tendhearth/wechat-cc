import { useRouter } from 'expo-router'
import { useEffect, useRef, useState } from 'react'
import { Pressable, ScrollView, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import type { ActivityItemT } from '../backend/types'
import { t } from '../i18n'
import { useLang } from '../i18n/useLang'
import { secondaryText as st } from '../i18n/minimal-secondary'
import { useBackendCtx } from '../state/BackendProvider'
import { useQuery } from '../state/hooks'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { IconButton } from '../ui/IconButton'
import { ConnectionNotice } from '../ui/ConnectionNotice'
import { BusyIndicator } from '../ui/motion'
import { StatusHint } from '../ui/StatusHint'
import { space } from '../ui/tokens'
import { TopBar } from '../ui/TopBar'
import { Txt } from '../ui/Txt'
import { useTheme } from '../ui/useTheme'
import { activityView, mergeActivity, type ActivityRow } from '../view/activity'

// 「CC 做过的事」(B9,2026-10-20):CC 替主人做过的动作,新的在前、按天分组,最多两周。从设置进来,不占标签页。
// 只读;不用颜色区分类型 —— 那句话本身就说清楚了做了什么、成没成。一起做 / 终端 / 信能点开,别的只是一行字。
export default function Activity() {
  const { c } = useTheme()
  const lang = useLang()
  const router = useRouter()
  const { backend } = useBackendCtx()
  const q = useQuery('activity', () => backend.activity(), { refreshOnMount: true })
  // 「再早一点」翻到的页:老的那几页不会变,第一页重拉(重连 / 回前台)时留着 —— mergeActivity 按 id 去重再排序,
  // 不把主人翻到的地方冲掉。只有换了后端(换配对 / 撤销 / 演示)才清空,并让旧配对在飞的结果作废。
  const [older, setOlder] = useState<{ items: ActivityItemT[]; next: string | null } | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [moreFailed, setMoreFailed] = useState(false)
  const gen = useRef(0)
  const seenBackend = useRef(backend)
  useEffect(() => {
    if (seenBackend.current === backend) return
    seenBackend.current = backend
    gen.current += 1; setOlder(null); setMoreFailed(false); setLoadingMore(false)
  }, [backend])

  const first = q.data
  const items = first ? mergeActivity([first.items, older?.items ?? []]) : []
  const next = older ? older.next : first?.next ?? null
  const view = first ? activityView({ items, degraded: first.degraded }, Date.now(), lang) : null

  const loadMore = async () => {
    if (!next || loadingMore) return
    const my = gen.current
    setLoadingMore(true); setMoreFailed(false)
    try {
      const p = await backend.activity({ cursor: next })
      if (my !== gen.current) return
      setOlder(o => ({ items: [...(o?.items ?? []), ...p.items], next: p.next }))
    } catch {
      if (my === gen.current) setMoreFailed(true)
    } finally {
      if (my === gen.current) setLoadingMore(false)
    }
  }

  const row = (r: ActivityRow) => {
    const inner = (
      <>
        <Txt role="meta" tone="inkSoft" style={{ width: 48 }}>{r.time}</Txt>
        <Txt role="bubble" content="user" style={{ flex: 1 }}>{r.title}</Txt>
        {r.href ? <Icon name="chevronRight" size={16} color={c.inkSoft} /> : null}
      </>
    )
    const style = { flexDirection: 'row' as const, alignItems: 'flex-start' as const, minHeight: 56, gap: space.m, paddingVertical: space.m }
    const href = r.href
    return href ? (
      <Pressable key={r.id} testID={`activity-row-${r.id}`} accessibilityRole="button" accessibilityLabel={`${r.time} ${r.title}`}
        onPress={() => router.push(href)} style={({ pressed }) => ({ ...style, opacity: pressed ? 0.7 : 1 })}>
        {inner}
      </Pressable>
    ) : (
      <View key={r.id} testID={`activity-row-${r.id}`} accessible accessibilityLabel={`${r.time} ${r.title}`} style={style}>{inner}</View>
    )
  }

  return (
    <SafeAreaView edges={['top', 'bottom']} style={{ flex: 1, backgroundColor: c.paper }}>
      <TopBar title={st(lang, 'activity')} onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))} actions={<IconButton name="refresh" testID="activity-refresh" label={t(lang, 'sessions.refreshRecords')} busy={q.loading} onPress={() => void q.refresh()} />} />
      <View style={{ paddingHorizontal: space.xl }}><ConnectionNotice /></View>
      <ScrollView contentContainerStyle={{ paddingHorizontal: space.xl, paddingBottom: space.xl, gap: space.l }}>
        {!view && q.error ? (
          <View style={{ gap: space.m, paddingVertical: space.l }}>
            <StatusHint testID="activity-unavailable" icon="alert" label={t(lang, 'activity.unavailable')} shortLabel={t(lang, 'feedback.loadingFailed')} description={t(lang, 'activity.unavailable')} />
            <Button kind="secondary" testID="activity-retry" label={t(lang, 'common.retry')} onPress={() => void q.refresh()} />
          </View>
        ) : !view ? (
          <View style={{ paddingVertical: space.l }}><BusyIndicator testID="activity-loading" label={t(lang, 'progress.loading')} /></View>
        ) : (
          <>
            {view.partial ? <Txt testID="activity-partial" role="meta" tone="inkSoft" style={{ paddingTop: space.l }}>{view.partial}</Txt> : null}
            {view.empty ? <Txt testID="activity-empty" role="bubble" tone="inkSoft" style={{ paddingVertical: space.l }}>{view.empty}</Txt> : (
              view.groups.map(g => (
                <View key={g.key} testID={`activity-day-${g.key}`} style={{ gap: space.xs }}>
                  <Txt role="meta" tone="inkSoft" accessibilityRole="header" style={{ paddingTop: space.m }}>{g.label}</Txt>
                  <View style={{ gap: space.s }}>{g.rows.map(row)}</View>
                </View>
              ))
            )}
            {next ? (
              <Button kind="secondary" testID="activity-more" label={t(lang, 'activity.more')} busy={loadingMore} disabled={loadingMore} onPress={() => void loadMore()} />
            ) : !view.empty ? <Txt role="meta" tone="inkSoft">{t(lang, 'activity.window')}</Txt> : null}
            {moreFailed ? <Txt testID="activity-more-failed" role="meta" tone="inkSoft" accessibilityLiveRegion="polite">{t(lang, 'activity.moreFailed')}</Txt> : null}
            {/* 手上有列表、但最近一次重拉失败了 ⇒ 别让人以为这就是现在的样子 */}
            {q.error ? <Txt testID="activity-stale" role="meta" tone="inkSoft">{t(lang, 'activity.stale')}</Txt> : null}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  )
}

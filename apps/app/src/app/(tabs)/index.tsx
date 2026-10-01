import { useRouter } from 'expo-router'
import { Pressable, ScrollView, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { t, tCount, type Lang } from '../../i18n'
import { useLang } from '../../i18n/useLang'
import { useBackendCtx } from '../../state/BackendProvider'
import { useConnection, useQuery } from '../../state/hooks'
import { useWork } from '../../state/useWork'
import { Button } from '../../ui/Button'
import { Card } from '../../ui/Card'
import { CCFigure } from '../../ui/CCFigure'
import { ccPresence } from '../../view/presence'
import { ConnectionNotice } from '../../ui/ConnectionNotice'
import { Dot } from '../../ui/Dot'
import { DemoBanner } from '../../ui/DemoBanner'
import { SayBar } from '../../ui/SayBar'
import { space } from '../../ui/tokens'
import { TopBar } from '../../ui/TopBar'
import { useTheme } from '../../ui/useTheme'
import { connectionsTrust, connectionsView } from '../../view/connections'
import { nowView } from '../../view/now'

// 决定卡标题:只有第一张卡会主动请求说明(可能触发电脑上的便宜模型),其余只读已缓存的;优先用后端给的说明标题(按任务缓存),没有就退回原始概括。
function NeedsYouTitle({ taskId, requestId, fallback, fetch }: { taskId: string; requestId: string | undefined; fallback: string; fetch: boolean }) {
  const { c } = useTheme()
  const { backend } = useBackendCtx()
  const insight = useQuery(`insight:${taskId}`, l => backend.insight(taskId, l), { enabled: fetch })
  const title = requestId ? insight.data?.explanations[requestId]?.title : undefined
  return <Text style={{ color: c.ink, fontSize: 18, lineHeight: 25 }}>{title || fallback}</Text>
}

function weekday(lang: Lang, d: Date): string {
  try {
    return new Intl.DateTimeFormat(lang === 'zh-Hans' ? 'zh-CN' : 'en-US', { weekday: lang === 'zh-Hans' ? 'short' : 'long' }).format(d)
  } catch {
    return ''
  }
}

// 「此刻」:按 Codex 稿 desktop-palette-light-moment.png 摆 —— 顶栏、日期、问候、概括、需要你决定、CC 近况、一起做的事、说一句。
export default function Now() {
  const { c } = useTheme()
  const lang = useLang()
  const router = useRouter()
  const conn = useConnection()
  const { backend } = useBackendCtx()
  const { approvals, agents, matters, demo } = useWork()
  const date = new Date()
  const v = nowView({ approvals, agents, matters, hour: date.getHours() })
  const links = useQuery('connections', () => backend.connections())
  // 读不到 ⇒ 说「不知道」,不报错、不画绿
  const trust = connectionsTrust(links, conn.state)
  const lv = links.data && trust === 'live' ? connectionsView(links.data, Date.now(), lang).headline : null
  const titleOf = (id: string) => matters.find((m) => m.id === id)?.title ?? ''
  const working = agents.tasks.find((x) => x.phase === 'working')
  const summary =
    v.needsYou.length === 0
      ? t(lang, 'now.needsYouSummaryNone')
      : v.needsYou.length === 1
        ? t(lang, 'now.needsYouTitle')
        : t(lang, 'now.needsYouSummaryMany', { n: v.needsYou.length })

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: c.bg }}>
      <TopBar
        title={t(lang, 'common.wordmark')}
        onAvatar={() => router.push('/settings')}
        onConnection={() => router.push('/connections')}
        connectionTestID="now-connections"
      />
      <View style={{ paddingHorizontal: space.xl }}><ConnectionNotice /></View>
      <ScrollView contentContainerStyle={{ paddingHorizontal: space.xl, paddingBottom: space.xl, gap: space.xl }}>
        {demo ? <DemoBanner /> : null}

        <View style={{ gap: space.s }}>
          <Text style={{ color: c.muted, fontSize: 13 }}>{t(lang, 'now.dateLine', { weekday: weekday(lang, date) })}</Text>
          <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 32, lineHeight: 40 }}>
            {t(lang, v.greetingKey)}
          </Text>
          <Text style={{ color: c.muted, fontSize: 15 }}>{summary}</Text>
        </View>

        {v.needsYou.map((g, i) => (
          <Card key={g.taskId} testID="now-needs-you-card" style={{ gap: space.s }}>
            <Text style={{ color: c.warn, fontSize: 13 }}>
              {t(lang, 'now.needsYouEyebrow')}
              {g.count > 1 ? ` · ${t(lang, 'now.needsYouCount', { n: g.count })}` : ''}
            </Text>
            <NeedsYouTitle taskId={g.taskId} requestId={approvals.find((a) => a.taskId === g.taskId)?.id} fallback={g.firstSummary} fetch={i === 0} />
            {titleOf(g.taskId) ? <Text style={{ color: c.muted, fontSize: 14 }}>{titleOf(g.taskId)}</Text> : null}
            <View style={{ alignSelf: 'flex-start', marginTop: space.s }}>
              <Button
                kind="primary"
                testID="now-look-then-decide"
                label={t(lang, 'now.lookThenDecide')}
                onPress={() => router.push(`/approval/${encodeURIComponent(g.taskId)}`)}
              />
            </View>
          </Card>
        ))}

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.l }}>
          <CCFigure size={112} presence={ccPresence(conn)} />
          <View style={{ flex: 1, gap: space.xs }}>
            <Text style={{ color: c.ink, fontSize: 16 }}>{t(lang, 'now.ccLine.default')}</Text>
            <Text style={{ color: c.muted, fontSize: 14, lineHeight: 21 }}>
              {working ? t(lang, 'now.ccWorking', { title: working.title }) : t(lang, 'now.ccIdle')}
            </Text>
          </View>
        </View>

        <Pressable
          testID="now-connections-row"
          accessibilityRole="button"
          accessibilityLabel={`${t(lang, 'links.title')}, ${lv ? t(lang, lv.key, { n: lv.n }) : t(lang, 'links.unknown')}`}
          onPress={() => router.push('/connections')}
          style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: space.m, minHeight: 48, opacity: pressed ? 0.7 : 1 })}
        >
          <Dot kind={lv ? lv.dot : 'unknown'} />
          <Text style={{ color: c.muted, fontSize: 14 }}>{t(lang, 'links.title')}</Text>
          <Text numberOfLines={1} style={{ flex: 1, color: c.ink, fontSize: 14 }}>{lv ? t(lang, lv.key, { n: lv.n }) : t(lang, 'links.unknown')}</Text>
          <Text style={{ color: c.muted, fontSize: 22 }}>›</Text>
        </Pressable>

        {v.together.length > 0 ? (
          <View>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingBottom: space.m, borderBottomWidth: 1, borderBottomColor: c.line }}>
              <Text style={{ color: c.muted, fontSize: 13 }}>{t(lang, 'now.togetherTitle')}</Text>
              <Text style={{ color: c.muted, fontSize: 13 }}>{tCount(lang, 'now.togetherCount', v.together.length)}</Text>
            </View>
            {v.together.map((m) => (
              <Pressable
                key={m.id}
                testID={`now-together-item-${m.id}`}
                accessibilityRole="button"
                accessibilityLabel={`${m.title}, ${t(lang, `status.${m.status}`)}`}
                onPress={() => router.push(`/matter/${encodeURIComponent(m.id)}`)}
                style={({ pressed }) => ({
                  flexDirection: 'row',
                  alignItems: 'center',
                  minHeight: 64,
                  paddingVertical: space.m,
                  borderBottomWidth: 1,
                  borderBottomColor: c.line,
                  opacity: pressed ? 0.7 : 1,
                })}
              >
                <View style={{ flex: 1, gap: 2 }}>
                  <Text numberOfLines={1} style={{ color: c.ink, fontSize: 16 }}>{m.title}</Text>
                  <Text style={{ color: m.status === 'waiting' ? c.warn : c.muted, fontSize: 13 }}>{t(lang, `status.${m.status}`)}</Text>
                </View>
                <Text style={{ color: c.muted, fontSize: 22 }}>›</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
      </ScrollView>
      <View style={{ paddingHorizontal: space.xl, paddingBottom: space.m }}>
        <SayBar testID="now-say" placeholder={t(lang, 'now.sayToCC')} onPress={() => router.push('/chat')} />
      </View>
    </SafeAreaView>
  )
}

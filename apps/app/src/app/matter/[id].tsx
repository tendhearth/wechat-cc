import { useEffect, useRef } from 'react'
import { Redirect, useLocalSearchParams, useRouter } from 'expo-router'
import { Pressable, ScrollView, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { t } from '../../i18n'
import { useLang } from '../../i18n/useLang'
import { useBackendCtx } from '../../state/BackendProvider'
import { useConnection, useQuery, useTopic } from '../../state/hooks'
import { ConnectionNotice } from '../../ui/ConnectionNotice'
import { Button } from '../../ui/Button'
import { Card } from '../../ui/Card'
import { monoFamily, serifFamily } from '../../ui/fonts'
import { SayBar } from '../../ui/SayBar'
import { Sheet } from '../../ui/Sheet'
import { StatusPill } from '../../ui/StatusPill'
import { space } from '../../ui/tokens'
import { TopBar } from '../../ui/TopBar'
import { useTheme } from '../../ui/useTheme'
import { isOwnerChatMatter } from '../../view/chat'
import { conversationView } from '../../view/conversation'
import { progressView } from '../../view/progress'

const mono = monoFamily

// 进展页:状态标签在「CC 的进展」概括之上;概括没到时用骨架占位;下面是这件事的真对话。
// 主人自己那条聊天(只认它,Ruling 9)改道去 /chat;访客的聊天照常显示。
export default function Matter() {
  const { c } = useTheme()
  const lang = useLang()
  const router = useRouter()
  const conn = useConnection()
  const { backend } = useBackendCtx()
  const params = useLocalSearchParams<{ id: string }>()
  const id = Array.isArray(params.id) ? params.id[0] : params.id
  // 打开就拉新:有缓存也重拉详情与概括(旧缓存先摆着,拿到新的再换)。
  const detail = useQuery(`matter:${id}`, l => backend.matter(id, l), { refreshOnMount: true })
  const insight = useQuery(`insight:${id}`, l => backend.insight(id, l), { refreshOnMount: true })
  const changes = useQuery(`changes:${id}`, () => backend.changes(id))
  const isChat = detail.data?.matter.kind === 'chat'
  // 只有聊天类才需要知道主人对话是哪一件;与 /chat、一起做共用同一份缓存
  const ownerChat = useQuery('chat:latest', () => backend.chat({}), { enabled: isChat })
  const ver = useTopic<{ version?: unknown }>(`matter/${id}`)
  const seen = useRef<unknown>(undefined)
  const verKey = ver === undefined ? undefined : JSON.stringify(ver)
  const { refresh: refreshDetail } = detail
  const { refresh: refreshInsight } = insight
  const { refresh: refreshChanges } = changes
  useEffect(() => {
    if (verKey === undefined) return
    if (seen.current !== undefined && seen.current !== verKey) {
      void refreshDetail(); void refreshInsight(); void refreshChanges()
    }
    seen.current = verKey
  }, [verKey, refreshDetail, refreshInsight, refreshChanges])

  const header = (
    <>
      <TopBar title={t(lang, 'common.wordmark')} onBack={() => router.back()} connection={conn.state === 'online' ? 'online' : 'offline'} onAvatar={() => router.push('/settings')} />
      <View style={{ paddingHorizontal: space.xl }}><ConnectionNotice /></View>
    </>
  )
  const ownerChatId = ownerChat.data?.matterId ?? null
  if (detail.data && isOwnerChatMatter(detail.data.matter, ownerChatId)) return <Redirect href="/chat" />
  // 聊天类但还不知道主人对话是哪件:等一下再决定改不改道(读失败 / 没主人 ⇒ 当普通的事显示)
  const decidingChat = isChat && ownerChatId === null && !ownerChat.error
  if (!detail.data || decidingChat) {
    return (
      <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: c.bg }}>
        {header}
        <Text style={{ color: c.muted, padding: space.xl }}>{detail.error && !detail.data ? t(lang, 'progress.loadFailed') : t(lang, 'progress.loading')}</Text>
      </SafeAreaView>
    )
  }
  const d = detail.data
  const v = progressView(d, insight.data ?? null, changes.data ?? null, !!insight.error && !insight.data)
  const files = changes.data?.files ?? []
  const conv = conversationView(d.events)

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: c.bg }}>
      {header}
      <ScrollView contentContainerStyle={{ paddingHorizontal: space.xl, paddingBottom: space.xl, gap: space.l }}>
        <Text style={{ color: c.muted, fontSize: 13 }}>{t(lang, 'progress.breadcrumb')}</Text>
        <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 28, lineHeight: 36, fontFamily: serifFamily, fontWeight: '600' }}>{v.title}</Text>
        <View testID="progress-status"><StatusPill status={v.status} /></View>

        <Card style={{ gap: space.m }}>
          <Text style={{ color: c.muted, fontSize: 12, fontWeight: '600' }}>{t(lang, 'progress.ccProgress')}</Text>
          {v.summaryState === 'failed' ? (
            <Pressable testID="progress-summary" accessibilityRole="button" accessibilityLabel={t(lang, 'progress.summaryUnavailable')} onPress={() => void insight.refresh()}>
              <Text style={{ color: c.muted, fontSize: 15, lineHeight: 22 }}>{t(lang, 'progress.summaryUnavailable')}</Text>
            </Pressable>
          ) : v.summaryState === 'loading' ? (
            <View testID="progress-summary" accessibilityLabel={t(lang, 'progress.loading')} style={{ gap: space.s }}>
              <View style={{ height: 14, borderRadius: 7, backgroundColor: c.line, width: '92%' }} />
              <View style={{ height: 14, borderRadius: 7, backgroundColor: c.line, width: '70%' }} />
            </View>
          ) : v.summaryState === 'none' ? (
            <Text testID="progress-summary" style={{ color: c.muted, fontSize: 15, lineHeight: 22 }}>{t(lang, 'progress.noSummary')}</Text>
          ) : (
            <Text testID="progress-summary" style={{ color: c.ink, fontSize: 16, lineHeight: 24 }}>{v.summary}</Text>
          )}
          {v.steps.map((s, i) => (
            <View key={i} style={{ flexDirection: 'row', gap: space.m }}>
              <Text accessibilityLabel={s.done ? t(lang, 'progress.stepDone') : t(lang, 'progress.stepWaiting')} style={{ color: s.done ? c.ok : c.warn, fontSize: 16, width: 20 }}>
                {s.done ? '✓' : '⏸'}
              </Text>
              <View style={{ flex: 1 }}>
                <Text style={{ color: c.ink, fontSize: 15, fontWeight: '600' }}>{s.title}</Text>
                {s.detail ? <Text style={{ color: c.muted, fontSize: 14, lineHeight: 20 }}>{s.detail}</Text> : null}
              </View>
            </View>
          ))}
        </Card>

        <Card testID="progress-conversation" style={{ gap: space.m }}>
          <Text accessibilityRole="header" style={{ color: c.muted, fontSize: 12, fontWeight: '600' }}>{t(lang, 'progress.conversation')}</Text>
          {conv.length === 0 ? <Text style={{ color: c.muted, fontSize: 14 }}>{t(lang, 'progress.noEvents')}</Text> : null}
          {conv.map((e, i) =>
            e.kind === 'steps' ? (
              <Text key={i} numberOfLines={1} style={{ color: c.muted, fontSize: 13 }}>
                {t(lang, 'progress.stepsN', { n: e.count ?? 1 })} · {e.text}
              </Text>
            ) : e.kind === 'error' ? (
              <Text key={i} style={{ color: c.warn, fontSize: 14, lineHeight: 20 }}>{e.text}</Text>
            ) : (
              <View key={i} style={{ alignItems: e.kind === 'me' ? 'flex-end' : 'flex-start' }}>
                <View
                  accessible
                  accessibilityLabel={`${e.kind === 'me' ? t(lang, 'chat.me') : t(lang, 'cc.label')}: ${e.text}`}
                  style={{ maxWidth: '88%', paddingHorizontal: space.m, paddingVertical: space.s, borderRadius: 14, backgroundColor: e.kind === 'me' ? c.accentSoft : c.bg }}
                >
                  <Text selectable style={{ color: c.ink, fontSize: 15, lineHeight: 22 }}>{e.text}</Text>
                </View>
              </View>
            ),
          )}
        </Card>

        {v.pendingCount > 0 ? (
          <Button kind="primary" testID="progress-view-approval" label={t(lang, 'progress.viewApproval')} onPress={() => router.push(`/approval/${encodeURIComponent(d.task?.id ?? id)}`)} />
        ) : null}

        <Sheet testID="progress-changes" title={t(lang, 'progress.viewChangesN', { n: v.changedFiles })}>
            {files.length === 0 ? <Text style={{ color: c.muted, fontSize: 14 }}>{t(lang, 'progress.noChanges')}</Text> : null}
            {files.map((f, i) => (
              <View key={i} style={{ paddingVertical: space.s, gap: space.xs }}>
                <Text style={{ color: c.ink, fontSize: 13, fontFamily: mono }}>{f.path}</Text>
                {f.kind === 'not_reviewed' ? (
                  <>
                    <Text style={{ color: c.muted, fontSize: 13 }}>{t(lang, 'progress.notReviewed')}</Text>
                    {f.reason ? <Text style={{ color: c.muted, fontSize: 12 }}>{f.reason}</Text> : null}
                  </>
                ) : f.truncated ? (
                  <Text style={{ color: c.muted, fontSize: 13 }}>{t(lang, 'progress.tooBig')}</Text>
                ) : f.diff ? (
                  <ScrollView nestedScrollEnabled style={{ maxHeight: 320 }}>
                    <Text style={{ color: c.muted, fontSize: 12, lineHeight: 17, fontFamily: mono }}>{f.diff}</Text>
                  </ScrollView>
                ) : f.reason ? (
                  <Text style={{ color: c.muted, fontSize: 13 }}>{f.reason}</Text>
                ) : null}
              </View>
            ))}
          </Sheet>

        <Sheet testID="progress-process" title={t(lang, 'progress.viewProcess')}>
            <View style={{ gap: space.s }}>
              {d.task ? (
                <>
                  <Text style={{ color: c.ink, fontSize: 14 }}>{t(lang, 'progress.executor')}: {d.task.providerId}</Text>
                  <Text style={{ color: c.ink, fontSize: 13, fontFamily: mono }}>{t(lang, 'progress.path')}: {d.task.path}</Text>
                </>
              ) : <Text style={{ color: c.muted, fontSize: 14 }}>{t(lang, 'progress.noEvents')}</Text>}
            </View>
          </Sheet>
      </ScrollView>
      <View style={{ paddingHorizontal: space.xl, paddingBottom: space.m }}>
        <SayBar testID="progress-say" placeholder={t(lang, 'progress.continueSay')} onPress={() => router.push(`/compose?matter=${encodeURIComponent(id)}`)} />
      </View>
    </SafeAreaView>
  )
}

import { useRouter } from 'expo-router'
import { Pressable, ScrollView, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { t, tCount } from '../../i18n'
import { useLang } from '../../i18n/useLang'
import { useBackendCtx } from '../../state/BackendProvider'
import { useConnection, useQuery } from '../../state/hooks'
import { useWork } from '../../state/useWork'
import { CCFigure } from '../../ui/CCFigure'
import { ConnectionNotice } from '../../ui/ConnectionNotice'
import { DemoBanner } from '../../ui/DemoBanner'
import { SayBar } from '../../ui/SayBar'
import { radius, space } from '../../ui/tokens'
import { TopBar } from '../../ui/TopBar'
import { Txt } from '../../ui/Txt'
import { useTheme } from '../../ui/useTheme'
import { formatSynced } from '../../view/connection'
import { latestCCLine, nowView } from '../../view/now'
import { ccPresence } from '../../view/presence'

// 等你的事那一行的标题:只有第一行会主动请求说明(可能触发电脑上的便宜模型),其余只读已缓存的;优先用后端给的说明标题(按任务缓存),没有就退回原始概括。
function WaitingTitle({ taskId, requestId, fallback, fetch }: { taskId: string; requestId: string; fallback: string; fetch: boolean }) {
  const { backend } = useBackendCtx()
  const insight = useQuery(`insight:${taskId}`, l => backend.insight(taskId, l), { enabled: fetch })
  const title = insight.data?.explanations[requestId]?.title
  return <Txt role="item" content="user">{title || fallback}</Txt>
}

// 「此刻」照稿(desktop-redesign-now.html 窄屏):问候、CC(明暗看连接)与它最近一句真话、「N 件事等你」、底部说一句。
// 只有一层:没有卡片套卡片;一起做的列表在「一起做」页,这里不重复;连接状态只在顶栏。
export default function Now() {
  const { c } = useTheme()
  const lang = useLang()
  const router = useRouter()
  const conn = useConnection()
  const { backend } = useBackendCtx()
  const { approvals, matters, demo } = useWork()
  const v = nowView({ approvals, matters, hour: new Date().getHours() })
  const chat = useQuery('chat:latest', () => backend.chat({})) // 与 /chat 同一个键、同一份缓存
  const line = latestCCLine(chat.data)
  const presence = ccPresence(conn)
  const openChat = () => router.push('/chat')

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: c.paper }}>
      <TopBar title={t(lang, 'common.wordmark')} onAvatar={() => router.push('/settings')}
        onConnection={() => router.push('/connections')} connectionTestID="now-connections" />
      <ScrollView contentContainerStyle={{ paddingHorizontal: space.xl, paddingBottom: space.xl, gap: space.xl }}>
        <ConnectionNotice only="revoked" />
        {demo ? <DemoBanner /> : null}
        {/* 照稿:CC 最近一句贴在 CC 头上(小尾巴朝 CC);问候在左、CC 在右同一行 */}
        <View style={{ gap: space.xs }}>
          {line ? (
            <Pressable testID="now-cc-bubble" accessibilityRole="button" accessibilityLabel={`${t(lang, 'now.ccBubble')}: ${line.text}`} onPress={openChat}
              style={({ pressed }) => ({ alignSelf: 'flex-end', maxWidth: '70%', paddingHorizontal: space.l, paddingVertical: space.s, borderWidth: 1, borderColor: pressed ? c.accent : c.hair, backgroundColor: c.paper,
                borderTopLeftRadius: radius.bubble, borderTopRightRadius: radius.bubble, borderBottomLeftRadius: radius.bubble, borderBottomRightRadius: 4 })}>
              <Txt role="bubble" content="user" numberOfLines={3}>{line.text}</Txt>
              <Txt role="caption" tone="inkSoft">{formatSynced(line.at, Date.now(), lang)}</Txt>
            </Pressable>
          ) : null}
          {/* CC 图上方有透明留白:往上收一点,让气泡贴着 CC 的头 */}
          <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: space.m, marginTop: line ? -space.l : 0 }}>
            <Txt role="display" accessibilityRole="header" style={{ flex: 1, paddingBottom: space.s }}>{t(lang, v.greetingKey)}</Txt>
            <Pressable testID="now-cc" accessibilityRole="button" accessibilityLabel={t(lang, 'now.openChat')} onPress={openChat} style={{ marginRight: space.s }}>
              <CCFigure size={120} presence={presence} />
            </Pressable>
          </View>
        </View>
        {v.waiting.length > 0 ? (
          <View>
            <Txt testID="now-waiting-title" role="meta" tone="inkSoft" accessibilityRole="header" style={{ marginBottom: space.s }}>{tCount(lang, 'now.waiting', v.waiting.length)}</Txt>
            <View style={{ borderTopWidth: 1, borderTopColor: c.hair }}>
              {v.waiting.map((w, i) => (
                <View key={w.taskId} testID="now-needs-you-card">
                  <Pressable testID="now-look-then-decide" accessibilityRole="button" onPress={() => router.push(`/approval/${encodeURIComponent(w.taskId)}`)}
                    style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: space.l, minHeight: 64, paddingVertical: space.l, paddingHorizontal: space.xs, borderBottomWidth: 1, borderBottomColor: c.hair, opacity: pressed ? 0.7 : 1 })}>
                    <View style={{ flex: 1, gap: 2 }}>
                      <WaitingTitle taskId={w.taskId} requestId={w.firstRequestId} fallback={w.fallback} fetch={i === 0} />
                      {w.matterTitle ? <Txt role="meta" tone="inkSoft" content="user" numberOfLines={1}>{w.matterTitle}</Txt> : null}
                    </View>
                    <Txt role="bubble" tone="inkSoft">{t(lang, w.kind === 'permission' ? 'now.goLook' : 'now.goAnswer')} ›</Txt>
                  </Pressable>
                </View>
              ))}
            </View>
          </View>
        ) : null}
      </ScrollView>
      <View style={{ paddingHorizontal: space.xl, paddingBottom: space.m }}>
        <SayBar testID="now-say" placeholder={t(lang, 'now.sayToCC')} onPress={openChat} />
      </View>
    </SafeAreaView>
  )
}

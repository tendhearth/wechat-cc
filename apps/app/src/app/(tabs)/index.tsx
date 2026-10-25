import { useRouter } from 'expo-router'
import { useEffect, useMemo, useState } from 'react'
import { Pressable, ScrollView, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { t, tCount } from '../../i18n'
import { useLang } from '../../i18n/useLang'
import { useBackendCtx } from '../../state/BackendProvider'
import { useConnection, useQuery } from '../../state/hooks'
import { useWork } from '../../state/useWork'
import { useTerminalSessions } from '../../state/useTerminal'
import { useToday } from '../../state/useToday'
import { useAwaySince } from '../../state/useAway'
import { useCompanion } from '../../state/useCompanion'
import { CCFigure } from '../../ui/CCFigure'
import { useMotionEnabled } from '../../ui/motion'
import { makeCCMotionTracker, type CCMotionEvent } from '../../view/cc-motion'
import { CompanionCard } from '../../ui/CompanionCard'
import { ConnectionNotice } from '../../ui/ConnectionNotice'
import { DemoBanner } from '../../ui/DemoBanner'
import { SayBar } from '../../ui/SayBar'
import { radius, space } from '../../ui/tokens'
import { TopBar } from '../../ui/TopBar'
import { Txt } from '../../ui/Txt'
import { useTheme } from '../../ui/useTheme'
import { companionCard, companionStatus } from '../../view/companion'
import { formatSynced } from '../../view/connection'
import { latestCCLine, nowView } from '../../view/now'
import { ccPresence } from '../../view/presence'
import { terminalNeedsYou, terminalRow } from '../../view/terminal'
import { todayView } from '../../view/today'

// 等你的事那一行的标题:只有第一行会主动请求说明(可能触发电脑上的便宜模型),其余只读已缓存的;优先用后端给的说明标题(按任务缓存),没有就退回原始概括。
function WaitingTitle({ taskId, requestId, fallback, fetch }: { taskId: string; requestId: string; fallback: string; fetch: boolean }) {
  const { backend } = useBackendCtx()
  const insight = useQuery(`insight:${taskId}`, l => backend.insight(taskId, l), { enabled: fetch })
  const title = insight.data?.explanations[requestId]?.title
  return <Txt role="item" content="user">{title || fallback}</Txt>
}

// 「此刻」照稿(desktop-redesign-now.html 窄屏):问候、CC(明暗看连接)与它最近一句真话、它在干什么、它带回来的一样、「N 件事等你」、底部说一句。
// 只有一层:没有卡片套卡片;一起做的列表在「一起做」页,这里不重复;连接状态只在顶栏。
export default function Now() {
  const { c } = useTheme()
  const lang = useLang()
  const router = useRouter()
  const conn = useConnection()
  const { backend } = useBackendCtx()
  const { approvals, approvalsKnown, agents, matters, demo } = useWork()
  const v = nowView({ approvals, matters, hour: new Date().getHours(), known: demo || conn.state === 'online' })
  const chat = useQuery('chat:latest', () => backend.chat({})) // 与 /chat 同一个键、同一份缓存
  const line = latestCCLine(chat.data)
  const presence = ccPresence(conn, { demo }) // 演示:暗(不是真信号)
  const openChat = () => router.push('/chat')
  // CC 下面一行「在干什么」+ 一张它带回来的东西:都只从电脑上的真信号来(home 主题 / agents 主题 / 首屏动态),没信号就不出现。
  const companion = useCompanion()
  const statusKey = companionStatus({ known: demo || presence === 'here', activity: companion.activity, running: agents.running })
  const status = statusKey ? t(lang, statusKey) : null
  const card = companion.home ? companionCard(companion.home.events, companion.home.seenUntil, Date.now(), companion.localSeen) : null
  // 终端里等你批准的(手机拍得了的那些)和 CC 自己的事排在同一个「N 件事等你」里。
  const terminal = useTerminalSessions()
  const termWaiting = terminalNeedsYou(terminal.sessions, !v.waitingUnknown).map(s => terminalRow(s, Date.now(), lang))
  const waitingTotal = v.waiting.length + termWaiting.length
  // 「今天」:CC 统管的所有执行者过去 24 小时的几个数 + 最近做完的三件(与微信「日报」同一份)。
  // 离开 App 一小时以上 ⇒ 这一段先说「你不在的这 N 小时」做完了什么(只在本机记离开的时间)。
  const todayData = useToday().today
  const today = todayView(todayData, Date.now(), lang, useAwaySince())
  const motionEnabled = useMotionEnabled()
  const tracker = useMemo(makeCCMotionTracker, [backend])
  const [motion, setMotion] = useState<CCMotionEvent>()
  const snapshot = JSON.stringify({
    active: presence === 'here' && motionEnabled,
    received: chat.data ? (line ? [{ id: [...chat.data.messages].reverse().find(m => m.role === 'cc' && m.at === line.at)?.id ?? String(line.at), at: line.at }] : []) : undefined,
    done: todayData?.done.map(item => ({ id: `${item.source}:${item.id}`, at: item.at })),
    waiting: approvalsKnown && terminal.loaded ? [...approvals.map(item => item.id), ...terminal.sessions.filter(s => terminalNeedsYou([s], true).length > 0).map(s => `terminal:${s.session_id}:${s.pending?.hash ?? ''}`)] : undefined,
  })
  useEffect(() => {
    const current = JSON.parse(snapshot)
    const event = tracker.read(current)
    if (event) setMotion(event)
    else if (!current.active || current.waiting?.length === 0) setMotion(previous => previous?.behavior === 'wait' || !current.active ? undefined : previous)
  }, [tracker, snapshot])

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: c.paper }}>
      <TopBar title={t(lang, 'common.wordmark')} showStatus onAvatar={() => router.push('/settings')}
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
            {/* 问候一行放下:英文「Good evening」在 iPhone 17 Pro 上挨着 CC 会折行 ⇒ 允许缩到 0.7 倍,不换行 */}
            <Txt role="display" accessibilityRole="header" numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7} style={{ flex: 1, paddingBottom: space.s }}>{t(lang, v.greetingKey)}</Txt>
            <Pressable testID="now-cc" accessibilityRole="button" accessibilityLabel={t(lang, 'now.openChat')} onPress={openChat} style={{ marginRight: space.s }}>
              <CCFigure size={120} presence={presence} mood={status ?? undefined} behavior={motion?.behavior} eventKey={motion?.eventKey} />
            </Pressable>
          </View>
          {status ? <Txt testID="now-cc-status" role="meta" tone="inkSoft" numberOfLines={1} style={{ alignSelf: 'flex-end', marginTop: -space.s }}>{status}</Txt> : null}
        </View>
        <CompanionCard card={card} onSeen={companion.markSeen} />
        {v.waitingUnknown ? (
          <Txt testID="now-waiting-unknown" role="meta" tone="inkSoft">{t(lang, 'now.waitingUnknown')}</Txt>
        ) : null}
        {waitingTotal > 0 ? (
          <View>
            <Txt testID="now-waiting-title" role="meta" tone="inkSoft" accessibilityRole="header" style={{ marginBottom: space.s }}>{tCount(lang, 'now.waiting', waitingTotal)}</Txt>
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
              {termWaiting.map(r => (
                <Pressable key={`terminal-${r.id}`} testID={`now-terminal-${r.id}`} accessibilityRole="button" onPress={() => router.push(`/terminal/${encodeURIComponent(r.id)}`)}
                  style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: space.l, minHeight: 64, paddingVertical: space.l, paddingHorizontal: space.xs, borderBottomWidth: 1, borderBottomColor: c.hair, opacity: pressed ? 0.7 : 1 })}>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Txt role="item" content="user" numberOfLines={2}>{r.pendingText}</Txt>
                    <Txt role="meta" tone="inkSoft" content="user" numberOfLines={1}>{`${r.project} · ${r.source}`}</Txt>
                  </View>
                  <Txt role="bubble" tone="inkSoft">{t(lang, 'now.goLook')} ›</Txt>
                </Pressable>
              ))}
            </View>
          </View>
        ) : null}
        {/* 过去 24 小时放在等你的事下面:先管要你管的,再看做了什么;等你的数不在这里重复。 */}
        {today ? (
          <View testID="now-today">
            <Pressable testID="now-today-counts" accessibilityRole="button" accessibilityLabel={`${today.title}: ${today.counts}. ${t(lang, 'today.openAll')}`} onPress={() => router.push('/together')}
              style={({ pressed }) => ({ gap: 2, marginBottom: space.s, opacity: pressed ? 0.7 : 1 })}>
              <Txt role="meta" tone="inkSoft" accessibilityRole="header">{today.title}</Txt>
              {today.counts ? <Txt role="item">{today.counts}</Txt> : null}
              {today.partial ? <Txt testID="now-today-partial" role="caption" tone="inkSoft">{t(lang, 'today.partial')}</Txt> : null}
            </Pressable>
            {today.done.length ? (
              <View style={{ borderTopWidth: 1, borderTopColor: c.hair }}>
                {today.done.map(r => (
                  <Pressable key={r.key} testID={`now-today-${r.key}`} accessibilityRole="button" onPress={() => router.push(r.href)}
                    style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: space.l, minHeight: 56, paddingVertical: space.m, paddingHorizontal: space.xs, borderBottomWidth: 1, borderBottomColor: c.hair, opacity: pressed ? 0.7 : 1 })}>
                    <View style={{ flex: 1, gap: 2 }}>
                      <Txt role="item" content="user" numberOfLines={1}>{r.title}</Txt>
                      <Txt role="meta" tone="inkSoft" content="user" numberOfLines={1}>{r.sub}</Txt>
                    </View>
                    <Txt role="caption" tone="inkSoft">{r.ago}</Txt>
                  </Pressable>
                ))}
              </View>
            ) : null}
          </View>
        ) : null}
      </ScrollView>
      <View style={{ paddingHorizontal: space.xl, paddingBottom: space.m }}>
        <SayBar testID="now-say" placeholder={t(lang, 'now.sayToCC')} onPress={openChat} />
      </View>
    </SafeAreaView>
  )
}

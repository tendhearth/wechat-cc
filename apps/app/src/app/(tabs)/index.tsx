import { useRouter } from 'expo-router'
import { useEffect, useMemo, useState } from 'react'
import { Pressable, ScrollView, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { t } from '../../i18n'
import { useLang } from '../../i18n/useLang'
import { useBackendCtx } from '../../state/BackendProvider'
import { useConnection, useQuery } from '../../state/hooks'
import { useWork } from '../../state/useWork'
import { useChatUpdates } from '../../state/useChatUpdates'
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
import { space } from '../../ui/tokens'
import { TopBar } from '../../ui/TopBar'
import { Txt } from '../../ui/Txt'
import { useTheme } from '../../ui/useTheme'
import { companionCard, companionStatus } from '../../view/companion'
import { formatSynced } from '../../view/connection'
import { latestCCLine, nowView } from '../../view/now'
import { ccPresence } from '../../view/presence'
import { terminalNeedsYou, terminalRow } from '../../view/terminal'
import { todayView } from '../../view/today'
import { Icon } from '../../ui/Icon'
import { StatusHint } from '../../ui/StatusHint'
import { LinkRow } from '../../ui/Rows'
import { WaitingTitle } from '../../ui/WaitingTitle'

// 等你的事那一行的标题:只有第一行会主动请求说明(可能触发电脑上的便宜模型),其余只读已缓存的;优先用后端给的说明标题(按任务缓存),没有就退回原始概括。
// 已批准的极简稿:居中 CC 与最近一句真话、具体的待回应行、紧凑完成入口、底部说一句。
// 一起做的完整列表不在这里重复;真实带回来的内容保留低层级入口。
export default function Now() {
  const { c } = useTheme()
  const lang = useLang()
  const router = useRouter()
  const conn = useConnection()
  const { backend } = useBackendCtx()
  const { approvals, approvalsKnown, agents, matters, demo } = useWork()
  const v = nowView({ approvals, matters, hour: new Date().getHours(), known: demo || conn.state === 'online' })
  const chat = useQuery('chat:latest', () => backend.chat({})) // 与 /chat 同一个键、同一份缓存
  useChatUpdates(chat.data?.matterId, chat.refresh)
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
    received: chat.data ? (line ? [{ id: line.id, at: line.at }] : []) : undefined,
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
      <ScrollView contentContainerStyle={{ paddingHorizontal: space.xl, paddingBottom: space.xl, gap: space.l, flexGrow: 1 }}>
        <ConnectionNotice />
        {demo ? <DemoBanner /> : null}
        <View style={{ alignItems: 'center', paddingTop: space.xl, paddingBottom: space.xxl, gap: space.m }}>
          <Pressable testID="now-cc" accessibilityRole="button" accessibilityLabel={t(lang, 'now.openChat')} onPress={openChat} style={{ minWidth: 154, minHeight: 154 }}>
            <CCFigure size={154} presence={presence} mood={status ?? undefined} behavior={motion?.behavior} eventKey={motion?.eventKey} />
          </Pressable>
          {line ? <Pressable testID="now-cc-bubble" accessibilityRole="button" accessibilityLabel={`${t(lang, 'now.ccBubble')}: ${line.text}, ${formatSynced(line.at, Date.now(), lang)}`} onPress={openChat} style={{ minHeight: 44, justifyContent: 'center', maxWidth: '100%' }}>
            <Txt role="item" content="user" numberOfLines={3} style={{ textAlign: 'center' }}>{line.text}</Txt>
          </Pressable> : null}
        </View>
        {v.waitingUnknown ? <StatusHint testID="now-waiting-unknown" icon="help" label={t(lang, 'now.waitingUnknown')} description={t(lang, 'now.waitingUnknown')} /> : null}
        {waitingTotal > 0 ? <View>
          {v.waiting.map((w, i) => <View key={w.taskId} testID="now-needs-you-card">
            <Pressable testID="now-look-then-decide" accessibilityRole="button" accessibilityLabel={`${w.fallback}, ${t(lang, 'status.waiting')}`} onPress={() => router.push(`/approval/${encodeURIComponent(w.taskId)}`)}
              style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: space.m, minHeight: 78, paddingVertical: space.l, opacity: pressed ? 0.7 : 1 })}>
              <Icon name={w.kind === 'permission' ? 'shield' : 'help'} color={c.accent} />
              <View style={{ flex: 1, gap: space.xs }}>
                <WaitingTitle taskId={w.taskId} requestId={w.firstRequestId} fallback={w.fallback} fetch={i === 0} />
                {w.matterTitle ? <Txt role="caption" tone="inkSoft" content="user" numberOfLines={1}>{w.matterTitle}</Txt> : null}
              </View>
              <Icon name="chevronRight" size={16} color={c.inkSoft} />
            </Pressable>
          </View>)}
          {termWaiting.map(r => <Pressable key={`terminal-${r.id}`} testID={`now-terminal-${r.id}`} accessibilityRole="button" accessibilityLabel={`${r.pendingText}, ${r.project}, ${r.source}, ${t(lang, 'status.waiting')}`} onPress={() => router.push(`/terminal/${encodeURIComponent(r.id)}`)}
            style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: space.m, minHeight: 78, paddingVertical: space.l, opacity: pressed ? 0.7 : 1 })}>
            <Icon name="shield" color={c.accent} />
            <View style={{ flex: 1, gap: space.xs }}><Txt role="item" content="user" numberOfLines={2}>{r.pendingText}</Txt><Txt role="caption" tone="inkSoft" content="user" numberOfLines={1}>{`${r.project} · ${r.source}`}</Txt></View>
            <Icon name="chevronRight" size={16} color={c.inkSoft} />
          </Pressable>)}
        </View> : null}
        {today ? <View testID="now-today" style={{ alignItems: 'flex-end' }}>
          <StatusHint testID="now-today-counts" icon={today.doneCount > 0 ? 'done' : 'clock'} value={today.doneCount > 0 ? today.doneCount : undefined}
            label={`${today.title}: ${today.counts}${today.partial ? `. ${t(lang, 'today.partial')}` : ''}. ${t(lang, 'minimal.history')}`}
            description={`${today.title}\n${today.counts}${today.partial ? `\n${t(lang, 'today.partial')}` : ''}`}>
            {close => <View>
              {today.done.map(r => <LinkRow key={r.key} testID={`now-today-${r.key}`} label={r.title} detail={`${r.sub} · ${r.ago}`} onPress={() => { close(); router.push(r.href) }} />)}
              <LinkRow label={t(lang, 'today.openAll')} onPress={() => { close(); router.push('/together') }} />
            </View>}
          </StatusHint>
          {today.partial ? <Txt testID="now-today-partial" role="caption" tone="inkSoft">{t(lang, 'minimal.partial')}</Txt> : null}
        </View> : null}
        <CompanionCard card={card} onSeen={companion.markSeen} />
      </ScrollView>
      <View style={{ paddingHorizontal: space.xl, paddingBottom: space.m }}><SayBar testID="now-say" placeholder={t(lang, 'now.sayToCC')} onPress={openChat} /></View>
    </SafeAreaView>
  )
}

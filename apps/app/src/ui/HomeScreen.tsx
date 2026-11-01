import { useRouter } from 'expo-router'
import { useEffect, useMemo, useState } from 'react'
import { Pressable, ScrollView, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { t } from '../i18n'
import { useLang } from '../i18n/useLang'
import { useBackendCtx } from '../state/BackendProvider'
import { useConnection, useQuery } from '../state/hooks'
import { useWork } from '../state/useWork'
import { useChatUpdates } from '../state/useChatUpdates'
import { useAllMatterInputs, useInputRecovery } from '../state/useMatterInputs'
import { inputNeedsChecking } from '../state/matter-inputs'
import { useTerminalSessions } from '../state/useTerminal'
import { useAwaySince } from '../state/useAway'
import { useCompanion } from '../state/useCompanion'
import { CCFigure } from './CCFigure'
import { useMotionEnabled } from './motion'
import { makeCCMotionTracker, type CCMotionEvent } from '../view/cc-motion'
import { CompanionCard } from './CompanionCard'
import { ConnectionNotice } from './ConnectionNotice'
import { DemoBanner } from './DemoBanner'
import { IconButton } from './IconButton'
import { LinkRow } from './Rows'
import { SayBar } from './SayBar'
import { StatusHint } from './StatusHint'
import { space } from './tokens'
import { TopBar } from './TopBar'
import { Txt } from './Txt'
import { useTheme } from './useTheme'
import { WorkList } from './WorkList'
import { companionCard, companionStatus } from '../view/companion'
import { formatSynced } from '../view/connection'
import { homeView } from '../view/home'
import { latestCCLine } from '../view/now'
import { ccPresence } from '../view/presence'

// 主页「此刻」(设计稿 2026-10-31 U,主人 11-01 定:此刻与一起做合成一个):
// 最上面 CC(明暗 + 最近一句真话,点它进对话);下面一份列表 等你 → 在做 → 带回来的;「全部 →」进完整历史;底部说一句。
// 交办是右上角 +;保存的输入、电脑上的会话在 … 里。没有标签栏。
export function HomeScreen() {
  const { c } = useTheme()
  const lang = useLang()
  const router = useRouter()
  const conn = useConnection()
  const { backend } = useBackendCtx()
  const { approvals, agents, matters, mattersKnown, mattersLoading, mattersError, refreshMatters, demo } = useWork()
  const known = demo || conn.state === 'online'
  const terminal = useTerminalSessions()
  const away = useAwaySince()
  const now = Date.now()
  const view = homeView({ matters, approvals, agents, terminal: terminal.sessions ?? [], known, now, lang, away })
  const chat = useQuery('chat:latest', () => backend.chat({})) // 与 /chat 同一个键、同一份缓存
  useChatUpdates(chat.data?.matterId, chat.refresh)
  const line = latestCCLine(chat.data)
  const presence = ccPresence(conn, { demo }) // 演示:暗(不是真信号)
  const openChat = () => router.push('/chat')
  // CC 下面一行「在干什么」+ 一张它带回来的东西:都只从电脑上的真信号来,没信号就不出现。
  const companion = useCompanion()
  const statusKey = companionStatus({ known: demo || presence === 'here', activity: companion.activity, running: agents.running })
  const status = statusKey ? t(lang, statusKey) : null
  const card = companion.home ? companionCard(companion.home.events, companion.home.seenUntil, now, companion.localSeen) : null
  const saved = useAllMatterInputs().filter(inputNeedsChecking).length
  const recovery = useInputRecovery()
  const motionEnabled = useMotionEnabled()
  const tracker = useMemo(makeCCMotionTracker, [backend])
  const [motion, setMotion] = useState<CCMotionEvent>()
  const rowsOf = (key: string) => view.groups.find(g => g.key === key)?.rows ?? []
  const snapshot = JSON.stringify({
    active: presence === 'here' && motionEnabled,
    received: chat.data ? (line ? [{ id: line.id, at: line.at }] : []) : undefined,
    done: mattersKnown ? rowsOf('back').map(r => ({ id: `${r.source}:${r.id}`, at: r.updatedAt })) : undefined,
    waiting: view.waitingUnknown ? undefined : rowsOf('waiting').map(r => `${r.source}:${r.id}:${r.pendingRequestId ?? ''}`),
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
        onConnection={() => router.push('/connections')} connectionTestID="now-connections"
        actions={<View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <IconButton name="plus" testID="home-delegate" label={t(lang, 'together.delegate')} onPress={() => router.push('/compose')} />
          <StatusHint testID="home-more" icon="more" value={saved || undefined} label={`${t(lang, 'minimal.more')}${saved ? `, ${t(lang, 'input.savedTitle')} ${saved}` : ''}`} description="">
            {close => <View>
              <LinkRow testID="home-saved-inputs" icon="restore" label={`${t(lang, 'input.savedTitle')}${saved ? ` · ${saved}` : ''}`} detail={recovery.phase !== 'ready' ? t(lang, 'feedback.stale') : undefined} onPress={() => { close(); router.push('/inputs') }} />
              <LinkRow testID="home-sessions" icon="terminal" label={t(lang, 'sessions.title')} onPress={() => { close(); router.push('/sessions') }} />
            </View>}
          </StatusHint>
        </View>} />
      <ScrollView contentContainerStyle={{ paddingHorizontal: space.xl, paddingBottom: space.xl, gap: space.l, flexGrow: 1 }}>
        <ConnectionNotice />
        {demo ? <DemoBanner /> : null}
        <View style={{ alignItems: 'center', paddingTop: space.xl, paddingBottom: space.l, gap: space.m }}>
          <Pressable testID="now-cc" accessibilityRole="button" accessibilityLabel={t(lang, 'now.openChat')} onPress={openChat} style={{ minWidth: 154, minHeight: 154 }}>
            <CCFigure size={154} presence={presence} mood={status ?? undefined} behavior={motion?.behavior} eventKey={motion?.eventKey} />
          </Pressable>
          {line ? <Pressable testID="now-cc-bubble" accessibilityRole="button" accessibilityLabel={`${t(lang, 'now.ccBubble')}: ${line.text}, ${formatSynced(line.at, now, lang)}`} onPress={openChat} style={{ minHeight: 44, justifyContent: 'center', maxWidth: '100%' }}>
            <Txt role="item" content="user" numberOfLines={3} style={{ textAlign: 'center' }}>{line.text}</Txt>
          </Pressable> : null}
        </View>
        <WorkList view={view} prefix="home" known={mattersKnown} loading={mattersLoading} error={mattersError} onRetry={() => void refreshMatters()} emptyText={null} />
        {view.groups.length > 0 || view.moreCount > 0 ? <LinkRow testID="home-all" label={t(lang, 'home.allLink')} onPress={() => router.push('/all')} /> : null}
        <CompanionCard card={card} onSeen={companion.markSeen} />
      </ScrollView>
      <View style={{ paddingHorizontal: space.xl, paddingBottom: space.m }}><SayBar testID="now-say" placeholder={t(lang, 'now.sayToCC')} onPress={openChat} /></View>
    </SafeAreaView>
  )
}

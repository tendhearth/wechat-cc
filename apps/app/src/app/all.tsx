import { useRouter } from 'expo-router'
import { ScrollView, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { t } from '../i18n'
import { useLang } from '../i18n/useLang'
import { useConnection } from '../state/hooks'
import { useTerminalSessions } from '../state/useTerminal'
import { useWork } from '../state/useWork'
import { ConnectionNotice } from '../ui/ConnectionNotice'
import { space } from '../ui/tokens'
import { TopBar } from '../ui/TopBar'
import { useTheme } from '../ui/useTheme'
import { WorkList } from '../ui/WorkList'
import { homeView } from '../view/home'

// 「全部」(设计稿 2026-10-31 U):主页那份列表不限 24 小时 —— 交给 CC 的事和终端会话,等你 / 在做 / 带回来的。
export default function All() {
  const { c } = useTheme()
  const lang = useLang()
  const router = useRouter()
  const conn = useConnection()
  const { approvals, agents, matters, mattersKnown, mattersLoading, mattersError, refreshMatters, demo } = useWork()
  const terminal = useTerminalSessions()
  const view = homeView({ matters, approvals, agents, terminal: terminal.sessions ?? [], known: demo || conn.state === 'online', now: Date.now(), lang, backWindowMs: null, keepStaleWaiting: true })
  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: c.paper }}>
      <TopBar title={t(lang, 'home.all')} onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
      <ScrollView contentContainerStyle={{ paddingHorizontal: space.xl, paddingBottom: space.xl, flexGrow: 1 }}>
        <View><ConnectionNotice /></View>
        <WorkList view={view} prefix="all" known={mattersKnown} loading={mattersLoading} error={mattersError} onRetry={() => void refreshMatters()} emptyText={t(lang, 'together.empty')} />
      </ScrollView>
    </SafeAreaView>
  )
}

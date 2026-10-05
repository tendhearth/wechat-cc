import { Redirect } from 'expo-router'
import { Tabs } from 'expo-router/js-tabs'
import { t } from '../../i18n'
import { useLang } from '../../i18n/useLang'
import type { ApprovalItemT } from '../../backend/types'
import { useBackendCtx } from '../../state/BackendProvider'
import { useConnection, useTopic } from '../../state/hooks'
import { useSession } from '../../state/session'
import { TabBar } from '../../ui/TabBar'
import { waitingCount } from '../../view/now'

export default function TabsLayout() {
  const lang = useLang()
  const { seenWelcome } = useSession()
  const { backend } = useBackendCtx()
  const conn = useConnection()
  const approvals = useTopic<ApprovalItemT[]>('approvals')
  // 「此刻」旁边写几件事等你(2026-10-05,和桌面主导航一样):在「一起做」也看得到,不用另起横幅。
  // 够不着电脑时这份是旧的 ⇒ 不写数(此刻页会说「暂时不知道」)。
  const known = backend.mode === 'demo' || conn.state === 'online'
  const waiting = waitingCount(approvals ?? [], known)
  // 首次打开(本次运行还没看过欢迎页)⇒ 先去欢迎页。标记只存内存,下一份计划落盘。
  if (!seenWelcome) return <Redirect href="/welcome" />
  return (
    <Tabs tabBar={(p) => <TabBar {...p} />} screenOptions={{ headerShown: false }}>
      <Tabs.Screen name="index" options={{ title: t(lang, 'tabs.now'), tabBarButtonTestID: 'tab-now', tabBarBadge: waiting || undefined }} />
      <Tabs.Screen name="together" options={{ title: t(lang, 'tabs.together'), tabBarButtonTestID: 'tab-together' }} />
    </Tabs>
  )
}

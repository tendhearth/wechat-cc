import { Redirect } from 'expo-router'
import { Tabs } from 'expo-router/js-tabs'
import { t } from '../../i18n'
import { useLang } from '../../i18n/useLang'
import { useSession } from '../../state/session'
import { TabBar } from '../../ui/TabBar'

export default function TabsLayout() {
  const lang = useLang()
  const { seenWelcome } = useSession()
  // 首次打开(本次运行还没看过欢迎页)⇒ 先去欢迎页。标记只存内存,下一份计划落盘。
  if (!seenWelcome) return <Redirect href="/welcome" />
  return (
    <Tabs tabBar={(p) => <TabBar {...p} />} screenOptions={{ headerShown: false }}>
      <Tabs.Screen name="index" options={{ title: t(lang, 'tabs.now'), tabBarButtonTestID: 'tab-now' }} />
      <Tabs.Screen name="together" options={{ title: t(lang, 'tabs.together'), tabBarButtonTestID: 'tab-together' }} />
    </Tabs>
  )
}

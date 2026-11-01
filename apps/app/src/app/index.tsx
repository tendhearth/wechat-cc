import { Redirect } from 'expo-router'
import { useSession } from '../state/session'
import { HomeScreen } from '../ui/HomeScreen'

// 主页「此刻」(设计稿 2026-10-31 U)。首次打开(本次运行还没看过欢迎页)⇒ 先去欢迎页;标记只存内存。
export default function Index() {
  const { seenWelcome } = useSession()
  if (!seenWelcome) return <Redirect href="/welcome" />
  return <HomeScreen />
}

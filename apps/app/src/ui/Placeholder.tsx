import { useRouter } from 'expo-router'
import { Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { t } from '../i18n'
import { useLang } from '../i18n/useLang'
import { useConnection } from '../state/hooks'
import { space } from './tokens'
import { TopBar } from './TopBar'
import { useTheme } from './useTheme'

// 还没做的页面先占个位(标题 + 返回),让路由能打包、能点进去;后续任务替换。
export function Placeholder({ title }: { title: string }) {
  const { c } = useTheme()
  const lang = useLang()
  const router = useRouter()
  const conn = useConnection()
  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: c.bg }}>
      <TopBar
        onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))}
        onAvatar={() => router.push('/settings')}
      />
      <View style={{ padding: space.xl, gap: space.m }}>
        <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 28 }}>{title}</Text>
        <Text style={{ color: c.muted, fontSize: 15 }}>{t(lang, 'common.comingSoon')}</Text>
      </View>
    </SafeAreaView>
  )
}

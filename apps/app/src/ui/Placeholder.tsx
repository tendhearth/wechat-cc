import { useRouter } from 'expo-router'
import { View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { t } from '../i18n'
import { useLang } from '../i18n/useLang'
import { space } from './tokens'
import { TopBar } from './TopBar'
import { Txt } from './Txt'
import { useTheme } from './useTheme'

// 还没做的页面先占个位(标题 + 返回),让路由能打包、能点进去;后续任务替换。
export function Placeholder({ title }: { title: string }) {
  const { c } = useTheme()
  const lang = useLang()
  const router = useRouter()
  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: c.paper }}>
      <TopBar
        onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))}
        onAvatar={() => router.push('/settings')}
      />
      <View style={{ padding: space.xl, gap: space.m }}>
        <Txt role="display" accessibilityRole="header">{title}</Txt>
        <Txt role="bubble" tone="inkSoft">{t(lang, 'common.comingSoon')}</Txt>
      </View>
    </SafeAreaView>
  )
}

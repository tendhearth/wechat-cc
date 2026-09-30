import { useRouter } from 'expo-router'
import { ScrollView, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { t } from '../i18n'
import { useLang } from '../i18n/useLang'
import { useConnection } from '../state/hooks'
import { Card } from '../ui/Card'
import { CCFigure } from '../ui/CCFigure'
import { serifFamily } from '../ui/fonts'
import { space } from '../ui/tokens'
import { TopBar } from '../ui/TopBar'
import { useTheme } from '../ui/useTheme'

// 配对说明:三步图文。真正的扫码配对在下一份计划。
export default function Pair() {
  const { c } = useTheme()
  const lang = useLang()
  const router = useRouter()
  const conn = useConnection()
  const steps = ['pair.step1', 'pair.step2', 'pair.step3'] as const
  return (
    <SafeAreaView edges={['top', 'bottom']} style={{ flex: 1, backgroundColor: c.bg }}>
      <TopBar onBack={() => (router.canGoBack() ? router.back() : router.replace('/welcome'))} connection={conn.state === 'online' ? 'online' : 'offline'} showConnection={false} onAvatar={() => router.push('/settings')} />
      <ScrollView contentContainerStyle={{ padding: space.xl, gap: space.l, alignItems: 'stretch' }}>
        <View style={{ alignItems: 'center' }}><CCFigure size={120} /></View>
        <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 28, lineHeight: 36, fontFamily: serifFamily }}>{t(lang, 'pair.title')}</Text>
        <View testID="pair-steps" style={{ gap: space.m }}>
          {steps.map((k, i) => (
            <Card key={k} style={{ flexDirection: 'row', alignItems: 'center', gap: space.m }}>
              <View style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: c.navOnBg, alignItems: 'center', justifyContent: 'center' }}>
                <Text style={{ color: c.navOnInk, fontWeight: '700' }}>{i + 1}</Text>
              </View>
              <Text style={{ flex: 1, color: c.ink, fontSize: 16, lineHeight: 22 }}>{t(lang, k)}</Text>
            </Card>
          ))}
        </View>
        <Text testID="pair-coming-soon" style={{ color: c.muted, fontSize: 14, textAlign: 'center' }}>{t(lang, 'pair.comingSoon')}</Text>
      </ScrollView>
    </SafeAreaView>
  )
}

import { useRouter } from 'expo-router'
import { View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { t } from '../i18n'
import { useLang } from '../i18n/useLang'
import { useConnection } from '../state/hooks'
import { useSession } from '../state/session'
import { Button } from '../ui/Button'
import { CCFigure } from '../ui/CCFigure'
import { space } from '../ui/tokens'
import { Txt } from '../ui/Txt'
import { useTheme } from '../ui/useTheme'
import { ccPresence } from '../view/presence'

// 首次打开:CC + 一句话 + 两个选择。「先看看」进演示模式(横幅由「此刻」页按 backend.mode 显示)。
export default function Welcome() {
  const { c } = useTheme()
  const lang = useLang()
  const router = useRouter()
  const conn = useConnection()
  const { markWelcomeSeen, staleNotice } = useSession()
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: c.paper }}>
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: space.xl, gap: space.l }}>
        <CCFigure size={160} presence={ccPresence(conn)} />
        <Txt role="display" accessibilityRole="header" style={{ textAlign: 'center' }}>{t(lang, 'welcome.title')}</Txt>
        <Txt role="body" tone="inkSoft" style={{ textAlign: 'center' }}>{t(lang, 'welcome.body')}</Txt>
        {staleNotice ? <Txt testID="welcome-stale" role="body" tone="inkSoft" style={{ textAlign: 'center' }}>{t(lang, 'welcome.stale')}</Txt> : null}
      </View>
      <View style={{ paddingHorizontal: space.xl, paddingBottom: space.xl, gap: space.m }}>
        <Txt testID="welcome-how-to" role="meta" tone="inkSoft" style={{ textAlign: 'center' }}>{t(lang, 'welcome.howTo')}</Txt>
        <Button kind="primary" testID="welcome-pair" label={t(lang, 'welcome.pair')} onPress={() => router.push('/pair')} />
        <Button
          kind="secondary"
          testID="welcome-look-first"
          label={t(lang, 'welcome.lookFirst')}
          onPress={() => {
            markWelcomeSeen()
            router.replace('/')
          }}
        />
      </View>
    </SafeAreaView>
  )
}

import { useRouter } from 'expo-router'
import { Pressable, ScrollView, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { t } from '../i18n'
import { useLang } from '../i18n/useLang'
import { secondaryText as st } from '../i18n/minimal-secondary'
import { useBackendCtx } from '../state/BackendProvider'
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
  const demo = useBackendCtx().backend.mode === 'demo'
  const { markWelcomeSeen, staleNotice } = useSession()
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: c.paper }}>
      <ScrollView testID="welcome-scroll" contentContainerStyle={{ flexGrow: 1 }}>
      <View style={{ flexGrow: 1, paddingVertical: space.xl, justifyContent: 'center', alignItems: 'center', paddingHorizontal: space.xl, gap: space.l }}>
        <CCFigure size={144} presence={ccPresence(conn, { demo })} />
        <Txt role="display" accessibilityRole="header" style={{ textAlign: 'center' }}>{st(lang, 'welcome')}</Txt>
        <Txt role="body" tone="inkSoft" style={{ textAlign: 'center' }}>{st(lang, 'welcomeBody')}</Txt>
        {staleNotice ? <Txt testID="welcome-stale" role="body" tone="inkSoft" style={{ textAlign: 'center' }}>{t(lang, 'welcome.stale')}</Txt> : null}
      </View>
      <View style={{ paddingHorizontal: space.xl, paddingBottom: space.xl, gap: space.m }}>
        <Txt testID="welcome-how-to" role="meta" tone="inkSoft" style={{ textAlign: 'center' }}>{t(lang, 'welcome.howTo')}</Txt>
        <Button kind="primary" testID="welcome-pair" label={t(lang, 'welcome.pair')} onPress={() => router.push('/pair')} />
        <Pressable testID="welcome-look-first" accessibilityRole="button" accessibilityLabel={t(lang, 'welcome.lookFirst')} style={{ minHeight: 44, alignItems: 'center', justifyContent: 'center' }}
          onPress={() => { markWelcomeSeen(); router.replace('/') }}>
          <Txt role="body" tone="inkSoft">{t(lang, 'welcome.lookFirst')}</Txt>
        </Pressable>
      </View>
      </ScrollView>
    </SafeAreaView>
  )
}

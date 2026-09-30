import Constants from 'expo-constants'
import { useRouter } from 'expo-router'
import { Pressable, ScrollView, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import type { Lang } from '../i18n'
import { t } from '../i18n'
import { useLang } from '../i18n/useLang'
import { useBackendCtx } from '../state/BackendProvider'
import { useConnection } from '../state/hooks'
import { useSession } from '../state/session'
import { Button } from '../ui/Button'
import { Card } from '../ui/Card'
import { serifFamily } from '../ui/fonts'
import { radius, space } from '../ui/tokens'
import { TopBar } from '../ui/TopBar'
import { useTheme } from '../ui/useTheme'

export default function Settings() {
  const { c } = useTheme()
  const lang = useLang()
  const router = useRouter()
  const conn = useConnection()
  const { backend, resetDemo } = useBackendCtx()
  const { langOverride, setLangOverride, setSeenWelcome } = useSession()
  const demo = backend.mode === 'demo'
  const choices: Array<{ v: Lang | null; label: string; id: string }> = [
    { v: null, label: t(lang, 'settings.languageSystem'), id: 'system' },
    { v: 'en', label: t(lang, 'settings.languageEn'), id: 'en' },
    { v: 'zh-Hans', label: t(lang, 'settings.languageZh'), id: 'zh-Hans' },
  ]
  const heading = (k: Parameters<typeof t>[1]) => <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 18, fontFamily: serifFamily }}>{t(lang, k)}</Text>
  return (
    <SafeAreaView edges={['top', 'bottom']} style={{ flex: 1, backgroundColor: c.bg }}>
      <TopBar title={t(lang, 'settings.title')} onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))} connection={conn.state === 'online' ? 'online' : 'offline'} />
      <ScrollView contentContainerStyle={{ padding: space.xl, gap: space.l }}>
        {heading('settings.language')}
        <View testID="settings-language" accessibilityRole="radiogroup" style={{ gap: space.xs }}>
          {choices.map((o) => {
            const on = langOverride === o.v
            return (
              <Pressable
                key={o.id}
                testID={`settings-language-${o.id}`}
                accessibilityRole="radio"
                accessibilityState={{ selected: on }}
                accessibilityLabel={o.label}
                onPress={() => setLangOverride(o.v)}
                style={{ minHeight: 48, paddingHorizontal: space.l, borderRadius: radius.pill, justifyContent: 'center', backgroundColor: on ? c.navOnBg : 'transparent' }}
              >
                <Text style={{ color: on ? c.navOnInk : c.ink, fontSize: 16 }}>{o.label}</Text>
              </Pressable>
            )
          })}
        </View>
        {demo ? (
          <>
            {heading('settings.demo')}
            <Card style={{ gap: space.m }}>
              <Text style={{ color: c.muted, fontSize: 14, lineHeight: 21 }}>{t(lang, 'settings.demoBody')}</Text>
              <Button
                kind="secondary"
                testID="settings-exit-demo"
                label={t(lang, 'settings.exitDemo')}
                onPress={() => { resetDemo(); setSeenWelcome(false); router.dismissAll?.(); router.replace('/welcome') }}
              />
            </Card>
          </>
        ) : null}
        {heading('settings.privacy')}
        <Card testID="settings-privacy"><Text style={{ color: c.ink, fontSize: 15, lineHeight: 23 }}>{t(lang, 'settings.privacyBody')}</Text></Card>
        {heading('settings.about')}
        <Text style={{ color: c.muted, fontSize: 14 }}>{t(lang, 'settings.version')} {Constants.expoConfig?.version ?? '1.0.0'} · {t(lang, 'settings.company')}</Text>
      </ScrollView>
    </SafeAreaView>
  )
}

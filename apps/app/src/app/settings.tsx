import Constants from 'expo-constants'
import { useRouter } from 'expo-router'
import { useRef, useState } from 'react'
import { Alert, Pressable, ScrollView, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import type { Lang } from '../i18n'
import { t } from '../i18n'
import { useLang } from '../i18n/useLang'
import { usePush } from '../push/PushProvider'
import { useBackendCtx } from '../state/BackendProvider'
import { useConnection } from '../state/hooks'
import { useSession } from '../state/session'
import { Button } from '../ui/Button'
import { Card } from '../ui/Card'
import { radius, space } from '../ui/tokens'
import { TopBar } from '../ui/TopBar'
import { useTheme } from '../ui/useTheme'
import { notificationNoticeKey } from '../view/notifications'
import { unpairNotice } from '../view/unpair'

export default function Settings() {
  const { c } = useTheme()
  const lang = useLang()
  const router = useRouter()
  const conn = useConnection()
  const { backend, resetDemo } = useBackendCtx()
  const { langOverride, setLangOverride, setSeenWelcome, forgetPairing } = useSession()
  const [unpairing, setUnpairing] = useState(false)
  const push = usePush()
  const [testing, setTesting] = useState(false)
  const testingRef = useRef(false)
  const unpairingRef = useRef(false)
  const demo = backend.mode === 'demo'
  const choices: Array<{ v: Lang | null; label: string; id: string }> = [
    { v: null, label: t(lang, 'settings.languageSystem'), id: 'system' },
    { v: 'en', label: t(lang, 'settings.languageEn'), id: 'en' },
    { v: 'zh-Hans', label: t(lang, 'settings.languageZh'), id: 'zh-Hans' },
  ]
  const unpair = async () => {
    if (unpairingRef.current) return
    unpairingRef.current = true
    setUnpairing(true)
    let err: unknown = null
    try { await backend.unpair() } catch (e) { err = e } // 撤销后 / 离线时 daemon 那边做不了,本机照样清
    try {
      await forgetPairing()
    } catch {
      Alert.alert(t(lang, 'settings.unpairFailed'))
      unpairingRef.current = false
      setUnpairing(false)
      return
    }
    const n = unpairNotice(err)
    if (n === 'computerStillLists') Alert.alert(t(lang, 'settings.unpairLocalOnly'))
    else if (n === 'neutral') Alert.alert(t(lang, 'settings.unpairNeutral'))
    router.dismissAll?.()
    router.replace('/welcome')
  }
  const sendTest = async () => {
    if (testingRef.current) return // 同一帧里连点两下:state 还没更新,靠 ref 拦
    testingRef.current = true
    setTesting(true)
    try {
      const r = await push.sendTest()
      Alert.alert(r.ok ? t(lang, 'settings.notifTestSent') : t(lang, 'settings.notifTestFailed', { code: r.code }))
    } catch (e) {
      // 只显示错误码(BackendError.code),不显示错误文本
      const code = typeof e === 'object' && e !== null && typeof (e as { code?: unknown }).code === 'string' ? (e as { code: string }).code : 'unknown'
      Alert.alert(t(lang, 'settings.notifTestFailed', { code }))
    } finally { testingRef.current = false; setTesting(false) }
  }
  const confirmUnpair = () =>
    Alert.alert(t(lang, 'settings.unpairConfirmTitle'), t(lang, 'settings.unpairConfirmBody'), [
      { text: t(lang, 'common.cancel'), style: 'cancel' },
      { text: t(lang, 'settings.unpair'), style: 'destructive', onPress: () => void unpair() },
    ])
  const heading = (k: Parameters<typeof t>[1]) => <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 18 }}>{t(lang, k)}</Text>
  return (
    <SafeAreaView edges={['top', 'bottom']} style={{ flex: 1, backgroundColor: c.bg }}>
      <TopBar title={t(lang, 'settings.title')} onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
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
                accessibilityState={{ checked: on }}
                accessibilityLabel={o.label}
                onPress={() => setLangOverride(o.v)}
                style={{ minHeight: 48, paddingHorizontal: space.l, borderRadius: radius.pill, justifyContent: 'center', backgroundColor: on ? c.navOnBg : 'transparent' }}
              >
                <Text style={{ color: on ? c.navOnInk : c.ink, fontSize: 16 }}>{o.label}</Text>
              </Pressable>
            )
          })}
        </View>
        {!demo && conn.state !== 'revoked' ? (
          <>
            {heading('settings.notifications')}
            <Card testID="settings-notifications" style={{ gap: space.m }}>
              <Text testID={`settings-notif-${push.status}`} style={{ color: c.muted, fontSize: 14, lineHeight: 21 }}>{t(lang, notificationNoticeKey(push.status))}</Text>
              {push.status === 'denied' ? (
                <Button kind="secondary" testID="settings-notif-open" label={t(lang, 'settings.notifOpenSettings')} onPress={push.openSettings} />
              ) : null}
              {push.status === 'registered' ? (
                <Button kind="secondary" testID="settings-notif-test" label={t(lang, 'settings.notifTest')} busy={testing} disabled={testing} onPress={sendTest} />
              ) : null}
            </Card>
          </>
        ) : null}
        {demo || conn.state !== 'revoked' ? (
          <Card style={{ gap: space.m }}>
            <Button kind="secondary" testID="settings-connections" label={t(lang, 'settings.connections')} onPress={() => router.push('/connections')} />
            <Button kind="secondary" testID="settings-sessions" label={t(lang, 'settings.sessions')} onPress={() => router.push('/sessions')} />
          </Card>
        ) : null}
        {!demo ? (
          <>
            {heading('settings.thisPhone')}
            <Card style={{ gap: space.m }}>
              <Button kind="secondary" testID="settings-devices" label={t(lang, 'settings.devices')} onPress={() => router.push('/devices')} />
              <Button kind="secondary" testID="settings-unpair" label={t(lang, 'settings.unpair')} busy={unpairing} onPress={confirmUnpair} />
            </Card>
          </>
        ) : null}
        {demo ? (
          <>
            {heading('settings.demo')}
            <Card style={{ gap: space.m }}>
              <Text style={{ color: c.muted, fontSize: 14, lineHeight: 21 }}>{t(lang, 'settings.demoBody')}</Text>
              <Button kind="primary" testID="settings-pair-now" label={t(lang, 'settings.pairNow')} onPress={() => { resetDemo(); router.push('/pair') }} />
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
        <Text style={{ color: c.muted, fontSize: 14 }}>{t(lang, 'settings.version')} {Constants.expoConfig?.version ?? '—'} · {t(lang, 'settings.copyright')}</Text>
      </ScrollView>
    </SafeAreaView>
  )
}

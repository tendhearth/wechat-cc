import Constants from 'expo-constants'
import { useRouter } from 'expo-router'
import { useRef, useState } from 'react'
import { Alert, ScrollView, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import type { Lang } from '../i18n'
import { t } from '../i18n'
import { useLang } from '../i18n/useLang'
import { usePush } from '../push/PushProvider'
import { useBackendCtx } from '../state/BackendProvider'
import { useConnection } from '../state/hooks'
import { useSession } from '../state/session'
import { Button } from '../ui/Button'
import { ChoiceRow, LinkRow } from '../ui/Rows'
import { space } from '../ui/tokens'
import { TopBar } from '../ui/TopBar'
import { Txt } from '../ui/Txt'
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
  // 分组靠留白与 meta 小标题,不套卡;进下一页的是带 › 的行,真正的动作才是按钮。
  const heading = (k: Parameters<typeof t>[1]) => <Txt role="meta" tone="inkSoft" accessibilityRole="header" style={{ marginTop: space.l, marginBottom: space.xs }}>{t(lang, k)}</Txt>
  return (
    <SafeAreaView edges={['top', 'bottom']} style={{ flex: 1, backgroundColor: c.paper }}>
      <TopBar title={t(lang, 'settings.title')} onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
      <ScrollView contentContainerStyle={{ paddingHorizontal: space.xl, paddingBottom: space.xxl }}>
        {heading('settings.language')}
        <View testID="settings-language" accessibilityRole="radiogroup" style={{ borderTopWidth: 1, borderTopColor: c.hair }}>
          {choices.map((o) => (
            <ChoiceRow key={o.id} testID={`settings-language-${o.id}`} label={o.label} on={langOverride === o.v} onPress={() => setLangOverride(o.v)} />
          ))}
        </View>
        {!demo && conn.state !== 'revoked' ? (
          <>
            {heading('settings.notifications')}
            <View testID="settings-notifications" style={{ gap: space.m }}>
              <Txt testID={`settings-notif-${push.status}`} role="meta" tone="inkSoft">{t(lang, notificationNoticeKey(push.status))}</Txt>
              {push.status === 'denied' ? (
                <Button kind="secondary" testID="settings-notif-open" label={t(lang, 'settings.notifOpenSettings')} onPress={push.openSettings} />
              ) : null}
              {push.status === 'registered' ? (
                <Button kind="secondary" testID="settings-notif-test" label={t(lang, 'settings.notifTest')} busy={testing} disabled={testing} onPress={sendTest} />
              ) : null}
            </View>
          </>
        ) : null}
        {demo || conn.state !== 'revoked' ? (
          <View style={{ marginTop: space.xl, borderTopWidth: 1, borderTopColor: c.hair }}>
            <LinkRow testID="settings-connections" label={t(lang, 'settings.connections')} onPress={() => router.push('/connections')} />
            <LinkRow testID="settings-sessions" label={t(lang, 'settings.sessions')} onPress={() => router.push('/sessions')} />
          </View>
        ) : null}
        {!demo ? (
          <>
            {heading('settings.thisPhone')}
            <View style={{ borderTopWidth: 1, borderTopColor: c.hair }}>
              <LinkRow testID="settings-devices" label={t(lang, 'settings.devices')} onPress={() => router.push('/devices')} />
            </View>
            <View style={{ marginTop: space.l }}>
              <Button kind="secondary" testID="settings-unpair" label={t(lang, 'settings.unpair')} busy={unpairing} onPress={confirmUnpair} />
            </View>
          </>
        ) : null}
        {demo ? (
          <>
            {heading('settings.demo')}
            <View style={{ gap: space.m }}>
              <Txt role="meta" tone="inkSoft">{t(lang, 'settings.demoBody')}</Txt>
              <Button kind="primary" testID="settings-pair-now" label={t(lang, 'settings.pairNow')} onPress={() => { resetDemo(); router.push('/pair') }} />
              <Button
                kind="secondary"
                testID="settings-exit-demo"
                label={t(lang, 'settings.exitDemo')}
                onPress={() => { resetDemo(); setSeenWelcome(false); router.dismissAll?.(); router.replace('/welcome') }}
              />
            </View>
          </>
        ) : null}
        {heading('settings.privacy')}
        <Txt testID="settings-privacy" role="bubble">{t(lang, 'settings.privacyBody')}</Txt>
        {heading('settings.about')}
        <View style={{ borderTopWidth: 1, borderTopColor: c.hair }}>
          <LinkRow testID="settings-font-licences" label={t(lang, 'settings.fontLicences')} onPress={() => router.push('/licences')} />
        </View>
        <Txt role="small" tone="inkSoft" style={{ marginTop: space.m }}>{t(lang, 'settings.version')} {Constants.expoConfig?.version ?? '—'} · {t(lang, 'settings.copyright')}</Txt>
      </ScrollView>
    </SafeAreaView>
  )
}

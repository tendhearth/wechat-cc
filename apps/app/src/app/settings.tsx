import Constants from 'expo-constants'
import { useRouter } from 'expo-router'
import { useRef, useState } from 'react'
import { Alert, Pressable, ScrollView, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import type { Lang } from '../i18n'
import { t } from '../i18n'
import { useLang } from '../i18n/useLang'
import { secondaryText as st } from '../i18n/minimal-secondary'
import { usePush } from '../push/PushProvider'
import { useBackendCtx } from '../state/BackendProvider'
import { useConnection } from '../state/hooks'
import { useSession } from '../state/session'
import { Icon, type IconName } from '../ui/Icon'
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
  const [panel, setPanel] = useState<'language' | 'notifications' | 'privacy' | 'about' | null>(null)
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
  const showNotif = !demo && conn.state !== 'revoked'
  const heading = (label: string) => <Txt role="meta" tone="inkSoft" accessibilityRole="header" style={{ marginTop: space.l, marginBottom: space.s }}>{label}</Txt>
  const disclosure = (value: Exclude<typeof panel, null>, label: string, icon: IconName, detail?: string) => <Pressable testID={`settings-${value}-toggle`} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ expanded: panel === value }}
    onPress={() => setPanel(panel === value ? null : value)} style={{ minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: space.m }}>
    <Icon name={icon} size={20} />
    <Txt role="body" style={{ flex: 1 }}>{label}</Txt>
    {detail ? <Txt role="small" tone="inkSoft">{detail}</Txt> : null}
    <Icon name={panel === value ? 'chevronDown' : 'chevronRight'} size={16} />
  </Pressable>
  return (
    <SafeAreaView edges={['top', 'bottom']} style={{ flex: 1, backgroundColor: c.paper }}>
      <TopBar title={t(lang, 'settings.title')} onBack={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
      <ScrollView contentContainerStyle={{ paddingHorizontal: space.xl, paddingBottom: space.xxl }}>
        {demo || conn.state !== 'revoked' ? <>
          {heading(st(lang, 'withCC'))}
          <LinkRow icon="book" testID="settings-memory" label={st(lang, 'memory')} onPress={() => router.push('/memory')} />
          <LinkRow icon="mail" testID="settings-letters" label={t(lang, 'letters.title')} onPress={() => router.push('/letters')} />
          <LinkRow icon="calendar" testID="settings-jobs" label={st(lang, 'jobs')} onPress={() => router.push('/jobs')} />
          <LinkRow icon="clock" testID="settings-activity" label={st(lang, 'activity')} onPress={() => router.push('/activity')} />
          {heading(st(lang, 'computer'))}
          <LinkRow icon="monitor" testID="settings-connections" label={st(lang, 'connections')} onPress={() => router.push('/connections')} />
          <LinkRow icon="terminal" testID="settings-sessions" label={st(lang, 'sessions')} onPress={() => router.push('/sessions')} />
        </> : null}
        {!demo ? <LinkRow icon="device" testID="settings-devices" label={st(lang, 'devices')} onPress={() => router.push('/devices')} /> : null}
        {heading(st(lang, 'preferences'))}
        {disclosure('language', t(lang, 'settings.language'), 'book', choices.find(choice => choice.v === langOverride)?.label)}
        {panel === 'language' ? <View testID="settings-language" accessibilityRole="radiogroup" style={{ paddingLeft: space.xl }}>
          {choices.map(o => <ChoiceRow key={o.id} testID={`settings-language-${o.id}`} label={o.label} on={langOverride === o.v} onPress={() => setLangOverride(o.v)} />)}
        </View> : null}
        {showNotif ? <>
          {disclosure('notifications', t(lang, 'settings.notifications'), 'info')}
          {panel === 'notifications' ? <View testID="settings-notifications" style={{ gap: space.m, paddingVertical: space.s }}>
            <Txt testID={`settings-notif-${push.status}`} role="meta" tone="inkSoft">{t(lang, notificationNoticeKey(push.status))}</Txt>
            {push.status === 'denied' ? <Button kind="secondary" testID="settings-notif-open" label={t(lang, 'settings.notifOpenSettings')} onPress={push.openSettings} /> : null}
            {push.status === 'registered' ? <Button kind="secondary" testID="settings-notif-test" label={t(lang, 'settings.notifTest')} busy={testing} disabled={testing} onPress={sendTest} /> : null}
          </View> : null}
        </> : null}
        {disclosure('privacy', t(lang, 'settings.privacy'), 'shield')}
        {panel === 'privacy' ? <Txt testID="settings-privacy" role="bubble" style={{ paddingVertical: space.m }}>{t(lang, 'settings.privacyBody')}</Txt> : null}
        {disclosure('about', st(lang, 'about'), 'info')}
        {panel === 'about' ? <View testID="settings-about" style={{ gap: space.m, paddingVertical: space.s }}>
          <LinkRow testID="settings-font-licences" label={st(lang, 'licences')} onPress={() => router.push('/licences')} />
          <Txt role="small" tone="inkSoft">{t(lang, 'settings.version')} {Constants.expoConfig?.version ?? '—'} · {t(lang, 'settings.copyright')}</Txt>
        </View> : null}
        {!demo ? <View style={{ marginTop: space.xl }}>
          <Button kind="secondary" testID="settings-unpair" label={t(lang, 'settings.unpair')} busy={unpairing} onPress={confirmUnpair} />
        </View> : null}
        {demo ? <>
          {heading(t(lang, 'settings.demo'))}
          <View style={{ gap: space.m }}>
            <Txt role="meta" tone="inkSoft">{t(lang, 'settings.demoBody')}</Txt>
            <Button kind="primary" testID="settings-pair-now" label={t(lang, 'settings.pairNow')} onPress={() => { resetDemo(); router.push('/pair') }} />
            <Button kind="secondary" testID="settings-exit-demo" label={t(lang, 'settings.exitDemo')} onPress={() => { resetDemo(); setSeenWelcome(false); router.dismissAll?.(); router.replace('/welcome') }} />
          </View>
        </> : null}
        <Txt role="small" tone="inkSoft" style={{ marginTop: space.xl }}>{st(lang, 'family')}</Txt>
      </ScrollView>
    </SafeAreaView>
  )
}

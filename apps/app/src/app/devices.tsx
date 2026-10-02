import { useRouter } from 'expo-router'
import { useEffect, useState } from 'react'
import { Pressable, ScrollView, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { t } from '../i18n'
import { useLang } from '../i18n/useLang'
import { useBackendCtx } from '../state/BackendProvider'
import { useConnection, useQuery, useSubmit } from '../state/hooks'
import { Button } from '../ui/Button'
import { ConnectionNotice } from '../ui/ConnectionNotice'
import { TextField } from '../ui/TextField'
import { radius, space } from '../ui/tokens'
import { TopBar } from '../ui/TopBar'
import { Txt } from '../ui/Txt'
import { useTheme } from '../ui/useTheme'
import { devicesView } from '../view/devices'

// 设备管理(spec §6):本机改名;别的设备只能在家里的电脑上移除(LAN_ONLY_OPS),这里只给提示。
export default function Devices() {
  const { c } = useTheme()
  const lang = useLang()
  const router = useRouter()
  const conn = useConnection()
  const submit = useSubmit()
  const { backend } = useBackendCtx()
  const q = useQuery('devices', () => backend.devices(), { refreshOnMount: true })
  const v = q.data ? devicesView(q.data, Date.now(), lang) : null
  const [name, setName] = useState<string | null>(null)
  const [msg, setMsg] = useState<null | 'saved' | 'failed'>(null)
  const [busy, setBusy] = useState(false)
  const [hint, setHint] = useState<string | null>(null)
  useEffect(() => { if (name === null && v?.me) setName(v.me.label) }, [name, v?.me])
  const online = conn.state === 'online'
  const save = async () => {
    const label = (name ?? '').trim()
    if (!label || busy || !online) return
    setBusy(true); setMsg(null)
    const r = await submit('device:rename', () => backend.renameDevice(label))
    setBusy(false)
    setMsg(r === 'ok' ? 'saved' : 'failed')
    if (r === 'ok') void q.refresh()
  }
  return (
    <SafeAreaView edges={['top', 'bottom']} style={{ flex: 1, backgroundColor: c.paper }}>
      <TopBar title={t(lang, 'devices.title')} onBack={() => (router.canGoBack() ? router.back() : router.replace('/settings'))} />
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: space.xl, gap: space.l }}>
        <ConnectionNotice />
        {!v ? (
          q.error ? (
            <Pressable testID="devices-load-failed" accessibilityRole="button" onPress={() => void q.refresh()}>
              <Txt role="bubble" tone="bad">{t(lang, 'devices.loadFailed')}</Txt>
            </Pressable>
          ) : <Txt role="bubble" tone="inkSoft">{t(lang, 'progress.loading')}</Txt>
        ) : (
          <View testID="devices-list" style={{ gap: space.l }}>
            <Txt role="meta" tone="inkSoft" accessibilityRole="header">{t(lang, 'devices.thisPhone')}</Txt>
            <View style={{ gap: space.s }}>
              <Txt role="small" tone="inkSoft">{t(lang, 'devices.nameLabel')}</Txt>
              <TextField
                testID="devices-name-input"
                value={name ?? ''}
                onChangeText={x => { setName(x); setMsg(null) }}
                maxLength={24}
                style={{ minHeight: 48, borderWidth: 1, borderColor: c.hair, borderRadius: radius.control, paddingHorizontal: space.l, backgroundColor: c.paper }}
              />
              <Button kind="primary" testID="devices-save" label={t(lang, 'devices.save')} busy={busy} disabled={!online || !(name ?? '').trim()} onPress={() => void save()} />
              {msg ? <Txt role="meta" tone={msg === 'saved' ? 'inkSoft' : 'bad'} accessibilityLiveRegion="polite">{t(lang, msg === 'saved' ? 'devices.saved' : 'devices.saveFailed')}</Txt> : null}
            </View>
            {v.others.length > 0 ? (
              <>
                <Txt role="meta" tone="inkSoft" accessibilityRole="header" style={{ marginTop: space.m }}>{t(lang, 'devices.others')}</Txt>
                <View style={{ borderTopWidth: 1, borderTopColor: c.hair }}>
                  {v.others.map(o => (
                    <Pressable key={o.id} testID={`devices-other-${o.id}`} accessibilityRole="button" accessibilityLabel={o.label} onPress={() => setHint(o.id)}
                      style={{ gap: 2, paddingVertical: space.m, borderBottomWidth: 1, borderBottomColor: c.hair }}>
                      <Txt role="body" content="user">{o.label}</Txt>
                      {o.lastSeen ? <Txt role="small" tone="inkSoft">{o.lastSeen}</Txt> : null}
                      {hint === o.id ? <Txt testID="devices-other-hint" role="meta" tone="inkSoft" accessibilityLiveRegion="polite" style={{ marginTop: space.xs }}>{t(lang, 'devices.otherHint')}</Txt> : null}
                    </Pressable>
                  ))}
                </View>
              </>
            ) : null}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  )
}

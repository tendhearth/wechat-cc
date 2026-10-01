import { useRouter } from 'expo-router'
import { useEffect, useState } from 'react'
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { t } from '../i18n'
import { useLang } from '../i18n/useLang'
import { useBackendCtx } from '../state/BackendProvider'
import { useConnection, useQuery, useSubmit } from '../state/hooks'
import { Button } from '../ui/Button'
import { Card } from '../ui/Card'
import { ConnectionNotice } from '../ui/ConnectionNotice'
import { radius, space } from '../ui/tokens'
import { TopBar } from '../ui/TopBar'
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
    <SafeAreaView edges={['top', 'bottom']} style={{ flex: 1, backgroundColor: c.bg }}>
      <TopBar title={t(lang, 'devices.title')} onBack={() => (router.canGoBack() ? router.back() : router.replace('/settings'))} connection={online ? 'online' : 'offline'} />
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: space.xl, gap: space.l }}>
        <ConnectionNotice />
        {!v ? (
          q.error ? (
            <Pressable testID="devices-load-failed" accessibilityRole="button" onPress={() => void q.refresh()}>
              <Text style={{ color: c.warn }}>{t(lang, 'devices.loadFailed')}</Text>
            </Pressable>
          ) : <Text style={{ color: c.muted }}>{t(lang, 'progress.loading')}</Text>
        ) : (
          <View testID="devices-list" style={{ gap: space.l }}>
            <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 18 }}>{t(lang, 'devices.thisPhone')}</Text>
            <Card style={{ gap: space.s }}>
              <Text style={{ color: c.muted, fontSize: 13 }}>{t(lang, 'devices.nameLabel')}</Text>
              <TextInput
                testID="devices-name-input"
                value={name ?? ''}
                onChangeText={x => { setName(x); setMsg(null) }}
                maxLength={24}
                style={{ minHeight: 48, borderWidth: 1, borderColor: c.line, borderRadius: radius.button, paddingHorizontal: space.m, color: c.ink, backgroundColor: c.card }}
              />
              <Button kind="primary" testID="devices-save" label={t(lang, 'devices.save')} busy={busy} disabled={!online || !(name ?? '').trim()} onPress={() => void save()} />
              {msg ? <Text accessibilityLiveRegion="polite" style={{ color: msg === 'saved' ? c.muted : c.warn, fontSize: 14 }}>{t(lang, msg === 'saved' ? 'devices.saved' : 'devices.saveFailed')}</Text> : null}
            </Card>
            {v.others.length > 0 ? (
              <>
                <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 18 }}>{t(lang, 'devices.others')}</Text>
                {v.others.map(o => (
                  <Pressable key={o.id} testID={`devices-other-${o.id}`} accessibilityRole="button" accessibilityLabel={o.label} onPress={() => setHint(o.id)}>
                    <Card style={{ gap: space.xs }}>
                      <Text style={{ color: c.ink, fontSize: 16 }}>{o.label}</Text>
                      {o.lastSeen ? <Text style={{ color: c.muted, fontSize: 13 }}>{o.lastSeen}</Text> : null}
                      {hint === o.id ? <Text testID="devices-other-hint" accessibilityLiveRegion="polite" style={{ color: c.muted, fontSize: 14, lineHeight: 20 }}>{t(lang, 'devices.otherHint')}</Text> : null}
                    </Card>
                  </Pressable>
                ))}
              </>
            ) : null}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  )
}

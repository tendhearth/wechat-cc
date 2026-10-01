import { CameraView, useCameraPermissions } from 'expo-camera'
import { Stack, useRouter } from 'expo-router'
import { useEffect, useRef, useState } from 'react'
import { BackHandler, Linking, Platform, ScrollView, Text, TextInput, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { t, type MessageKey } from '../i18n'
import { useLang } from '../i18n/useLang'
import { parsePairLink, type ParsedLink } from '../net/link'
import { pairWithLink, PairError } from '../net/pairing'
import { rnConnect } from '../net/rn-connect'
import { useConnection } from '../state/hooks'
import { useSession } from '../state/session'
import { pairAndSave } from '../state/wiring'
import { Button } from '../ui/Button'
import { Card } from '../ui/Card'
import { CCFigure } from '../ui/CCFigure'
import { radius, space } from '../ui/tokens'
import { TopBar } from '../ui/TopBar'
import { useTheme } from '../ui/useTheme'
import { ccPresence } from '../view/presence'
import { linkErrorKey, makeGate, pairErrorKey } from '../view/pair'

type Phase =
  | { k: 'intro' }
  | { k: 'scan' }
  | { k: 'confirm'; link: ParsedLink }
  | { k: 'working'; link: ParsedLink }
  | { k: 'error'; key: MessageKey; camera?: boolean }

// 配对(spec §6):扫码或粘贴 → 显示中继主机让人确认 → 链接令牌配对、设备令牌确认 → 存钥匙串 → 回此刻。
// 失败的配对什么都不存(pairAndSave);确认这一步挡住「扫到别人的码」。令牌从不进日志或界面。
export default function Pair() {
  const { c } = useTheme()
  const lang = useLang()
  const router = useRouter()
  const conn = useConnection()
  const { setPaired } = useSession()
  const [phase, setPhase] = useState<Phase>({ k: 'intro' })
  const [pasted, setPasted] = useState('')
  const [perm, requestPerm] = useCameraPermissions()
  const scanned = useRef(false)
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])
  const gate = useRef(makeGate()).current
  // 配对进行中吞掉安卓返回键;TopBar 返回在 back() 里同样忽略
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => gate.busy())
    return () => sub.remove()
  }, [gate])

  const accept = (raw: string) => {
    const r = parsePairLink(raw)
    setPhase(r.ok ? { k: 'confirm', link: r.link } : { k: 'error', key: linkErrorKey(r.error) })
  }
  const startScan = async () => {
    const p = perm?.granted ? perm : await requestPerm()
    if (!alive.current) return
    if (p.granted) { scanned.current = false; setPhase({ k: 'scan' }) }
    else setPhase({ k: 'error', key: 'pair.cameraDenied', camera: true })
  }
  const connect = async (link: ParsedLink) => {
    if (!gate.enter()) return
    setPhase({ k: 'working', link })
    try {
      await pairAndSave(
        () => pairWithLink(link, { connect: rnConnect, label: Platform.OS === 'ios' ? 'Tendhearth · iPhone' : 'Tendhearth · Android' }),
        setPaired,
      )
      if (!alive.current) return
      router.replace('/')
    } catch (e) {
      if (alive.current) setPhase({ k: 'error', key: pairErrorKey(e instanceof PairError ? e.code : 'unknown') })
    } finally {
      gate.leave()
    }
  }
  const back = () => {
    if (gate.busy()) return
    if (phase.k === 'confirm' || phase.k === 'error') { setPhase({ k: 'intro' }); return }
    if (router.canGoBack()) router.back()
    else router.replace('/welcome')
  }

  if (phase.k === 'scan') {
    return (
      <View testID="pair-camera" style={{ flex: 1, backgroundColor: c.ink }}>
        <Stack.Screen options={{ gestureEnabled: true }} />
        <CameraView
          style={{ flex: 1 }}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={({ data }) => { if (scanned.current) return; scanned.current = true; accept(data) }}
        />
        <SafeAreaView edges={['bottom']} style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: space.xl }}>
          <Button kind="secondary" testID="pair-cancel-scan" label={t(lang, 'pair.cancelScan')} onPress={() => setPhase({ k: 'intro' })} />
        </SafeAreaView>
      </View>
    )
  }

  const steps = ['pair.step1', 'pair.step2', 'pair.step3'] as const
  return (
    <SafeAreaView edges={['top', 'bottom']} style={{ flex: 1, backgroundColor: c.bg }}>
      {/* 配对进行中关掉 iOS 侧滑返回(安卓返回键由 BackHandler 吞掉) */}
      <Stack.Screen options={{ gestureEnabled: phase.k !== 'working' }} />
      <TopBar onBack={back} showConnection={false} onAvatar={() => router.push('/settings')} />
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: space.xl, gap: space.l }}>
        <View style={{ alignItems: 'center' }}><CCFigure size={120} presence={ccPresence(conn)} /></View>
        <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 28, lineHeight: 36 }}>{t(lang, 'pair.title')}</Text>
        {phase.k === 'confirm' || phase.k === 'working' ? (
          <Card testID="pair-confirm" style={{ gap: space.m }}>
            <Text style={{ color: c.ink, fontSize: 18 }}>{t(lang, 'pair.confirmTitle')}</Text>
            <Text style={{ color: c.muted, fontSize: 15, lineHeight: 22 }}>{t(lang, 'pair.confirmBody', { host: phase.link.relayHost })}</Text>
            <Button
              kind="primary"
              testID="pair-connect"
              label={phase.k === 'working' ? t(lang, 'pair.working') : t(lang, 'pair.connect')}
              busy={phase.k === 'working'}
              onPress={() => void connect(phase.link)}
            />
          </Card>
        ) : (
          <>
            {phase.k === 'error' ? (
              <Card testID="pair-error" style={{ gap: space.s }}>
                <Text accessibilityLiveRegion="polite" style={{ color: c.warn, fontSize: 15, lineHeight: 22 }}>{t(lang, phase.key)}</Text>
                {phase.camera ? <Button kind="secondary" testID="pair-open-settings" label={t(lang, 'pair.openSettings')} onPress={() => void Linking.openSettings()} /> : null}
              </Card>
            ) : null}
            <View testID="pair-steps" style={{ gap: space.m }}>
              {steps.map((k, i) => (
                <Card key={k} style={{ flexDirection: 'row', alignItems: 'center', gap: space.m }}>
                  <View style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: c.navOnBg, alignItems: 'center', justifyContent: 'center' }}>
                    <Text style={{ color: c.navOnInk }}>{i + 1}</Text>
                  </View>
                  <Text style={{ flex: 1, color: c.ink, fontSize: 16, lineHeight: 22 }}>{t(lang, k)}</Text>
                </Card>
              ))}
            </View>
            <Button kind="primary" testID="pair-scan" label={t(lang, 'pair.scan')} onPress={() => void startScan()} />
            <Text style={{ color: c.muted, fontSize: 14, lineHeight: 20 }}>{t(lang, 'pair.pasteHint')}</Text>
            <TextInput
              testID="pair-paste-input"
              value={pasted}
              onChangeText={setPasted}
              placeholder={t(lang, 'pair.pastePlaceholder')}
              placeholderTextColor={c.muted}
              autoCapitalize="none"
              autoCorrect={false}
              style={{ minHeight: 48, borderWidth: 1, borderColor: c.line, borderRadius: radius.button, paddingHorizontal: space.m, color: c.ink, backgroundColor: c.card }}
            />
            <Button kind="secondary" testID="pair-use-pasted" label={t(lang, 'pair.usePasted')} disabled={!pasted.trim()} onPress={() => accept(pasted)} />
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  )
}

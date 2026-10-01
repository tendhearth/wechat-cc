import { CameraView, useCameraPermissions } from 'expo-camera'
import { clearInitialURL, getLinkingURL } from 'expo-linking'
import { Stack, useLocalSearchParams, useRouter } from 'expo-router'
import { useEffect, useRef, useState } from 'react'
import { BackHandler, Linking, Platform, ScrollView, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { t, type MessageKey } from '../i18n'
import { useLang } from '../i18n/useLang'
import { parsePairLink, type ParsedLink } from '../net/link'
import { pairWithLink, PairError, retirePrevious } from '../net/pairing'
import { rnConnect } from '../net/rn-connect'
import { takePendingLink } from '../net/system-link'
import { useConnection } from '../state/hooks'
import { useSession } from '../state/session'
import { pairAndSave } from '../state/wiring'
import { Button } from '../ui/Button'
import { Card } from '../ui/Card'
import { CCFigure } from '../ui/CCFigure'
import { TextField } from '../ui/TextField'
import { radius, space } from '../ui/tokens'
import { TopBar } from '../ui/TopBar'
import { Txt } from '../ui/Txt'
import { useTheme } from '../ui/useTheme'
import { ccPresence } from '../view/presence'
import { intakeIncomingLink, linkErrorKey, makeGate, pairErrorKey } from '../view/pair'

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
  const { setPaired, pairing } = useSession()
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

  // 系统相机扫码 / 通用链接进来(spec §6.3):只到确认卡(显示中继主机与核对码),永不自动配对;正在配对时不打断。
  // 暂存格与原生缓存无论接不接都清掉(见 intakeIncomingLink),令牌只在确认卡的内存状态里,不进路由参数、不进日志。
  const { from, n } = useLocalSearchParams<{ from?: string; n?: string }>()
  const phaseRef = useRef(phase.k)
  phaseRef.current = phase.k
  useEffect(() => {
    if (from !== 'link') return
    const r = intakeIncomingLink(phaseRef.current, gate.busy(), { take: takePendingLink, readNative: getLinkingURL, clearNative: clearInitialURL, dev: __DEV__ })
    if (r.k === 'confirm') setPhase({ k: 'confirm', link: r.link })
    else if (r.k === 'error') setPhase({ k: 'error', key: r.key })
  }, [from, n, gate])

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
      const prev = pairing
      const rec = await pairAndSave(
        () => pairWithLink(link, { connect: rnConnect, label: Platform.OS === 'ios' ? 'Tendhearth · iPhone' : 'Tendhearth · Android' }),
        setPaired,
      )
      // 新配对已存好之后才退旧位(D5);不等它,结果不影响这次配对。只试一次,日志只记结果。
      void retirePrevious(prev, rec, { connect: rnConnect }).then(r => { if (__DEV__) console.log(`[pair] retire previous: ${r}`) })
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
    <SafeAreaView edges={['top', 'bottom']} style={{ flex: 1, backgroundColor: c.paper }}>
      {/* 配对进行中关掉 iOS 侧滑返回(安卓返回键由 BackHandler 吞掉) */}
      <Stack.Screen options={{ gestureEnabled: phase.k !== 'working' }} />
      <TopBar onBack={back} onAvatar={() => router.push('/settings')} />
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: space.xl, gap: space.l }}>
        <View style={{ alignItems: 'center' }}><CCFigure size={120} presence={ccPresence(conn)} /></View>
        <Txt role="title" accessibilityRole="header" style={{ textAlign: 'center' }}>{t(lang, 'pair.title')}</Txt>
        {phase.k === 'confirm' || phase.k === 'working' ? (
          <Card testID="pair-confirm" style={{ gap: space.m }}>
            <Txt role="item" accessibilityRole="header">{t(lang, 'pair.confirmTitle')}</Txt>
            <Txt role="bubble" tone="inkSoft">{t(lang, 'pair.confirmBody', { host: phase.link.relayHost })}</Txt>
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
              <View testID="pair-error" style={{ gap: space.s }}>
                <Txt role="bubble" tone="bad" accessibilityLiveRegion="polite">{t(lang, phase.key)}</Txt>
                {phase.camera ? <Button kind="secondary" testID="pair-open-settings" label={t(lang, 'pair.openSettings')} onPress={() => void Linking.openSettings()} /> : null}
              </View>
            ) : null}
            {/* 三步:编号 + 一句,行间细线;不画圆圈色块 */}
            <View testID="pair-steps" style={{ borderTopWidth: 1, borderTopColor: c.hair }}>
              {steps.map((k, i) => (
                <View key={k} style={{ flexDirection: 'row', alignItems: 'baseline', gap: space.m, paddingVertical: space.m, borderBottomWidth: 1, borderBottomColor: c.hair }}>
                  <Txt role="meta" tone="inkSoft" style={{ width: 16 }}>{i + 1}</Txt>
                  <Txt role="body" style={{ flex: 1 }}>{t(lang, k)}</Txt>
                </View>
              ))}
            </View>
            <Button kind="primary" testID="pair-scan" label={t(lang, 'pair.scan')} onPress={() => void startScan()} />
            <Txt role="meta" tone="inkSoft" style={{ marginTop: space.s }}>{t(lang, 'pair.pasteHint')}</Txt>
            <TextField
              testID="pair-paste-input"
              value={pasted}
              onChangeText={setPasted}
              placeholder={t(lang, 'pair.pastePlaceholder')}
              content="ui"
              role="meta"
              autoCapitalize="none"
              autoCorrect={false}
              style={{ minHeight: 48, borderWidth: 1, borderColor: c.hair, borderRadius: radius.control, paddingHorizontal: space.l, backgroundColor: c.paper }}
            />
            <Button kind="secondary" testID="pair-use-pasted" label={t(lang, 'pair.usePasted')} disabled={!pasted.trim()} onPress={() => accept(pasted)} />
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  )
}

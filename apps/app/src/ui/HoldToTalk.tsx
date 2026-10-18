import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { ActivityIndicator, Pressable, View, type GestureResponderEvent } from 'react-native'
import { t, type Lang } from '../i18n'
import { openSystemSettings } from '../push/native'
import { makeTalkController, type TalkController, type TalkView } from '../state/hold-to-talk'
import { TALK_NOTE_KEY, elapsedLabel, isTalkProblem, secondsLeft } from '../view/hold-to-talk'
import { Dot } from './Dot'
import { TALK_MIME, useTalkRecorder } from './talk-recorder'
import { radius, space } from './tokens'
import { Txt } from './Txt'
import { useTheme } from './useTheme'

/** 按住说话(2026-10-18):一个控制器,两块画面 —— 输入框左边的按钮、输入框上面的一行状态。 */
export function useHoldToTalk(p: { transcribe(x: { mime: string; audioBase64: string }): Promise<string>; onText(text: string): void; configured: boolean | null }) {
  const recorder = useTalkRecorder()
  const latest = useRef(p)
  latest.current = p
  const [ctl] = useState<TalkController>(() => makeTalkController({
    recorder, mime: TALK_MIME, now: () => Date.now(),
    transcribe: x => latest.current.transcribe(x), onText: s => latest.current.onText(s),
    setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: h => clearTimeout(h as ReturnType<typeof setTimeout>),
  }))
  useEffect(() => () => ctl.dispose(), [ctl])
  useEffect(() => { ctl.setConfigured(p.configured) }, [ctl, p.configured])
  const view = useSyncExternalStore(ctl.subscribe, ctl.get, ctl.get)
  // 录音中每 250ms 走一下秒数
  const [now, setNow] = useState(() => Date.now())
  const recording = view.phase.phase === 'recording'
  useEffect(() => {
    if (!recording) return
    setNow(Date.now())
    const h = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(h)
  }, [recording])
  const elapsedMs = view.phase.phase === 'recording' ? Math.max(0, now - view.phase.since) : 0
  return { ctl, view, elapsedMs }
}

/** 输入框左边那颗:按住录,上滑取消。描边小钮(强调色只在录的时候描一圈,不上色块)。 */
export function TalkButton({ ctl, view, elapsedMs, lang, disabled, testID }: { ctl: TalkController; view: TalkView; elapsedMs: number; lang: Lang; disabled: boolean; testID: string }) {
  const { c } = useTheme()
  const startY = useRef(0)
  const phase = view.phase.phase
  const off = view.configured === false
  const label = phase === 'recording' ? (view.cancel ? t(lang, 'talk.releaseCancel') : t(lang, 'talk.release', { t: elapsedLabel(elapsedMs) }))
    : off ? t(lang, 'talk.noSetup') : t(lang, 'talk.button')
  const busy = phase === 'transcribing' || phase === 'arming'
  return (
    <View
      testID={testID}
      accessible
      accessibilityRole="button"
      accessibilityLabel={t(lang, 'talk.button')}
      accessibilityHint={t(lang, off ? 'talk.notConfigured' : 'talk.a11yHint')}
      accessibilityState={{ disabled, busy }}
      onStartShouldSetResponder={() => !disabled && phase === 'idle'}
      onResponderTerminationRequest={() => false}
      onResponderGrant={(e: GestureResponderEvent) => { startY.current = e.nativeEvent.pageY; void ctl.press() }}
      onResponderMove={(e: GestureResponderEvent) => ctl.move(e.nativeEvent.pageY - startY.current)}
      onResponderRelease={() => { void ctl.release() }}
      onResponderTerminate={() => { void ctl.release(true) }}
      style={{
        minHeight: 48, minWidth: 48, paddingHorizontal: space.m, borderRadius: radius.control, justifyContent: 'center', alignItems: 'center',
        borderWidth: 1, borderColor: phase === 'recording' && !view.cancel ? c.accent : c.hair, backgroundColor: c.paper, opacity: disabled ? 0.55 : off ? 0.75 : 1,
      }}
    >
      {phase === 'transcribing' ? <ActivityIndicator color={c.inkSoft} /> : <Txt role="meta" tone={off || view.cancel ? 'inkSoft' : 'ink'} numberOfLines={1}>{label}</Txt>}
    </View>
  )
}

/** 输入框上面那一行:在听(秒数 · 上滑取消 / 还剩几秒)、在转、或一句提示 / 原因(没权限带「去设置」)。 */
export function TalkStatus({ view, elapsedMs, lang, testID }: { view: TalkView; elapsedMs: number; lang: Lang; testID: string }) {
  const { c } = useTheme()
  const phase = view.phase.phase
  if (phase === 'recording') {
    const left = secondsLeft(elapsedMs)
    const line = view.cancel ? t(lang, 'talk.cancelZone')
      : left !== null ? `${t(lang, 'talk.listening', { t: elapsedLabel(elapsedMs) })} · ${t(lang, 'talk.left', { n: left })}` : t(lang, 'talk.listening', { t: elapsedLabel(elapsedMs) })
    return (
      <View testID={`${testID}-recording`} style={{ flexDirection: 'row', alignItems: 'center', gap: space.s }}>
        {/* 在听:一个静止的强调色小点(不闪,不加新颜色) */}
        <View importantForAccessibility="no" accessibilityElementsHidden style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: view.cancel ? c.hair : c.accent }} />
        <Txt role="meta" tone="inkSoft" accessibilityLiveRegion="polite" style={{ flex: 1 }}>{line}</Txt>
      </View>
    )
  }
  if (phase === 'transcribing') return <Txt testID={`${testID}-transcribing`} role="meta" tone="inkSoft" accessibilityLiveRegion="polite">{t(lang, 'talk.transcribing')}</Txt>
  if (!view.note) return null
  const problem = isTalkProblem(view.note)
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.s }}>
      {problem ? <Dot kind="warn" size={8} /> : null}
      <Txt testID={`${testID}-note-${view.note}`} role="meta" tone="inkSoft" accessibilityLiveRegion="polite" style={{ flexShrink: 1 }}>{t(lang, TALK_NOTE_KEY[view.note])}</Txt>
      {view.note === 'micDenied' ? (
        <Pressable testID={`${testID}-settings`} accessibilityRole="button" accessibilityLabel={t(lang, 'talk.openSettings')} onPress={openSystemSettings} hitSlop={10}>
          <Txt role="meta" style={{ textDecorationLine: 'underline' }}>{t(lang, 'talk.openSettings')}</Txt>
        </Pressable>
      ) : null}
    </View>
  )
}

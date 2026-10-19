import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { ActivityIndicator, Pressable, View, type GestureResponderEvent } from 'react-native'
import { t, type Lang } from '../i18n'
import { openSystemSettings } from '../push/native'
import { makeTalkController, type TalkController, type TalkView } from '../state/hold-to-talk'
import { LONG_PRESS_MS, TALK_NOTE_KEY, buttonFace, elapsedLabel, isTalkProblem, pressPlan, secondsLeft } from '../view/hold-to-talk'
import { Dot } from './Dot'
import { TALK_MIME, useTalkRecorder } from './talk-recorder'
import { radius, space } from './tokens'
import { Txt } from './Txt'
import { useTheme } from './useTheme'

/** 按住说话(2026-10-18):一个控制器,两块画面 —— 输入框右边那颗(发送兼说话)、输入框上面的一行状态。 */
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

/**
 * 输入框右边唯一那颗(2026-10-18 主人:发送和说话合成一个):
 * 有字 / 有图 ⇒ 实心「发送」,点一下发,按住 0.35 秒变成说话;空着 ⇒ 描边「按住说话」,一按就录。录的时候上滑取消。
 * 强调色只给「发送」的实心和「在录」的那一圈。
 */
export function SendTalkButton(p: {
  ctl: TalkController; view: TalkView; elapsedMs: number; lang: Lang
  /** 有东西可发、在线、没在发。 */ sendable: boolean
  /** 能不能开始说(在线、没在发)。 */ talkable: boolean
  sending: boolean
  onTap(): void
  testID: string
}) {
  const { ctl, view, elapsedMs, lang, testID } = p
  const { c } = useTheme()
  const latest = useRef(p)
  latest.current = p
  const startY = useRef(0)
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const talking = useRef(false)
  useEffect(() => () => { if (holdTimer.current) clearTimeout(holdTimer.current) }, [])
  const phase = view.phase.phase
  const plan = pressPlan({ sendable: p.sendable, talkable: p.talkable })
  const face = buttonFace({ sending: p.sending, sendable: p.sendable, phase, cancel: view.cancel, configured: view.configured })
  const filled = face === 'send' || face === 'sending'
  const label = face === 'send' ? t(lang, 'chat.send')
    : face === 'recording' ? t(lang, 'talk.release', { t: elapsedLabel(elapsedMs) })
    : face === 'cancel' ? t(lang, 'talk.releaseCancel')
    : face === 'noSetup' ? t(lang, 'talk.noSetup') : t(lang, 'talk.button')
  const disabled = plan === 'none'
  const startTalk = () => { talking.current = true; void ctl.press() }
  const clearHold = () => { if (holdTimer.current) { clearTimeout(holdTimer.current); holdTimer.current = null } }
  return (
    <View
      testID={testID}
      accessible
      accessibilityRole="button"
      accessibilityLabel={face === 'send' || face === 'sending' ? t(lang, 'chat.send') : t(lang, 'talk.button')}
      accessibilityHint={face === 'send' ? t(lang, 'talk.a11ySendHint') : t(lang, view.configured === false ? 'talk.notConfigured' : 'talk.a11yHint')}
      accessibilityState={{ disabled, busy: face === 'sending' || face === 'transcribing' }}
      accessibilityActions={[{ name: 'activate' }]}
      onAccessibilityAction={e => { if (e.nativeEvent.actionName === 'activate' && latest.current.sendable) latest.current.onTap() }}
      onStartShouldSetResponder={() => !disabled && phase === 'idle'}
      onResponderTerminationRequest={() => false}
      onResponderGrant={(e: GestureResponderEvent) => {
        startY.current = e.nativeEvent.pageY
        talking.current = false
        clearHold()
        if (plan === 'talk') startTalk()
        else holdTimer.current = setTimeout(() => { holdTimer.current = null; startTalk() }, LONG_PRESS_MS)
      }}
      onResponderMove={(e: GestureResponderEvent) => { if (talking.current) ctl.move(e.nativeEvent.pageY - startY.current) }}
      onResponderRelease={() => {
        if (holdTimer.current) { clearHold(); if (latest.current.sendable) latest.current.onTap(); return }
        if (talking.current) void ctl.release()
      }}
      onResponderTerminate={() => { clearHold(); if (talking.current) void ctl.release(true) }}
      style={{
        minHeight: 48, minWidth: 48, paddingHorizontal: filled ? space.l : space.m, borderRadius: radius.control, justifyContent: 'center', alignItems: 'center',
        borderWidth: 1, borderColor: filled || (face === 'recording') ? c.accent : c.hair,
        backgroundColor: filled ? c.accent : c.paper, opacity: disabled && !p.sending ? 0.55 : face === 'noSetup' ? 0.75 : 1,
      }}
    >
      {face === 'sending' ? <ActivityIndicator color={c.onAccent} />
        : face === 'transcribing' ? <ActivityIndicator color={c.inkSoft} />
        : <Txt role={filled ? 'body' : 'meta'} tone={filled ? 'onAccent' : face === 'noSetup' || face === 'cancel' ? 'inkSoft' : 'ink'} numberOfLines={1}>{label}</Txt>}
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

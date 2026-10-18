// 按住说话(2026-10-18)的控制器:按下 → 问权限 → 开麦 → 松开(或到 60 秒)→ 停 → 交给电脑转成字 → onText。
// 纯 TS(录音机、转写、钟都注入),页面只管把手势喂进来、把状态画出来。转出来的字只交给 onText,永不自动发。
import { MAX_RECORD_MS, isCancelDrag, recordingFits, releaseAction, transcribeNote, type TalkNote, type TalkPhase } from '../view/hold-to-talk'

export type MicPermission = 'granted' | 'asked' | 'denied'
export type TalkRecorder = {
  /** granted = 可以录;asked = 刚弹过系统框且同意了(手指早松开了,这一次不录);denied = 只能去设置里开。 */
  permission(): Promise<MicPermission>
  start(): Promise<void>
  /** 停下;keep ⇒ 读出这一段(size 是文件字节数,放不下时 audioBase64 为空);否则只删文件。 */
  stop(keep: boolean): Promise<{ audioBase64: string; size: number } | null>
}
export type TalkView = { phase: TalkPhase; note: TalkNote | null; cancel: boolean; configured: boolean | null }

export function makeTalkController(d: {
  recorder: TalkRecorder
  transcribe(p: { mime: string; audioBase64: string }): Promise<string>
  onText(text: string): void
  mime: string
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(h: unknown): void
}) {
  let view: TalkView = { phase: { phase: 'idle' }, note: null, cancel: false, configured: null }
  const ls = new Set<(v: TalkView) => void>()
  const set = (p: Partial<TalkView>) => { view = { ...view, ...p }; for (const l of ls) l(view) }
  const idle = (note: TalkNote | null) => set({ phase: { phase: 'idle' }, note, cancel: false })
  let gen = 0, pressAt = 0, released = false, cancel = false, maxTimer: unknown = null
  const clearMax = () => { if (maxTimer !== null) { d.clearTimeout(maxTimer); maxTimer = null } }

  async function finish(my: number) {
    clearMax()
    if (my !== gen || view.phase.phase !== 'recording') return
    const action = releaseAction(d.now() - pressAt, cancel)
    if (action === 'transcribe') set({ phase: { phase: 'transcribing' }, cancel: false })
    let r: Awaited<ReturnType<TalkRecorder['stop']>>
    try { r = await d.recorder.stop(action === 'transcribe') } catch { if (my === gen) idle('micFailed'); return }
    if (my !== gen) return
    if (action !== 'transcribe') { idle(action === 'hint' ? 'hint' : null); return }
    if (!r || r.size <= 0) { idle('noSpeech'); return }
    if (!recordingFits(r.size) || !r.audioBase64) { idle('tooLarge'); return }
    try {
      const text = await d.transcribe({ mime: d.mime, audioBase64: r.audioBase64 })
      if (my !== gen) return
      d.onText(text)
      idle(null)
    } catch (e) {
      if (my !== gen) return
      const note = transcribeNote(typeof (e as { code?: unknown })?.code === 'string' ? (e as { code: string }).code : '')
      if (note === 'notConfigured') set({ configured: false })
      idle(note)
    }
  }

  return {
    get: () => view,
    subscribe(l: (v: TalkView) => void) { ls.add(l); return () => { ls.delete(l) } },
    /** 电脑上配没配(GET 的结果);null = 不知道(老电脑 / 没读到),照常让按。 */
    setConfigured(v: boolean | null) { if (v !== view.configured) set({ configured: v }) },
    /** 手指按下。 */
    async press() {
      if (view.phase.phase !== 'idle') return
      if (view.configured === false) { set({ note: 'notConfigured' }); return }
      const my = ++gen
      pressAt = d.now(); released = false; cancel = false
      set({ phase: { phase: 'arming', since: pressAt }, note: null, cancel: false })
      let perm: MicPermission
      try { perm = await d.recorder.permission() } catch { if (my === gen) idle('micFailed'); return }
      if (my !== gen) return
      if (perm !== 'granted') { idle(perm === 'asked' ? 'micReady' : 'micDenied'); return }
      // 权限一问一答之间就松开了:还没开麦,只提示
      if (released) { idle(cancel ? null : 'hint'); return }
      try { await d.recorder.start() } catch { if (my === gen) idle('micFailed'); return }
      if (my !== gen) { void d.recorder.stop(false).catch(() => {}); return }
      set({ phase: { phase: 'recording', since: d.now() } })
      maxTimer = d.setTimeout(() => { void finish(my) }, MAX_RECORD_MS)
      if (released) await finish(my)
    },
    /** 手指移动:dy 向下为正;往上滑够远 ⇒ 松开就丢掉。 */
    move(dy: number) {
      const p = view.phase.phase
      if (p !== 'arming' && p !== 'recording') return
      const c = isCancelDrag(dy)
      if (c !== cancel) { cancel = c; set({ cancel: c }) }
    },
    /** 手指离开;terminated = 手势被系统收走(来电、弹框)⇒ 当取消。 */
    async release(terminated = false) {
      if (terminated) cancel = true
      if (view.phase.phase === 'arming') { released = true; return }
      if (view.phase.phase === 'recording') await finish(gen)
    },
    /** 点了别处 / 输入了字:收起那句提示。 */
    clearNote() { if (view.note) set({ note: null }) },
    /** 离开这一屏:在录就停掉丢弃,迟到的结果一律作废。 */
    dispose() {
      clearMax()
      const wasRecording = view.phase.phase === 'recording'
      gen++
      if (wasRecording) void d.recorder.stop(false).catch(() => {})
    },
  }
}
export type TalkController = ReturnType<typeof makeTalkController>

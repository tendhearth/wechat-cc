// 按住说话(2026-10-18)的纯视图模型:按住 → 录 → 松开转成字 → 填进输入框(永不自动发)。被根目录测试 import:纯 TS,不碰 react / expo。
import { PHONE_TRANSCRIBE_MAX_BYTES, PHONE_TRANSCRIBE_MAX_SECONDS } from '@wechat-cc/protocol'

/** 按不到这么久就松开 ⇒ 不录,只提示「按住说话」。 */
export const MIN_HOLD_MS = 500
/** 手指往上滑过这么多(pt)⇒ 松开就不要这段(同微信)。 */
export const CANCEL_DY = 60
export const MAX_RECORD_MS = PHONE_TRANSCRIBE_MAX_SECONDS * 1000
/** 最后这几秒提示快到头了。 */
export const WARN_LEFT_MS = 10_000

export type TalkPhase =
  | { phase: 'idle' }
  /** 按下了,麦克风还在准备(权限 / 录音会话)。 */
  | { phase: 'arming'; since: number }
  | { phase: 'recording'; since: number }
  | { phase: 'transcribing' }

/** 松开时怎么办:太短 ⇒ 提示;滑开了 ⇒ 丢掉;否则 ⇒ 转成字。 */
export function releaseAction(heldMs: number, cancel: boolean): 'hint' | 'cancel' | 'transcribe' {
  if (cancel) return 'cancel'
  return heldMs < MIN_HOLD_MS ? 'hint' : 'transcribe'
}

/** 手指离按下的地方往上多远(dy 是向下为正的位移)算「滑开取消」。 */
export const isCancelDrag = (dy: number) => dy <= -CANCEL_DY

/** 「0:07」:录了多久;超过上限照上限算。 */
export function elapsedLabel(ms: number): string {
  const s = Math.floor(Math.max(0, Math.min(MAX_RECORD_MS, ms)) / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** 还剩几秒(只在最后 WARN_LEFT_MS 里给数,其余 null)。 */
export function secondsLeft(ms: number): number | null {
  const left = MAX_RECORD_MS - ms
  return left <= WARN_LEFT_MS ? Math.max(0, Math.ceil(left / 1000)) : null
}

/** 录好的文件放不放得进一次请求(多出来的在手机上就拦,不白传)。 */
export const recordingFits = (bytes: number) => bytes > 0 && bytes <= PHONE_TRANSCRIBE_MAX_BYTES

const CJK = /[⺀-鿿豈-﫿＀-￯　-〿]/
/**
 * 转出来的字接在输入框已有的字后面:空 ⇒ 直接是它;已有字以空白结尾 ⇒ 直接接;
 * 接缝两边有一边是中日韩字 / 全角标点 ⇒ 不加空格;否则(英文接英文)加一个空格。
 */
export function mergeTranscript(current: string, transcript: string): string {
  const add = transcript.trim()
  if (!add) return current
  if (!current.trim()) return add
  if (/\s$/.test(current)) return current + add
  return CJK.test(current.slice(-1)) || CJK.test(add[0]!) ? current + add : `${current} ${add}`
}

/** 按钮上面那一句:提示、权限(micDenied 带「去设置」)、转写失败的各种原因。hint / micReady 不是错,不画警示点。 */
export type TalkNote = 'hint' | 'micDenied' | 'micReady' | 'micFailed' | 'notConfigured' | 'blocked' | 'noSpeech' | 'tooLarge' | 'offline' | 'sttFailed' | 'failed'
export const isTalkProblem = (n: TalkNote) => n !== 'hint' && n !== 'micReady'
/** 转写失败的错误码(BackendError.code)⇒ 哪一句。 */
export function transcribeNote(code: string): Exclude<TalkNote, 'hint' | 'micDenied' | 'micReady' | 'micFailed'> {
  switch (code) {
    case 'stt_not_configured': return 'notConfigured'
    case 'stt_blocked': return 'blocked'
    case 'no_speech': return 'noSpeech'
    case 'too_large': return 'tooLarge'
    case 'offline': case 'timeout': case 'revoked': return 'offline'
    case 'stt_failed': case 'unavailable': return 'sttFailed'
    default: return 'failed'
  }
}
export const TALK_NOTE_KEY = {
  hint: 'talk.hint', micDenied: 'talk.micDenied', micReady: 'talk.micReady', micFailed: 'talk.micFailed', notConfigured: 'talk.notConfigured', blocked: 'talk.blocked',
  noSpeech: 'talk.noSpeech', tooLarge: 'talk.tooLarge', offline: 'talk.offline', sttFailed: 'talk.sttFailed', failed: 'talk.failed',
} as const satisfies Record<TalkNote, string>

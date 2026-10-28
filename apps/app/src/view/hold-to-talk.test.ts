import { describe, expect, it } from 'vitest'
import { PHONE_TRANSCRIBE_MAX_BYTES } from '@wechat-cc/protocol'
import { t } from '../i18n'
import { CANCEL_DY, LONG_PRESS_MS, MIN_HOLD_MS, TALK_NOTE_KEY, buttonFace, pressPlan, elapsedLabel, isCancelDrag, isTalkProblem, mergeTranscript, recordingFits, releaseAction, secondsLeft, transcribeNote, type TalkNote } from './hold-to-talk'

describe('按住说话:视图小件', () => {
  it('松开:不到 0.5 秒只提示;滑开了就丢;够长才转', () => {
    expect(releaseAction(MIN_HOLD_MS - 1, false)).toBe('hint')
    expect(releaseAction(MIN_HOLD_MS, false)).toBe('transcribe')
    expect(releaseAction(5_000, true)).toBe('cancel')
    expect(releaseAction(100, true)).toBe('cancel')
  })
  it('往上滑过 60pt 才算取消;往下滑不算', () => {
    expect(isCancelDrag(-CANCEL_DY)).toBe(true)
    expect(isCancelDrag(-CANCEL_DY + 1)).toBe(false)
    expect(isCancelDrag(200)).toBe(false)
  })
  it('秒数:0:00 起,封顶 1:00;最后 10 秒才给「还剩」', () => {
    expect(elapsedLabel(0)).toBe('0:00')
    expect(elapsedLabel(7_900)).toBe('0:07')
    expect(elapsedLabel(65_000)).toBe('1:00')
    expect(elapsedLabel(-5)).toBe('0:00')
    expect(secondsLeft(49_000)).toBeNull()
    expect(secondsLeft(50_000)).toBe(10)
    expect(secondsLeft(59_100)).toBe(1)
    expect(secondsLeft(61_000)).toBe(0)
  })
  it('录音大小:空的不收,上限照收,多一个字节不收', () => {
    expect(recordingFits(0)).toBe(false)
    expect(recordingFits(PHONE_TRANSCRIBE_MAX_BYTES)).toBe(true)
    expect(recordingFits(PHONE_TRANSCRIBE_MAX_BYTES + 1)).toBe(false)
  })
  it('转出来的字接在输入框后面:中文不加空格,英文接英文加一个,已有空白直接接', () => {
    expect(mergeTranscript('', ' 明天提醒我 ')).toBe('明天提醒我')
    expect(mergeTranscript('   ', 'hi')).toBe('hi')
    expect(mergeTranscript('帮我看看', '这个报错')).toBe('帮我看看这个报错')
    expect(mergeTranscript('Check this', 'and that')).toBe('Check this and that')
    expect(mergeTranscript('Check this:', '报错')).toBe('Check this:报错')
    expect(mergeTranscript('第一句\n', 'second')).toBe('第一句\nsecond')
    expect(mergeTranscript('留着', '   ')).toBe('留着')
  })
  it('错误码 ⇒ 一句话;每一句两种语言都有', () => {
    expect(transcribeNote('stt_not_configured')).toBe('notConfigured')
    expect(transcribeNote('stt_blocked')).toBe('blocked')
    expect(transcribeNote('no_speech')).toBe('noSpeech')
    expect(transcribeNote('too_large')).toBe('tooLarge')
    expect(transcribeNote('offline')).toBe('offline')
    expect(transcribeNote('timeout')).toBe('offline')
    expect(transcribeNote('stt_failed')).toBe('sttFailed')
    expect(transcribeNote('unavailable')).toBe('sttFailed')
    expect(transcribeNote('whatever')).toBe('failed')
    for (const [note, key] of Object.entries(TALK_NOTE_KEY)) for (const l of ['en', 'zh-Hans'] as const) expect(t(l, key), `${note} ${l}`).toBeTruthy()
    expect(t('zh-Hans', 'talk.notConfigured')).toContain('电脑上还没配语音转文字')
    expect(isTalkProblem('hint' as TalkNote)).toBe(false)
    expect(isTalkProblem('micReady')).toBe(false)
    expect(isTalkProblem('micDenied')).toBe(true)
  })
})

describe('发送兼说话一颗按钮', () => {
  it('有东西可发 ⇒ 点发、按住说;空着能说 ⇒ 一按就说;都不行 ⇒ 不接手势', () => {
    expect(pressPlan({ sendable: true, talkable: true })).toBe('tapOrHold')
    expect(pressPlan({ sendable: false, talkable: true })).toBe('talk')
    expect(pressPlan({ sendable: false, talkable: false })).toBe('none')
    expect(LONG_PRESS_MS).toBeLessThan(MIN_HOLD_MS)
  })
  it('样子:发送中 > 转写中 > 在录(上滑 = 取消)> 发送 > 说话 / 语音未配', () => {
    const base = { sending: false, sendable: false, phase: 'idle' as const, cancel: false, configured: null }
    expect(buttonFace({ ...base, sending: true, sendable: true })).toBe('sending')
    expect(buttonFace({ ...base, phase: 'transcribing', sendable: true })).toBe('transcribing')
    expect(buttonFace({ ...base, phase: 'recording', sendable: true })).toBe('recording')
    expect(buttonFace({ ...base, phase: 'arming' })).toBe('recording')
    expect(buttonFace({ ...base, phase: 'recording', cancel: true })).toBe('cancel')
    expect(buttonFace({ ...base, sendable: true })).toBe('send')
    expect(buttonFace(base)).toBe('talk')
    expect(buttonFace({ ...base, configured: false })).toBe('noSetup')
    expect(buttonFace({ ...base, configured: false, sendable: true })).toBe('send')
  })
})

import { describe, expect, it } from 'vitest'
import { decideSpeech, type SpeechContext } from './decide'
import { SPEECH_KINDS, originOf, type SpeechKind } from './kinds'

const ok: SpeechContext = { care: 'low', quiet: null, deliverable: true }
const QUIET = { endsIso: '2026-10-22T00:00:00.000Z' }
const of = (origin: string) => (Object.keys(SPEECH_KINDS) as SpeechKind[]).find(k => originOf(k) === origin)!

describe('SpeechPolicy 判定 —— 设计稿 2026-10-21-speech-policy-design 的那张表,一格一格钉死', () => {
  it('四类都有代表;origin 只由种类决定', () => {
    for (const o of ['blocking', 'requested', 'report', 'initiative']) expect(of(o), o).toBeDefined()
    expect(originOf('reminder')).toBe('requested')
    expect(originOf('brief')).toBe('initiative')   // 晨报:开关是主人开的,内容是 CC 挑的
    expect(originOf('job')).toBe('requested')      // 「每天 9 点看邮箱」:内容是主人点名的
    expect(originOf('permission_ask')).toBe('blocking')
    expect(originOf('matter_report')).toBe('report')
  })

  it('一切照常 ⇒ 四类都 allow', () => {
    for (const o of ['blocking', 'requested', 'report', 'initiative']) expect(decideSpeech(of(o), ok), o).toEqual({ allow: true })
  })

  it('care off(别烦我):只拦 initiative(drop,内容算看过);其余三类照说', () => {
    const ctx = { ...ok, care: 'off' as const }
    expect(decideSpeech(of('initiative'), ctx)).toEqual({ drop: true, reason: 'care_off' })
    for (const o of ['blocking', 'requested', 'report']) expect(decideSpeech(of(o), ctx), o).toEqual({ allow: true })
  })

  it('免打扰:blocking / requested 照说;report 与 initiative 推到时段结束;定时触发的 initiative 当天记 skipped:quiet', () => {
    const ctx = { ...ok, quiet: QUIET }
    expect(decideSpeech(of('blocking'), ctx)).toEqual({ allow: true })
    expect(decideSpeech('reminder', ctx)).toEqual({ allow: true })
    expect(decideSpeech('matter_report', ctx)).toEqual({ defer: true, until: QUIET.endsIso, reason: 'quiet_hours' })
    expect(decideSpeech('companion', ctx)).toEqual({ defer: true, until: QUIET.endsIso, reason: 'quiet_hours' })
    expect(decideSpeech('brief', { ...ctx, scheduled: true })).toEqual({ drop: true, reason: 'skipped:quiet' })
  })

  it('每种自己的频率只管 initiative', () => {
    const perKind = { ok: false as const, reason: 'gap_proactive_recent' }
    expect(decideSpeech('companion', { ...ok, perKind })).toEqual({ drop: true, reason: 'gap_proactive_recent' })
    expect(decideSpeech('matter_report', { ...ok, perKind })).toEqual({ allow: true })
  })

  it('哪条路都送不到 ⇒ 四类一律 defer(不重试、不花模型);defer 只是不风暴,不是不送', () => {
    const ctx = { ...ok, deliverable: false }
    for (const o of ['blocking', 'requested', 'report', 'initiative']) expect(decideSpeech(of(o), ctx), o).toEqual({ defer: true, reason: 'undeliverable' })
  })

  it('先后:initiative 先看 care off(别烦我优先于一切)、再看免打扰、再看频率、最后看送不送得到', () => {
    expect(decideSpeech('companion', { care: 'off', quiet: QUIET, deliverable: false, perKind: { ok: false, reason: 'x' } })).toEqual({ drop: true, reason: 'care_off' })
    expect(decideSpeech('companion', { care: 'low', quiet: QUIET, deliverable: false, perKind: { ok: false, reason: 'x' } })).toEqual({ defer: true, until: QUIET.endsIso, reason: 'quiet_hours' })
    expect(decideSpeech('companion', { care: 'low', quiet: null, deliverable: false, perKind: { ok: false, reason: 'x' } })).toEqual({ drop: true, reason: 'x' })
  })
})

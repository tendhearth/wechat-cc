import { describe, it, expect } from 'vitest'
import { PHONE_API_SCHEMAS } from '@wechat-cc/protocol'
import type { CliSessionRowT } from '../backend/types'
import { nextSayView, sayNote, SAY_CONFIRM_MS, type SayTrack, type SayView } from './terminal-say'

const T0 = 1_000_000
const track = (over: Partial<SayTrack> = {}): SayTrack => ({ sayId: 'say-new', live: true, sentAt: T0, prevId: 'say-old', ...over })
type Last = NonNullable<CliSessionRowT['last_say']>
const last = (over: Partial<Last> = {}): Last => ({ id: 'say-new', state: 'sending', at: 5, ...over })

describe('送进窗口那行小字(2026-10-20)', () => {
  it('夹具过真 schema(会话行的 last_say、说一句回的 say_id)', () => {
    const row = { session_id: 's1', code: 's1', source: 'claude', status: 'running', stale: false, project: 'blog', machine: null, last_summary: null, last_event_at: 1, last_prompt_at: null, created_at: 1, pending: null, live_window: true }
    for (const l of [last(), last({ state: 'sent' }), last({ state: 'failed', error: '没送进电脑上开着的窗口(x)' })]) {
      const p = PHONE_API_SCHEMAS['GET /m/api/cli/sessions']!.safeParse({ ok: true, sessions: [{ ...row, last_say: l }] })
      expect(p.success && (p.data as { sessions: CliSessionRowT[] }).sessions[0]!.last_say).toEqual(l)
    }
    const said = PHONE_API_SCHEMAS['POST /m/api/cli/say']!.safeParse({ ok: true, accepted: true, say_id: 'say-new' })
    expect(said.success && said.data).toEqual({ ok: true, accepted: true, say_id: 'say-new' })
  })
  it('对上同一个 id:在送 ⇒ 正在送;送到 ⇒ 已送进窗口', () => {
    expect(nextSayView(null, track(), last(), T0 + 1000)).toEqual({ kind: 'sending' })
    expect(nextSayView({ kind: 'sending' }, track(), last({ state: 'sent' }), T0 + 3000)).toEqual({ kind: 'sent' })
    expect(sayNote({ kind: 'sending' }, 'zh-Hans')).toBe('正在送进电脑上的窗口…')
    expect(sayNote({ kind: 'sent' }, 'zh-Hans')).toBe('已送进电脑上的窗口，它读到就接着做。')
  })
  it('对上同一个 id、没送进去 ⇒ 照抄 daemon 的原话(它本来就以「没送进…」开头,不再加前缀);没给原话也不说送到', () => {
    const v = nextSayView(null, track(), last({ state: 'failed', error: '没送进电脑上开着的窗口(超时)' }), T0 + 2000)
    expect(v).toEqual({ kind: 'failed', error: '没送进电脑上开着的窗口(超时)' })
    expect(sayNote(v, 'zh-Hans')).toBe('没送进电脑上开着的窗口(超时)')
    expect(sayNote(v, 'en')).toBe('没送进电脑上开着的窗口(超时)')
    const bare = nextSayView(null, track(), last({ state: 'failed' }), T0)
    expect(sayNote(bare, 'zh-Hans')).not.toMatch(/已送进/)
  })
  it('列表还是发出前那份(last_say 是上一句)或还没带 last_say ⇒ 仍在送,不算被盖掉', () => {
    expect(nextSayView(null, track(), last({ id: 'say-old', state: 'sent' }), T0 + 1000)).toEqual({ kind: 'sending' })
    expect(nextSayView(null, track(), undefined, T0 + 1000)).toEqual({ kind: 'sending' })
    expect(nextSayView(null, track({ prevId: null }), undefined, T0)).toEqual({ kind: 'sending' })
  })
  it('有更新的一句(别的 id)⇒ 这句被盖掉:只说收下了,不说送到 —— 哪怕那句送到了', () => {
    const v = nextSayView(null, track(), last({ id: 'say-other', state: 'sent' }), T0 + 1000)
    expect(v).toEqual({ kind: 'superseded' })
    expect(sayNote(v, 'zh-Hans')).not.toMatch(/已送进/)
    expect(sayNote(v, 'en')).not.toMatch(/^Sent into/)
    // 发出前没有 last_say,之后冒出来的不是我们的 ⇒ 也是被盖掉
    expect(nextSayView(null, track({ prevId: null }), last({ id: 'say-other' }), T0)).toEqual({ kind: 'superseded' })
  })
  it('老 daemon:开着窗口却没回 say_id ⇒ 中性的「收下了」;不开窗口那条路 ⇒ 收下即开跑(原来的说法)', () => {
    const old = nextSayView(null, track({ sayId: null }), undefined, T0)
    expect(old).toEqual({ kind: 'acceptedUnknown' })
    expect(sayNote(old, 'zh-Hans')).toMatch(/^收下了/)
    expect(sayNote(old, 'zh-Hans')).not.toMatch(/已送进/)
    // 老 daemon 列表里不会有 last_say;就算有也不拿来对
    expect(nextSayView(null, track({ sayId: null }), last({ state: 'sent' }), T0)).toEqual({ kind: 'acceptedUnknown' })
    const resume = nextSayView(null, track({ sayId: null, live: false }), undefined, T0)
    expect(resume).toEqual({ kind: 'accepted' })
    expect(sayNote(resume, 'zh-Hans')).toBe('收到，它接着跑了，回复会出现在这里。')
  })
  it('一分钟还在送 ⇒ 还没确认送到;差一点不到还算在送', () => {
    expect(nextSayView({ kind: 'sending' }, track(), last(), T0 + SAY_CONFIRM_MS - 1)).toEqual({ kind: 'sending' })
    const v = nextSayView({ kind: 'sending' }, track(), last(), T0 + SAY_CONFIRM_MS)
    expect(v).toEqual({ kind: 'unconfirmed' })
    expect(nextSayView(null, track(), undefined, T0 + SAY_CONFIRM_MS)).toEqual({ kind: 'unconfirmed' })
    expect(sayNote(v, 'zh-Hans')).toBe('还没确认送到，过一会儿再看看。')
  })
  it('定下了就不翻案:送到 / 没送进去之后来了新一句,保持原样', () => {
    const sent: SayView = { kind: 'sent' }
    expect(nextSayView(sent, track(), last({ id: 'say-other' }), T0 + 10 * SAY_CONFIRM_MS)).toBe(sent)
    const failed: SayView = { kind: 'failed', error: 'x' }
    expect(nextSayView(failed, track(), last({ state: 'sent' }), T0)).toBe(failed)
  })
  it('还没确认不算定下:超时后才送到 / 没送进去 ⇒ 照样改过来;仍在送 ⇒ 还是没确认', () => {
    const late: SayView = { kind: 'unconfirmed' }
    expect(nextSayView(late, track(), last({ state: 'sent' }), T0 + 2 * SAY_CONFIRM_MS)).toEqual({ kind: 'sent' })
    expect(nextSayView(late, track(), last({ state: 'failed', error: 'e' }), T0 + 2 * SAY_CONFIRM_MS)).toEqual({ kind: 'failed', error: 'e' })
    expect(nextSayView(late, track(), last(), T0 + 2 * SAY_CONFIRM_MS)).toEqual({ kind: 'unconfirmed' })
  })
  it('每种说法两种语言都有字', () => {
    const all: SayView[] = [{ kind: 'sending' }, { kind: 'sent' }, { kind: 'failed', error: 'x' }, { kind: 'failed', error: '' }, { kind: 'unconfirmed' }, { kind: 'superseded' }, { kind: 'accepted' }, { kind: 'acceptedUnknown' }]
    for (const lang of ['zh-Hans', 'en'] as const) for (const v of all) expect(sayNote(v, lang)).not.toMatch(/terminal\./)
  })
})

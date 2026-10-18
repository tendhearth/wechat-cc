import { describe, expect, it, vi } from 'vitest'
import { BackendError } from '../backend/types'
import { makeTalkController, type MicPermission, type TalkRecorder } from './hold-to-talk'

/** 假录音机 + 手动钟 / 定时器:按下、移动、松开都由测试驱动。 */
function rig(o: { perm?: MicPermission; size?: number; transcribe?: () => Promise<string>; startFails?: boolean } = {}) {
  let clock = 1_000
  const timers: Array<{ at: number; fn: () => void; dead: boolean }> = []
  const rec = {
    permission: vi.fn(async () => o.perm ?? 'granted'),
    start: vi.fn(async () => { if (o.startFails) throw new Error('mic') }),
    stop: vi.fn(async (keep: boolean) => (keep ? { audioBase64: 'QUFBQQ==', size: o.size ?? 4 } : null)),
  } satisfies TalkRecorder
  const texts: string[] = []
  const transcribe = vi.fn(o.transcribe ?? (async () => '明天提醒我'))
  const ctl = makeTalkController({
    recorder: rec, transcribe, onText: s => texts.push(s), mime: 'audio/mp4', now: () => clock,
    setTimeout: (fn, ms) => { const h = { at: clock + ms, fn, dead: false }; timers.push(h); return h },
    clearTimeout: h => { (h as { dead: boolean }).dead = true },
  })
  const advance = async (ms: number) => {
    clock += ms
    for (const h of timers) if (!h.dead && h.at <= clock) { h.dead = true; h.fn() }
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  }
  return { ctl, rec, texts, transcribe, advance, flush: () => new Promise(r => setTimeout(r, 0)) }
}

describe('按住说话控制器', () => {
  it('按住 → 录 → 松开:字交给 onText(不发),录音带 mime 送去转;状态回到空闲', async () => {
    const { ctl, rec, texts, transcribe, advance, flush } = rig()
    await ctl.press()
    expect(ctl.get().phase.phase).toBe('recording')
    expect(rec.start).toHaveBeenCalledOnce()
    await advance(3_000)
    await ctl.release()
    await flush()
    expect(rec.stop).toHaveBeenCalledWith(true)
    expect(transcribe).toHaveBeenCalledWith({ mime: 'audio/mp4', audioBase64: 'QUFBQQ==' })
    expect(texts).toEqual(['明天提醒我'])
    expect(ctl.get()).toMatchObject({ phase: { phase: 'idle' }, note: null })
  })
  it('点一下(不到 0.5 秒)⇒ 不转,只提示「按住说话」', async () => {
    const { ctl, rec, transcribe, advance } = rig()
    await ctl.press()
    await advance(200)
    await ctl.release()
    expect(rec.stop).toHaveBeenCalledWith(false)
    expect(transcribe).not.toHaveBeenCalled()
    expect(ctl.get().note).toBe('hint')
  })
  it('权限还在问的时候就松开 ⇒ 不开麦,只提示', async () => {
    const { ctl, rec } = rig()
    const p = ctl.press()
    await ctl.release()
    await p
    expect(rec.start).not.toHaveBeenCalled()
    expect(ctl.get()).toMatchObject({ phase: { phase: 'idle' }, note: 'hint' })
  })
  it('往上滑 ⇒ 松开就丢掉;滑回来 ⇒ 照常转', async () => {
    const { ctl, rec, transcribe, advance } = rig()
    await ctl.press(); await advance(2_000)
    ctl.move(-80)
    expect(ctl.get().cancel).toBe(true)
    await ctl.release()
    expect(rec.stop).toHaveBeenLastCalledWith(false)
    expect(transcribe).not.toHaveBeenCalled()
    expect(ctl.get().note).toBeNull()
    await ctl.press(); await advance(2_000)
    ctl.move(-80); ctl.move(-10)
    await ctl.release()
    expect(transcribe).toHaveBeenCalledOnce()
  })
  it('手势被系统收走(来电等)⇒ 当取消', async () => {
    const { ctl, transcribe, advance } = rig()
    await ctl.press(); await advance(2_000)
    await ctl.release(true)
    expect(transcribe).not.toHaveBeenCalled()
  })
  it('录满 60 秒自己停下去转;之后手指再松开不重复', async () => {
    const { ctl, rec, transcribe, advance, flush } = rig()
    await ctl.press()
    await advance(60_000)
    await flush()
    expect(rec.stop).toHaveBeenCalledWith(true)
    expect(transcribe).toHaveBeenCalledOnce()
    await ctl.release()
    expect(rec.stop).toHaveBeenCalledOnce()
  })
  it('没麦克风权限 ⇒ micDenied;刚同意 ⇒ micReady(这次不录);开麦失败 ⇒ micFailed', async () => {
    const denied = rig({ perm: 'denied' }); await denied.ctl.press()
    expect(denied.ctl.get().note).toBe('micDenied'); expect(denied.rec.start).not.toHaveBeenCalled()
    const asked = rig({ perm: 'asked' }); await asked.ctl.press()
    expect(asked.ctl.get().note).toBe('micReady'); expect(asked.rec.start).not.toHaveBeenCalled()
    const broken = rig({ startFails: true }); await broken.ctl.press()
    expect(broken.ctl.get()).toMatchObject({ phase: { phase: 'idle' }, note: 'micFailed' })
  })
  it('电脑上没配 ⇒ 记住,下一次按下不开麦直接说清楚;GET 说没配也一样', async () => {
    const r = rig({ transcribe: async () => { throw new BackendError('stt_not_configured') } })
    await r.ctl.press(); await r.advance(2_000); await r.ctl.release(); await r.flush()
    expect(r.ctl.get()).toMatchObject({ note: 'notConfigured', configured: false })
    await r.ctl.press()
    expect(r.rec.start).toHaveBeenCalledOnce()
    const g = rig(); g.ctl.setConfigured(false); await g.ctl.press()
    expect(g.rec.permission).not.toHaveBeenCalled()
    expect(g.ctl.get().note).toBe('notConfigured')
  })
  it('各种失败各说各的:断线 / 没听清 / 太大(手机上就拦,不送)', async () => {
    const off = rig({ transcribe: async () => { throw new BackendError('offline') } })
    await off.ctl.press(); await off.advance(1_000); await off.ctl.release(); await off.flush()
    expect(off.ctl.get().note).toBe('offline')
    const quiet = rig({ transcribe: async () => { throw new BackendError('no_speech') } })
    await quiet.ctl.press(); await quiet.advance(1_000); await quiet.ctl.release(); await quiet.flush()
    expect(quiet.ctl.get().note).toBe('noSpeech')
    const big = rig({ size: 300 * 1024 })
    await big.ctl.press(); await big.advance(1_000); await big.ctl.release(); await big.flush()
    expect(big.ctl.get().note).toBe('tooLarge')
    expect(big.transcribe).not.toHaveBeenCalled()
  })
  it('离开这一屏:在录就停掉丢弃,迟到的字不再填进去', async () => {
    let resolve!: (s: string) => void
    const r = rig({ transcribe: () => new Promise<string>(res => { resolve = res }) })
    await r.ctl.press(); await r.advance(1_000)
    const done = r.ctl.release()
    await r.flush()
    expect(r.ctl.get().phase.phase).toBe('transcribing')
    r.ctl.dispose()
    resolve('迟到的')
    await done
    expect(r.texts).toEqual([])
    const live = rig(); await live.ctl.press(); live.ctl.dispose()
    expect(live.rec.stop).toHaveBeenCalledWith(false)
  })
})

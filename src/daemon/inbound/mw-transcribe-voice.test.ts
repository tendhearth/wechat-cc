import { describe, it, expect, vi } from 'vitest'
import { makeMwTranscribeVoice } from './mw-transcribe-voice'
import type { InboundCtx } from './types'
import { PENDING_CDN_REF } from '../media'

const mkCtx = (over: Partial<InboundCtx['msg']> = {}): InboundCtx => ({
  msg: { chatId: 'c1', text: '(non-text message)', attachments: [], ...over } as InboundCtx['msg'],
  receivedAtMs: 0, requestId: 'r',
})

function make(over: Record<string, any> = {}) {
  const transcribeVoice = vi.fn(async () => ({ text: '周末一起爬山吗' }))
  const readFile = vi.fn(async () => Buffer.from('AMRBYTES'))
  const mw = makeMwTranscribeVoice({ transcribeVoice, readFile, log: () => {}, ...over })
  return { mw, transcribeVoice, readFile }
}

describe('mwTranscribeVoice', () => {
  it('已落地 voice 附件 → 转写并注入 [语音] …(替换占位文本)', async () => {
    const { mw, transcribeVoice, readFile } = make()
    const ctx = mkCtx({ attachments: [{ kind: 'voice', path: '/inbox/c1/voice-1.amr' }] })
    await mw(ctx, async () => {})
    expect(readFile).toHaveBeenCalledWith('/inbox/c1/voice-1.amr')
    expect(transcribeVoice).toHaveBeenCalledWith(expect.any(Buffer), 'audio/amr')
    expect(ctx.msg.text).toBe('[语音] 周末一起爬山吗')       // 占位被替换,不是拼在后面
  })

  it('已有真实文本时,语音转写追加在后面', async () => {
    const { mw } = make()
    const ctx = mkCtx({ text: '看这个', attachments: [{ kind: 'voice', path: '/inbox/c1/v.amr' }] })
    await mw(ctx, async () => {})
    expect(ctx.msg.text).toBe('看这个\n[语音] 周末一起爬山吗')
  })

  it('多条语音各自追加', async () => {
    const transcribeVoice = vi.fn().mockResolvedValueOnce({ text: '第一条' }).mockResolvedValueOnce({ text: '第二条' })
    const { mw } = make({ transcribeVoice })
    const ctx = mkCtx({ text: '(non-text message)', attachments: [
      { kind: 'voice', path: '/a.amr' }, { kind: 'voice', path: '/b.amr' },
    ] })
    await mw(ctx, async () => {})
    expect(ctx.msg.text).toBe('[语音] 第一条\n[语音] 第二条')
  })

  it('PENDING / 非 voice 附件跳过', async () => {
    const { mw, transcribeVoice } = make()
    const ctx = mkCtx({ attachments: [
      { kind: 'voice', path: PENDING_CDN_REF }, { kind: 'image', path: '/img.jpg' },
    ] })
    await mw(ctx, async () => {})
    expect(transcribeVoice).not.toHaveBeenCalled()
    expect(ctx.msg.text).toBe('(non-text message)')
  })

  it('transcribe 抛 no_stt_config → 文本不变、不崩', async () => {
    const transcribeVoice = vi.fn(async () => { throw new Error('no_stt_config') })
    const { mw } = make({ transcribeVoice })
    const ctx = mkCtx({ text: 'x', attachments: [{ kind: 'voice', path: '/v.amr' }] })
    await expect(mw(ctx, async () => {})).resolves.toBeUndefined()
    expect(ctx.msg.text).toBe('x')
  })

  it('transcribe 网络错只影响该条,其余语音仍转写', async () => {
    const transcribeVoice = vi.fn().mockRejectedValueOnce(new Error('cannot connect')).mockResolvedValueOnce({ text: '好的' })
    const { mw } = make({ transcribeVoice })
    const ctx = mkCtx({ text: '(non-text message)', attachments: [
      { kind: 'voice', path: '/bad.amr' }, { kind: 'voice', path: '/ok.amr' },
    ] })
    await mw(ctx, async () => {})
    expect(ctx.msg.text).toBe('[语音] 好的')
  })

  it('空转写文本不追加', async () => {
    const transcribeVoice = vi.fn(async () => ({ text: '   ' }))
    const { mw } = make({ transcribeVoice })
    const ctx = mkCtx({ text: 'x', attachments: [{ kind: 'voice', path: '/v.amr' }] })
    await mw(ctx, async () => {})
    expect(ctx.msg.text).toBe('x')
  })

  it('transcribeVoice 未注入 → no-op(仍调 next)', async () => {
    const next = vi.fn(async () => {})
    const mw = makeMwTranscribeVoice({ log: () => {} })
    const ctx = mkCtx({ attachments: [{ kind: 'voice', path: '/v.amr' }] })
    await mw(ctx, next)
    expect(next).toHaveBeenCalled()
    expect(ctx.msg.text).toBe('(non-text message)')
  })

  it('无附件 → 不读文件、不转写', async () => {
    const { mw, readFile, transcribeVoice } = make()
    await mw(mkCtx(), async () => {})
    expect(readFile).not.toHaveBeenCalled()
    expect(transcribeVoice).not.toHaveBeenCalled()
  })
})

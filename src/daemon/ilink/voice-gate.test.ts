import { describe, it, expect, vi } from 'vitest'
import { gateVoice } from './voice'
import type { WechatVoiceDep } from '../wechat-tool-deps'

function inner() {
  return {
    replyVoice: vi.fn(async () => ({ ok: true as const, msgId: 'm' })),
    synthesizeSpeech: vi.fn(async () => ({ audio: Buffer.from('x'), mime: 'audio/wav' })),
    saveConfig: vi.fn(async () => ({ ok: true as const, tested_ms: 1, provider: 'qwen', default_voice: 'Cherry' })),
    configStatus: vi.fn(() => ({ configured: false as const })),
    transcribe: vi.fn(async () => 'hello'),
    saveSTTConfig: vi.fn(async () => ({ ok: true as const, tested_ms: 1, base_url: 'u', model: 'm' })),
    sttStatus: vi.fn(() => ({ configured: false as const })),
  }
}

describe('gateVoice (2026-10-02)', () => {
  it('unsafe → TTS / STT / config probes never leave the machine; status reads still work', async () => {
    const i = inner()
    const v = gateVoice(i as unknown as WechatVoiceDep, { check: async () => ({ safe: false, source: 'bx', detail: 'bx 未保护' }) })
    expect(await v.replyVoice('c', 'hi')).toEqual({ ok: false, reason: '网络未受保护(bx 未连上),CC 先暂停，恢复后再试。' })
    await expect(v.synthesizeSpeech('hi')).rejects.toMatchObject({ code: 'network_unprotected' })
    await expect(v.transcribe!(Buffer.from('a'), 'audio/silk')).rejects.toMatchObject({ code: 'network_unprotected' })
    expect(await v.saveConfig({ provider: 'qwen' })).toMatchObject({ ok: false, reason: 'network_unprotected' })
    expect(await v.saveSTTConfig!({ base_url: 'https://x', model: 'm' })).toMatchObject({ ok: false, reason: 'network_unprotected' })
    expect(i.replyVoice).not.toHaveBeenCalled()
    expect(i.synthesizeSpeech).not.toHaveBeenCalled()
    expect(i.transcribe).not.toHaveBeenCalled()
    expect(i.saveConfig).not.toHaveBeenCalled()
    expect(i.saveSTTConfig).not.toHaveBeenCalled()
    expect(v.configStatus()).toEqual({ configured: false })
  })

  it('safe → passes through; no gate → returns the inner object untouched', async () => {
    const i = inner()
    const v = gateVoice(i as unknown as WechatVoiceDep, { check: async () => ({ safe: true, source: 'bx', detail: 'ok' }) })
    expect(await v.transcribe!(Buffer.from('a'), 'audio/silk')).toBe('hello')
    expect(gateVoice(i as unknown as WechatVoiceDep, undefined)).toBe(i)
  })
})

import { describe, it, expect, vi } from 'vitest'
import { gateVoice } from './voice'
import type { WechatVoiceDep } from '../wechat-tool-deps'

// 守护 v2:语音按「这一次连到哪」分类 —— 通义 DashScope / 自建网关 / 局域网照常;海外端点才看信号。
function inner(tts: { provider: string; base_url?: string } | null, stt: { base_url: string } | null) {
  return {
    replyVoice: vi.fn(async () => ({ ok: true as const, msgId: 'm' })),
    synthesizeSpeech: vi.fn(async () => ({ audio: Buffer.from('x'), mime: 'audio/wav' })),
    saveConfig: vi.fn(async () => ({ ok: true as const, tested_ms: 1, provider: 'qwen', default_voice: 'Cherry' })),
    configStatus: vi.fn(() => (tts ? { configured: true as const, ...tts } : { configured: false as const })),
    transcribe: vi.fn(async () => 'hello'),
    saveSTTConfig: vi.fn(async () => ({ ok: true as const, tested_ms: 1, base_url: 'u', model: 'm' })),
    sttStatus: vi.fn(() => (stt ? { configured: true as const, model: 'm', ...stt } : { configured: false as const })),
  }
}
const UNSAFE = { check: vi.fn(async () => ({ safe: false, source: 'bx' as const, detail: 'bx 未保护' })) }

describe('gateVoice (守护 v2)', () => {
  it('overseas TTS / STT endpoint + unsafe → never leaves the machine; status reads still work', async () => {
    const i = inner({ provider: 'http_tts', base_url: 'https://api.openai.com/v1' }, { base_url: 'https://api.openai.com/v1' })
    const v = gateVoice(i as unknown as WechatVoiceDep, UNSAFE)
    expect(await v.replyVoice('c', 'hi')).toEqual({ ok: false, reason: '网络未受保护(bx 未连上),用到 语音(OpenAI) 的这一步先暂停，恢复后再试。' })
    await expect(v.synthesizeSpeech('hi')).rejects.toMatchObject({ code: 'network_unprotected' })
    await expect(v.transcribe!(Buffer.from('a'), 'audio/silk')).rejects.toMatchObject({ code: 'network_unprotected' })
    expect(await v.saveConfig({ provider: 'http_tts', base_url: 'https://api.openai.com/v1', model: 'tts-1' })).toMatchObject({ ok: false, reason: 'network_unprotected' })
    expect(await v.saveSTTConfig!({ base_url: 'https://api.openai.com/v1', model: 'm' })).toMatchObject({ ok: false, reason: 'network_unprotected' })
    expect(i.replyVoice).not.toHaveBeenCalled()
    expect(i.synthesizeSpeech).not.toHaveBeenCalled()
    expect(i.transcribe).not.toHaveBeenCalled()
    expect(i.saveConfig).not.toHaveBeenCalled()
    expect(i.saveSTTConfig).not.toHaveBeenCalled()
    expect(v.configStatus()).toMatchObject({ configured: true })
  })

  it('domestic / self-hosted voice (通义 qwen, own gateway, LAN STT) + unsafe → goes through, signal never read', async () => {
    const check = vi.fn(async () => ({ safe: false, source: 'bx' as const, detail: 'bx 未保护' }))
    const i = inner({ provider: 'qwen' }, { base_url: 'http://192.168.1.9:9000' })
    const v = gateVoice(i as unknown as WechatVoiceDep, { check })
    expect(await v.replyVoice('c', 'hi')).toEqual({ ok: true, msgId: 'm' })
    expect(await v.transcribe!(Buffer.from('a'), 'audio/silk')).toBe('hello')
    expect(await v.saveConfig({ provider: 'http_tts', base_url: 'https://brain.youdamaster.cc/voice', model: 'voxcpm' })).toMatchObject({ ok: true })
    expect(check).not.toHaveBeenCalled()
  })

  it('not configured → nothing would leave; inner reports not_configured itself (no 网络未受保护 label)', async () => {
    const i = inner(null, null)
    const v = gateVoice(i as unknown as WechatVoiceDep, UNSAFE)
    await v.replyVoice('c', 'hi')
    expect(i.replyVoice).toHaveBeenCalled()
  })

  it('safe → passes through; no gate → returns the inner object untouched', async () => {
    const i = inner({ provider: 'http_tts', base_url: 'https://api.openai.com/v1' }, { base_url: 'https://api.openai.com/v1' })
    const v = gateVoice(i as unknown as WechatVoiceDep, { check: async () => ({ safe: true, source: 'bx', detail: 'ok' }) })
    expect(await v.transcribe!(Buffer.from('a'), 'audio/silk')).toBe('hello')
    expect(gateVoice(i as unknown as WechatVoiceDep, undefined)).toBe(i)
  })
})

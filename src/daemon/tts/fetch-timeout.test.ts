import { describe, it, expect, vi, afterEach } from 'vitest'
import { makeHttpTTSProvider } from './http-tts'
import { makeQwenProvider } from './qwen'
import { TTS_TIMEOUT_MS } from './fetch-timeout'

const originalFetch = globalThis.fetch

// 网关接了连接却一直不回(VoxCPM2 那台卡住):synth 必须到点失败,而不是永远挂着 ——
// 挂着的话 reply_voice 不会回落文字、桌面「说给我听」一直转圈。
const stallingFetch = () => vi.fn((_url: string, init?: RequestInit) => new Promise((_, reject) => {
  init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))
}))

describe('TTS synth timeout', () => {
  afterEach(() => { globalThis.fetch = originalFetch; vi.useRealTimers() })

  for (const [name, make] of [
    ['http_tts', () => makeHttpTTSProvider({ baseUrl: 'http://mac:8000/v1/audio/speech', model: 'm' })],
    ['qwen', () => makeQwenProvider({ apiKey: 'k' })],
  ] as const) {
    it(`${name}: a stalled gateway rejects with a 504-shaped (transient) error`, async () => {
      vi.useFakeTimers()
      globalThis.fetch = stallingFetch() as any
      const p = make().synth('你好', 'v')
      const settled = expect(p).rejects.toThrow(/504.*timed out/)
      await vi.advanceTimersByTimeAsync(TTS_TIMEOUT_MS + 1)
      await settled
    })
  }
})

import { describe, it, expect, vi } from 'vitest'
import { normalizeLang, runCheap, extractJsonObject, JUDGEMENT_WORDS } from './phone-insight-llm'

describe('phone-insight-llm', () => {
  it('normalizeLang:只认 en / zh-Hans,其它都当 en', () => {
    expect(normalizeLang('zh-Hans')).toBe('zh-Hans')
    expect(normalizeLang('en')).toBe('en')
    expect(normalizeLang('fr')).toBe('en')
    expect(normalizeLang(null)).toBe('en')
  })
  it('extractJsonObject:容忍围栏与前后文字,坏 JSON ⇒ null', () => {
    expect(extractJsonObject('好的:\n```json\n{"a":"x","b":{"c":1}}\n```')).toEqual({ a: 'x', b: { c: 1 } })
    expect(extractJsonObject('{"a": "has } brace"}')).toEqual({ a: 'has } brace' })
    expect(extractJsonObject('no json here')).toBeNull()
    expect(extractJsonObject('{"a": ')).toBeNull()
  })
  it('runCheap:预算内返回;超时抛 insight_timeout', async () => {
    vi.useFakeTimers()
    try {
      await expect(runCheap(async () => 'ok', 'p', 1000)).resolves.toBe('ok')
      const slow = runCheap(() => new Promise(() => {}), 'p', 1000)
      const assertion = expect(slow).rejects.toThrow('insight_timeout')
      await vi.advanceTimersByTimeAsync(1001)
      await assertion
    } finally { vi.useRealTimers() }
  })
  it('JUDGEMENT_WORDS 认得中英文的判断词', () => {
    for (const s of ['这很安全', '建议允许', 'This is safe', 'I recommend allowing', 'harmless']) expect(JUDGEMENT_WORDS.test(s), s).toBe(true)
    expect(JUDGEMENT_WORDS.test('安装 sharp 图片处理组件')).toBe(false)
  })
})

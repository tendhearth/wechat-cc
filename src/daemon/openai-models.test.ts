import { describe, it, expect, vi } from 'vitest'
import { makeOpenaiModels, parseModelsBody } from './openai-models'

function fakeFetch(status: number, body: unknown) {
  return vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body })) as unknown as typeof fetch
}

describe('parseModelsBody', () => {
  it('accepts OpenAI/LiteLLM {data:[{id}]}, {models:[…]} and a bare string[]', () => {
    expect(parseModelsBody({ data: [{ id: 'DeepSeek' }, { id: 'kimi' }] })).toEqual(['DeepSeek', 'kimi'])
    expect(parseModelsBody({ models: ['a', { id: 'b' }] })).toEqual(['a', 'b'])
    expect(parseModelsBody(['x'])).toEqual(['x'])
  })
  it('rejects anything else', () => {
    expect(parseModelsBody({ foo: 1 })).toBeNull()
    expect(parseModelsBody('nope')).toBeNull()
    expect(parseModelsBody(null)).toBeNull()
  })
})

describe('makeOpenaiModels', () => {
  const base = () => 'https://llm.example/v1/'
  it('hits {base}/models with the bearer, dedups + sorts, and caches for 60s', async () => {
    const f = fakeFetch(200, { data: [{ id: 'kimi' }, { id: 'DeepSeek' }, { id: 'kimi' }] })
    let t = 1000
    const m = makeOpenaiModels({ baseUrl: base, apiKey: () => 'sk-x', fetchFn: f, now: () => t })
    expect(await m.list()).toEqual({ models: ['DeepSeek', 'kimi'] })
    expect((f as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0]).toBe('https://llm.example/v1/models')
    expect(((f as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![1] as { headers: Record<string, string> }).headers.authorization).toBe('Bearer sk-x')
    t += 10_000
    expect(await m.list()).toEqual({ models: ['DeepSeek', 'kimi'], fromCache: true })
    t += 60_000
    await m.list()
    expect((f as unknown as { mock: { calls: unknown[][] } }).mock.calls.length).toBe(2)
  })
  it('never throws: missing config / 401 / bad shape / network error all come back as error strings', async () => {
    expect((await makeOpenaiModels({ baseUrl: () => undefined, apiKey: () => 'k' }).list()).error).toContain('openaiBaseUrl')
    expect((await makeOpenaiModels({ baseUrl: base, apiKey: () => undefined }).list()).error).toContain('WECHAT_OPENAI_API_KEY')
    expect((await makeOpenaiModels({ baseUrl: base, apiKey: () => 'k', fetchFn: fakeFetch(401, {}) }).list()).error).toContain('401')
    expect((await makeOpenaiModels({ baseUrl: base, apiKey: () => 'k', fetchFn: fakeFetch(200, { nope: 1 }) }).list()).error).toContain('不是模型列表')
    const boom = vi.fn(async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
    expect((await makeOpenaiModels({ baseUrl: base, apiKey: () => 'k', fetchFn: boom }).list()).error).toContain('ECONNREFUSED')
  })
})

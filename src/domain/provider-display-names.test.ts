import { describe, expect, it } from 'vitest'
import { executorNames, providerDisplayName } from './provider-display-names'

describe('执行者叫什么 —— 照收敛清单 ⑥ 最右一列(主人 10-21 定)', () => {
  it('每家一个正式名字;微信前缀用短的;设置里写清怎么连的', () => {
    expect(executorNames('claude')).toEqual({ name: 'Claude', short: 'Claude', settings: 'Claude' })
    expect(executorNames('codex')).toEqual({ name: 'Codex', short: 'Codex', settings: 'Codex' })
    expect(executorNames('cursor')).toEqual({ name: 'Cursor', short: 'Cursor', settings: 'Cursor' })
    expect(executorNames('openai')).toEqual({ name: '自定义 AI 服务', short: 'API', settings: '自定义 AI 服务' })
    expect(executorNames('gemini')).toEqual({ name: 'Gemini', short: 'Gemini', settings: 'Gemini · 密钥连接' })
    expect(executorNames('agy')).toEqual({ name: 'Gemini', short: 'Gemini', settings: 'Gemini · 账号连接' })
  })
  it('两种 Gemini 都开着 ⇒ 账号那一家写成「Gemini(账号)」,微信前缀也分得开', () => {
    expect(executorNames('agy', ['claude', 'gemini', 'agy'])).toEqual({ name: 'Gemini(账号)', short: 'Gemini(账号)', settings: 'Gemini · 账号连接' })
    expect(executorNames('gemini', ['gemini', 'agy']).name).toBe('Gemini')
    expect(executorNames('agy', ['claude', 'agy']).name).toBe('Gemini')
  })
  it('认不出的 id(自定义 ACP、测试里临时注册的)首字母大写兜底', () => {
    expect(executorNames('kimi')).toEqual({ name: 'Kimi', short: 'Kimi', settings: 'Kimi' })
    expect(providerDisplayName('')).toBe('')
  })
  it('providerDisplayName = 短名(微信里用的那个)', () => {
    expect(providerDisplayName('openai')).toBe('API')
    expect(providerDisplayName('agy')).toBe('Gemini')
    expect(providerDisplayName('agy', ['gemini', 'agy'])).toBe('Gemini(账号)')
  })
})

describe('registry.namesOf —— 读的时候按现在注册了谁来定', () => {
  it('agy 先注册、gemini 后注册(重探补上)⇒ 那一刻起 agy 就叫「Gemini(账号)」;自定义 ACP 用注册时给的名字;内置的写了也不看', async () => {
    const { createProviderRegistry } = await import('../app/provider-registry')
    const reg = createProviderRegistry()
    const p = { spawn: async () => { throw new Error('unused') } } as never
    reg.register('agy', p, { displayName: '随便写的', canResume: () => true })
    expect(reg.namesOf('agy').name).toBe('Gemini')
    reg.register('gemini', p, { canResume: () => false })
    expect(reg.namesOf('agy').short).toBe('Gemini(账号)')
    expect(reg.namesOf('gemini').short).toBe('Gemini')
    reg.register('kimi-acp' as never, p, { displayName: 'Kimi CLI', canResume: () => true })
    expect(reg.namesOf('kimi-acp' as never)).toEqual({ name: 'Kimi CLI', short: 'Kimi CLI', settings: 'Kimi CLI' })
  })
})

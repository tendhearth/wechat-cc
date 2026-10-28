import { describe, it, expect } from 'vitest'
import { cursorSdkFallback, executorBinary, executorCredential, executorMissingConfig } from './executor-detect'

const onPath = (found: Record<string, string>) => (cmd: string) => found[cmd] ?? null

describe('executorBinary', () => {
  it('a configured path wins over PATH', () => {
    expect(executorBinary('cursor', { cursorAgentBin: '/opt/cursor-agent' }, onPath({ 'cursor-agent': '/usr/bin/cursor-agent' }))).toBe('/opt/cursor-agent')
    expect(executorBinary('agy', { agyBin: '/opt/agy' }, onPath({ agy: '/usr/bin/agy' }))).toBe('/opt/agy')
  })
  // 设置面板清空一格就是空串:以前对话侧当成「配了」于是不注册,工作台回落 PATH 于是注册 —— 两边说法不一。
  it('an empty or blank configured path means "not configured": fall back to PATH', () => {
    for (const blank of ['', '   ']) {
      expect(executorBinary('cursor', { cursorAgentBin: blank }, onPath({ 'cursor-agent': '/usr/bin/cursor-agent' }))).toBe('/usr/bin/cursor-agent')
      expect(executorBinary('agy', { agyBin: blank }, onPath({ agy: '/usr/bin/agy' }))).toBe('/usr/bin/agy')
    }
  })
  it('nothing configured and nothing on PATH ⇒ null', () => {
    expect(executorBinary('cursor', {}, onPath({}))).toBeNull()
    expect(executorBinary('agy', { agyBin: '' }, onPath({}))).toBeNull()
  })
})

describe('executorCredential', () => {
  it('takes the first non-empty name in facts order (gemini: GEMINI_API_KEY, then GOOGLE_API_KEY)', () => {
    expect(executorCredential('gemini', { GEMINI_API_KEY: 'g', GOOGLE_API_KEY: 'o' })).toBe('g')
    expect(executorCredential('gemini', { GEMINI_API_KEY: '', GOOGLE_API_KEY: 'o' })).toBe('o')
    expect(executorCredential('gemini', {})).toBeNull()
    expect(executorCredential('openai', { WECHAT_OPENAI_API_KEY: 'k' })).toBe('k')
    expect(executorCredential('openai', { WECHAT_OPENAI_API_KEY: ' ' })).toBeNull()
  })
  it('executors without a credential rule have none', () => {
    expect(executorCredential('claude', { WECHAT_OPENAI_API_KEY: 'k' })).toBeNull()
  })
})

describe('executorMissingConfig', () => {
  it('lists the agent-config fields still empty after trim', () => {
    expect(executorMissingConfig('openai', {})).toEqual(['openaiBaseUrl', 'openaiModel'])
    expect(executorMissingConfig('openai', { openaiBaseUrl: 'https://x', openaiModel: '  ' })).toEqual(['openaiModel'])
    expect(executorMissingConfig('openai', { openaiBaseUrl: 'https://x', openaiModel: 'm' })).toEqual([])
    expect(executorMissingConfig('gemini', {})).toEqual(['geminiModel'])
    expect(executorMissingConfig('claude', {})).toEqual([])
  })
})

describe('cursorSdkFallback', () => {
  it('needs CURSOR_API_KEY and cursorModel', () => {
    expect(cursorSdkFallback({ cursorModel: 'composer-2' }, { CURSOR_API_KEY: 'k' })).toEqual({ key: 'k', missingModel: false })
    expect(cursorSdkFallback({}, { CURSOR_API_KEY: 'k' })).toEqual({ key: 'k', missingModel: true })
    expect(cursorSdkFallback({ cursorModel: 'm' }, {})).toEqual({ key: null, missingModel: false })
  })
})

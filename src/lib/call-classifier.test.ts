import { describe, it, expect } from 'vitest'
import { classifyCall, hostOf, isSelfHostedHost, matchesOverride, type CallTarget } from './call-classifier'

// 主人拍板(2026-10-02):按「这一次调用真正连到哪 + 用哪个模型」分类,不是按 provider 家族。
describe('classifyCall — owner table (默认)', () => {
  it.each<[string, CallTarget, boolean]>([
    // 需要保护
    ['Claude Code 官方', { provider: 'claude' }, true],
    ['Claude 显式指回官方端点', { provider: 'claude', baseUrl: 'https://api.anthropic.com' }, true],
    ['Codex 官方', { provider: 'codex' }, true],
    ['OpenAI API 官方', { provider: 'openai', baseUrl: 'https://api.openai.com/v1' }, true],
    ['openai provider 没给 base URL ⇒ OpenAI 官方', { provider: 'openai' }, true],
    ['Gemini', { provider: 'gemini' }, true],
    ['agy/Antigravity', { provider: 'agy' }, true],
    ['OpenRouter 聚合', { provider: 'openai', baseUrl: 'https://openrouter.ai/api/v1' }, true],
    ['Cursor + claude 模型', { provider: 'cursor', model: 'claude-4.5-sonnet' }, true],
    ['Cursor + sonnet 别名', { provider: 'cursor', model: 'sonnet-4.5-thinking' }, true],
    ['Cursor + gpt-5', { provider: 'cursor', model: 'gpt-5' }, true],
    ['Cursor + o3', { provider: 'cursor', model: 'o3' }, true],
    ['Cursor + gemini', { provider: 'cursor', model: 'gemini-2.5-pro' }, true],
    ['Cursor + 不认识的模型 ⇒ 保护', { provider: 'cursor', model: 'kimi-k2' }, true],
    // 主人定(2026-10-02):「Cursor 除了 auto，其他都要网络」—— Cursor 自家模型也保护
    ['Cursor composer(自家模型也要网络)', { provider: 'cursor', model: 'composer-2' }, true],
    ['Cursor composer 带参数后缀', { provider: 'cursor', model: 'composer-2.5[fast=true]' }, true],
    ['Cursor cursor-small', { provider: 'cursor', model: 'cursor-small' }, true],
    ['Cursor glm', { provider: 'cursor', model: 'glm-5.2[reasoning=high]' }, true],
    ['Cursor grok', { provider: 'cursor', model: 'grok-4' }, true],
    ['Cursor autopilot(不是 auto)', { provider: 'cursor', model: 'auto-max' }, true],
    // 不需要保护
    ['DeepSeek', { provider: 'openai', baseUrl: 'https://api.deepseek.com/v1' }, false],
    // 主人定(2026-10-02):「Kimi 都不需要判断」—— .cn / .ai 一样
    ['Kimi 国内版(moonshot.cn)', { provider: 'openai', baseUrl: 'https://api.moonshot.cn/v1' }, false],
    ['Kimi 国际版(moonshot.ai)', { provider: 'openai', baseUrl: 'https://api.moonshot.ai/v1' }, false],
    ['Kimi moonshot.ai 其它子域', { provider: 'openai', baseUrl: 'https://platform.moonshot.ai' }, false],
    ['Kimi kimi.com', { provider: 'openai', baseUrl: 'https://api.kimi.com/coding/v1' }, false],
    ['Kimi kimi.ai', { provider: 'openai', baseUrl: 'https://api.kimi.ai/v1' }, false],
    ['Claude Code 指到 Kimi 的 Anthropic 兼容端点', { provider: 'claude', baseUrl: 'https://api.moonshot.ai/anthropic' }, false],
    ['通义 DashScope', { provider: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' }, false],
    ['智谱', { provider: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' }, false],
    ['localhost', { provider: 'openai', baseUrl: 'http://localhost:11434/v1' }, false],
    ['127.0.0.1', { provider: 'openai', baseUrl: 'http://127.0.0.1:8000' }, false],
    ['局域网 192.168', { provider: 'openai', baseUrl: 'http://192.168.1.20:8080/v1' }, false],
    ['tailnet 100.x', { provider: 'openai', baseUrl: 'http://100.101.102.103:8080/v1' }, false],
    ['主人自己的网关(自定义,默认不保护)', { provider: 'openai', baseUrl: 'https://llm.youdamaster.cc/v1' }, false],
    ['Claude Code + ANTHROPIC_BASE_URL 指向网关', { provider: 'claude', baseUrl: 'https://gw.example.com' }, false],
    ['Cursor auto', { provider: 'cursor', model: 'auto' }, false],
    ['Cursor Auto(大小写)', { provider: 'cursor', model: 'Auto' }, false],
    ['Cursor 没选模型 ⇒ auto', { provider: 'cursor' }, false],
    ['Cursor 空模型名 ⇒ auto', { provider: 'cursor', model: '  ' }, false],
    ['cursor-agent default[] = Auto', { provider: 'cursor', model: 'default[]' }, false],
    ['cursor-agent default', { provider: 'cursor', model: 'default' }, false],
    ['语音 通义 TTS', { provider: 'voice', baseUrl: 'https://dashscope.aliyuncs.com' }, false],
  ])('%s', (_name, t, expected) => {
    expect(classifyCall(t).protected).toBe(expected)
  })

  it('Cursor auto vs claude model: same provider, different verdicts, honest labels', () => {
    expect(classifyCall({ provider: 'cursor', model: 'auto' })).toMatchObject({ protected: false, kind: 'cursor_auto' })
    expect(classifyCall({ provider: 'cursor', model: 'claude-4.5-sonnet' })).toMatchObject({ protected: true, kind: 'cursor_model', label: 'Cursor(claude-4.5-sonnet)' })
    expect(classifyCall({ provider: 'cursor', model: 'mystery-1' })).toMatchObject({ protected: true, kind: 'cursor_model' })
    expect(classifyCall({ provider: 'cursor', model: 'composer-2' })).toMatchObject({ protected: true, kind: 'cursor_model', label: 'Cursor(composer-2)' })
    // 列模型目录不选模型
    expect(classifyCall({ provider: 'cursor', purpose: 'catalog' })).toMatchObject({ protected: false, kind: 'cursor_setup' })
    // Kimi:「Kimi 都不需要判断」
    expect(classifyCall({ provider: 'openai', baseUrl: 'https://api.moonshot.ai/v1' }, { protectCustomGateways: true })).toMatchObject({ protected: false, kind: 'kimi' })
  })

  it('labels name what gets paused', () => {
    expect(classifyCall({ provider: 'claude' }).label).toBe('Claude')
    expect(classifyCall({ provider: 'claude', baseUrl: 'https://api.anthropic.com/' }).label).toBe('Claude')
    expect(classifyCall({ provider: 'openai', baseUrl: 'https://openrouter.ai/api/v1' }).label).toBe('OpenRouter')
    expect(classifyCall({ provider: 'openai', baseUrl: 'https://api.moonshot.ai/v1' }).label).toBe('Kimi')
    expect(classifyCall({ provider: 'openai', baseUrl: 'https://api.moonshot.cn/v1' }).label).toBe('Kimi')
  })

  it('custom gateways: a user switch opts them in', () => {
    const gw: CallTarget = { provider: 'claude', baseUrl: 'https://gw.example.com' }
    expect(classifyCall(gw)).toMatchObject({ protected: false, kind: 'custom_gateway' })
    expect(classifyCall(gw, { protectCustomGateways: true })).toMatchObject({ protected: true, kind: 'custom_gateway' })
    // 开关不影响国内 / 自建
    expect(classifyCall({ provider: 'openai', baseUrl: 'https://api.deepseek.com' }, { protectCustomGateways: true }).protected).toBe(false)
    expect(classifyCall({ provider: 'openai', baseUrl: 'http://localhost:1234' }, { protectCustomGateways: true }).protected).toBe(false)
  })

  it('unknown provider with no endpoint ⇒ protected (fail safe)', () => {
    expect(classifyCall({ provider: 'mystery' })).toMatchObject({ protected: true, kind: 'unknown_provider' })
  })
})

describe('classifyCall — guard.json overrides', () => {
  it('trust: unknown Cursor model can be released by provider:model pattern', () => {
    expect(classifyCall({ provider: 'cursor', model: 'kimi-k2' }, { trust: ['cursor:kimi-*'] }).protected).toBe(false)
  })
  it('trust by host: 通义国际版', () => {
    expect(classifyCall({ provider: 'openai', baseUrl: 'https://dashscope-intl.aliyuncs.com/v1' }, { trust: ['dashscope-intl.aliyuncs.com'] })).toMatchObject({ protected: false, kind: 'override' })
  })
  it('trust releases a non-auto Cursor model (composer)', () => {
    expect(classifyCall({ provider: 'cursor', model: 'composer-2' }, { trust: ['cursor:composer-*'] })).toMatchObject({ protected: false, kind: 'override' })
  })
  it('protect still opts Kimi back in', () => {
    expect(classifyCall({ provider: 'openai', baseUrl: 'https://api.moonshot.cn/v1' }, { protect: ['*.moonshot.cn'] })).toMatchObject({ protected: true, kind: 'override' })
  })
  it('protect by host / glob / URL / bare provider', () => {
    expect(classifyCall({ provider: 'openai', baseUrl: 'https://llm.youdamaster.cc/v1' }, { protect: ['*.youdamaster.cc'] }).protected).toBe(true)
    expect(classifyCall({ provider: 'openai', baseUrl: 'https://llm.youdamaster.cc/v1' }, { protect: ['https://llm.youdamaster.cc'] }).protected).toBe(true)
    expect(classifyCall({ provider: 'cursor', model: 'auto' }, { protect: ['cursor'] }).protected).toBe(true)
  })
  it('protect beats trust (fail safe)', () => {
    expect(classifyCall({ provider: 'claude' }, { protect: ['claude'], trust: ['claude'] }).protected).toBe(true)
  })
})

describe('helpers', () => {
  it('hostOf', () => {
    expect(hostOf('https://API.Anthropic.com/v1/')).toBe('api.anthropic.com')
    expect(hostOf('llm.example.cc')).toBe('llm.example.cc')
    expect(hostOf('http://[::1]:8080')).toBe('::1')
    expect(hostOf('')).toBeNull()
    expect(hostOf(null)).toBeNull()
  })
  it('isSelfHostedHost', () => {
    for (const h of ['localhost', '127.0.0.1', '10.0.0.5', '172.16.3.4', '192.168.0.2', '100.64.0.1', 'nas.local', 'box.lan', 'm.tailnet.ts.net', '::1', 'fd12:3456::1', 'myserver']) expect(isSelfHostedHost(h)).toBe(true)
    for (const h of ['172.32.0.1', '8.8.8.8', 'api.deepseek.com', '100.128.0.1']) expect(isSelfHostedHost(h)).toBe(false)
  })
  it('matchesOverride: provider:model needs a model unless *', () => {
    expect(matchesOverride('cursor:*', { provider: 'cursor' }, null)).toBe(true)
    expect(matchesOverride('cursor:gpt-*', { provider: 'cursor' }, null)).toBe(false)
  })
})

describe('review #193: actual targets reported by executors', () => {
  it('cursor-agent ACP model ids carry a [params] suffix — default[] is Auto, claude-…[…] is protected', () => {
    expect(classifyCall({ provider: 'cursor', model: 'default[]' })).toMatchObject({ protected: false, kind: 'cursor_auto' })
    expect(classifyCall({ provider: 'cursor', model: 'composer-2.5[fast=true]' })).toMatchObject({ protected: true, kind: 'cursor_model' })
    expect(classifyCall({ provider: 'cursor', model: 'claude-opus-5[thinking=true,context=300k]' })).toMatchObject({ protected: true, kind: 'cursor_model' })
    expect(classifyCall({ provider: 'cursor', model: 'gpt-5.5[context=272k]' })).toMatchObject({ protected: true })
  })
  it('opening an ACP session (setup) is not a model turn for Cursor', () => {
    expect(classifyCall({ provider: 'cursor', purpose: 'setup' }).protected).toBe(false)
    expect(classifyCall({ provider: 'cursor', model: 'composer-2', purpose: 'usage' }).protected).toBe(false)
  })
  it('unresolved target → protected even for a provider that is usually domestic; trust by provider still applies', () => {
    expect(classifyCall({ provider: 'openai', unresolved: true })).toMatchObject({ protected: true, kind: 'unresolved' })
    expect(classifyCall({ provider: 'cursor', model: 'auto', unresolved: true }).protected).toBe(true)
    expect(classifyCall({ provider: 'openai', unresolved: true }, { trust: ['openai'] }).protected).toBe(false)
  })
})

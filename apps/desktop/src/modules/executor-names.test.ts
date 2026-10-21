import { afterEach, describe, expect, it, vi } from 'vitest'
import { __resetExecutorNames, executorName, executorSettingsLabel, haveExecutorNames, loadExecutorNames, rememberExecutorNames } from './executor-names.js'

// 收敛清单 ⑥:桌面不存名字表,只缓存 daemon(GET /v1/llm/health 的 names)给的那份。
afterEach(() => __resetExecutorNames())

describe('executor-names(daemon 下发的名字缓存)', () => {
  it('没拿到 ⇒ 退回 id;拿到 ⇒ 正式名字 / 设置写法(没有设置写法 ⇒ 正式名字)', () => {
    expect(executorName('agy')).toBe('agy')
    expect(executorSettingsLabel('agy')).toBe('agy')
    expect(haveExecutorNames()).toBe(false)
    rememberExecutorNames({ agy: { displayName: 'Gemini(账号)', settingsLabel: 'Gemini · 账号连接' }, codex: { displayName: 'Codex' }, bad: { displayName: 3 }, nope: null })
    expect(haveExecutorNames()).toBe(true)
    expect(executorName('agy')).toBe('Gemini(账号)')
    expect(executorSettingsLabel('agy')).toBe('Gemini · 账号连接')
    expect(executorSettingsLabel('codex')).toBe('Codex')
    expect(executorName('bad')).toBe('bad')
    rememberExecutorNames(undefined)
    expect(executorName('codex')).toBe('Codex')
  })
  it('loadExecutorNames 只读 /v1/llm/health(不带 fresh,不外呼);失败不抛', async () => {
    const invokeApi = vi.fn(async () => ({ ok: true, names: { claude: { displayName: 'Claude', settingsLabel: 'Claude' } } }))
    await loadExecutorNames(invokeApi)
    expect(invokeApi).toHaveBeenCalledWith('GET', '/v1/llm/health')
    expect(executorName('claude')).toBe('Claude')
    await loadExecutorNames(async () => { throw new Error('down') })
    expect(executorName('claude')).toBe('Claude')
  })
})

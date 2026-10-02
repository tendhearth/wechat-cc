/**
 * 钉住**今天**的判定对真实 provider 失败样本各说什么 —— 记录,不是期望。
 *
 * 样本:`__fixtures__/provider-errors/*.json`(真机日志采集 + 沙箱诱发,已脱敏)。
 * 背景与错判清单:docs/reference/provider-error-shapes.md。
 *
 * 这个测试**故意**把错判也钉住(例如 cursor 的 `acp_auth_required` 今天被判
 * unknown)。arch backlog #4 第 2 步改判定时它会红 —— 那是预期的:把 fixture
 * 里对应样本的 `current` 改成新答案,并在文档里划掉那一条错判。
 * 不要为了让它绿而改样本的 `message`:那是真机原文。
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { currentVerdicts, type ProviderErrorSample } from './provider-error-verdicts'

const DIR = join(__dirname, '__fixtures__', 'provider-errors')
const files = readdirSync(DIR).filter(f => f.endsWith('.json')).sort()
const samples: ProviderErrorSample[] = files.flatMap(f => JSON.parse(readFileSync(join(DIR, f), 'utf8')) as ProviderErrorSample[])

describe('provider 失败样本 —— 语料本身', () => {
  it('每家 provider 都有样本,id 不重复', () => {
    expect(new Set(samples.map(s => s.provider))).toEqual(new Set(['claude', 'codex', 'cursor', 'agy', 'openai', 'gemini']))
    expect(new Set(samples.map(s => s.id)).size).toBe(samples.length)
  })

  it('已脱敏:不含真实请求 id / 会话 uuid / 微信聊天 id / 未打码的 key', () => {
    for (const s of samples) {
      expect(s.message, s.id).not.toMatch(/req_[0-9a-f]{16,}/)
      expect(s.message, s.id).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)
      expect(s.message, s.id).not.toMatch(/@im\.wechat|wxid_|@openim/)
      expect(s.message, s.id).not.toMatch(/\bsk-[A-Za-z0-9_-]{8,}/)
    }
  })
})

describe('provider 失败样本 —— 今天的判定(钉住现状,不是期望)', () => {
  it.each(samples.map(s => [s.id, s] as const))('%s', (_id, s) => {
    expect(currentVerdicts(s)).toEqual(s.current)
  })
})

describe('provider 失败样本 —— 两条 owner 红线今天守住了没有', () => {
  // 这两条是**已定**的规矩,不是第 2 步才定的东西,所以这里断言的是期望,
  // 而且今天就成立。第 2 步重构时它们必须一直绿。
  it('agy 的歧义句(auth 与超时搅在一起)在决定是否通知主人的那处判成网络,不是登录失效', () => {
    const agy = samples.filter(s => s.truth === 'auth_ambiguous')
    expect(agy.length).toBeGreaterThan(0)
    for (const s of agy) {
      expect(s.current.healthKind, s.id).toBe('network')
      expect(s.current.providerFailure, s.id).toBe('transient')
      expect(s.current.registryAuthCode, s.id).toBe(false)
    }
  })

  it('claude 会话路径只在双哨兵上产出 auth_failed 码', () => {
    for (const s of samples.filter(x => x.provider === 'claude' && x.path === 'session')) {
      expect(s.errorCode === 'auth_failed', s.id).toBe(s.current.claudeSentinel)
    }
  })
})

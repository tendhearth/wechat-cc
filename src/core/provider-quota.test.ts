import { describe, it, expect } from 'vitest'
import { classifyProviderError, makeQuotaRegistry, QUOTA_TTL_MS, RATE_LIMIT_TTL_MS } from './provider-quota'

/**
 * 额度/限流识别(owner 2026-09-16):订阅类 CLI 没有可编程的用量口子(codex 只有
 * login/doctor,claude 的 /usage 只在交互 TUI 里),所以额度只能从失败里认出来、记住、
 * 再主动避开。分类器认原始错误文本;登记处按 provider 记"什么时候耗尽、说了什么",带 TTL。
 */
describe('classifyProviderError', () => {
  it('Codex 订阅额度耗尽(真机 2026-09-16 原文)', () => {
    expect(classifyProviderError("You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits")).toBe('quota')
  })
  it('Claude Code 订阅额度耗尽的几种写法', () => {
    expect(classifyProviderError("You've reached your usage limit. Your limit will reset at 3pm")).toBe('quota')
    expect(classifyProviderError('Claude AI usage limit reached|1789560000')).toBe('quota')
    expect(classifyProviderError('insufficient_quota: You exceeded your current quota, please check your plan and billing details')).toBe('quota')
  })
  it('限流(过一会儿就好)与耗尽分开', () => {
    expect(classifyProviderError('rate_limit_error: Number of requests has exceeded your rate limit')).toBe('rate_limit')
    expect(classifyProviderError('HTTP 429 Too Many Requests')).toBe('rate_limit')
    expect(classifyProviderError('overloaded_error: Overloaded')).toBe('rate_limit')
  })
  it('鉴权失败 / 网络错误 / 普通失败都不是额度问题', () => {
    expect(classifyProviderError('Authentication Error, Invalid proxy server token passed')).toBeNull()
    expect(classifyProviderError('gateway failed')).toBeNull()
    expect(classifyProviderError('turn_timeout')).toBeNull()
    expect(classifyProviderError('')).toBeNull()
  })
})

describe('makeQuotaRegistry', () => {
  const T0 = 1_800_000_000_000
  it('记下耗尽,并在 TTL 内报"耗尽";过期后自动清掉', () => {
    let t = T0
    const reg = makeQuotaRegistry(() => t)
    expect(reg.exhausted('codex')).toBeNull()
    expect(reg.note('codex', "You've hit your usage limit. Visit …")).toBe('quota')
    expect(reg.exhausted('codex')).toMatchObject({ kind: 'quota', since: T0 })
    t = T0 + QUOTA_TTL_MS - 1; expect(reg.exhausted('codex')).not.toBeNull()
    t = T0 + QUOTA_TTL_MS; expect(reg.exhausted('codex')).toBeNull()
  })
  it('限流的 TTL 短得多;非额度错误不登记', () => {
    let t = T0
    const reg = makeQuotaRegistry(() => t)
    expect(reg.note('claude', 'HTTP 429 Too Many Requests')).toBe('rate_limit')
    t = T0 + RATE_LIMIT_TTL_MS; expect(reg.exhausted('claude')).toBeNull()
    expect(reg.note('claude', 'gateway failed')).toBeNull(); expect(reg.exhausted('claude')).toBeNull()
  })
  it('Claude 消息里带的重置时间戳优先于默认 TTL', () => {
    let t = T0
    const reg = makeQuotaRegistry(() => t)
    reg.note('claude', `Claude AI usage limit reached|${Math.floor((T0 + 5 * 60_000) / 1000)}`)
    expect(reg.exhausted('claude')).toMatchObject({ kind: 'quota', resetAt: T0 + 5 * 60_000 })
    t = T0 + 5 * 60_000; expect(reg.exhausted('claude')).toBeNull()
  })
  it('清掉:一次成功回合后 provider 恢复', () => {
    const reg = makeQuotaRegistry(() => T0)
    reg.note('codex', "You've hit your usage limit"); reg.clear('codex')
    expect(reg.exhausted('codex')).toBeNull()
  })
  it('全量快照给 health / 桌面用', () => {
    const reg = makeQuotaRegistry(() => T0)
    reg.note('codex', "You've hit your usage limit")
    expect(reg.snapshot()).toEqual({ codex: { kind: 'quota', since: T0, resetAt: T0 + QUOTA_TTL_MS, message: "You've hit your usage limit" } })
  })
})

describe('quota registry with live subscription usage (2026-09-16)', () => {
  it('treats a 100% window as exhausted before any task fails, and keeps it after a successful turn', () => {
    let t = 1_000
    const usage = (id: string) => id === 'codex' ? { exhausted: true, windows: [{ name: 'weekly', usedPercent: 100, resetsAt: 50_000 }] } : null
    const r = makeQuotaRegistry(() => t, usage)
    expect(r.exhausted('codex')).toEqual({ kind: 'quota', since: 1_000, resetAt: 50_000, message: 'weekly 窗口已用 100%' })
    expect(r.exhausted('claude')).toBeNull()
    r.clear('codex')
    expect(r.exhausted('codex')?.kind).toBe('quota')
    expect(Object.keys(r.snapshot())).toEqual(['codex'])
    t = 60_000
    expect(r.exhausted('codex')).toBeNull()   // 窗口已重置
  })
  it('error-derived state still wins when usage is unavailable',()=>{
    const r = makeQuotaRegistry(() => 5, () => null)
    r.note('claude', 'Claude AI usage limit reached|1700000000')
    expect(r.exhausted('claude')?.resetAt).toBe(1_700_000_000_000)
  })
})

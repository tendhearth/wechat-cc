import { describe, it, expect } from 'vitest'
import { describeProviderDenial, providerDenialFor, providerForSlash, slashFor } from './provider-policy'
import { PROVIDER_IDS } from '../lib/provider-ids'

describe('providerDenialFor', () => {
  it('admin is never denied', () => {
    expect(providerDenialFor('agy', 'admin', ['claude'])).toBeNull()
    expect(providerDenialFor('cursor', 'admin', undefined)).toBeNull()
  })
  it('guest is denied the one shared-token provider (agy) and the one unconfined provider (cursor: ACP workspace edits never surface a permission card)', () => {
    expect(providerDenialFor('agy', 'guest', undefined)).toEqual({ kind: 'shared_token_guest' })
    expect(providerDenialFor('cursor', 'guest', undefined)).toEqual({ kind: 'unconfined_guest' })
    expect(providerDenialFor('claude', 'guest', undefined)).toBeNull()
    expect(providerDenialFor('openai', 'guest', undefined)).toBeNull()
  })
  // 2026-10-10 评审:Codex 给访客的是 read-only 沙盒 + untrusted 审批 —— 只读沙盒照样能读整台电脑
  // (cat ~/.private_keys/…、记忆、access.json),cat / ls / grep 这类「安全命令」也不问就跑 ⇒ 访客档约束不到读。
  it('codex is not guest-safe either: its read-only sandbox can still read any file on the machine', () => {
    expect(providerDenialFor('codex', 'guest', undefined)).toEqual({ kind: 'unconfined_guest' })
    expect(providerDenialFor('codex', 'trusted', undefined)).toBeNull()
    expect(describeProviderDenial({ kind: 'unconfined_guest' }, 'codex')).toContain('/codex 对访客不开放')
  })
  it('cursor stays open to trusted and admin — only guest is refused', () => {
    expect(providerDenialFor('cursor', 'trusted', undefined)).toBeNull()
    expect(providerDenialFor('cursor', 'admin', undefined)).toBeNull()
  })
  it('trusted honors the admin allowlist; undefined = everything', () => {
    expect(providerDenialFor('agy', 'trusted', undefined)).toBeNull()
    expect(providerDenialFor('agy', 'trusted', ['claude', 'openai'])).toEqual({ kind: 'not_in_trusted_list', allowed: ['claude', 'openai'] })
    expect(providerDenialFor('openai', 'trusted', ['claude', 'openai'])).toBeNull()
    // guest: the allowlist applies too (it is "non-admin"), after the shared-token rule
    expect(providerDenialFor('claude', 'guest', ['openai'])).toEqual({ kind: 'not_in_trusted_list', allowed: ['openai'] })
  })
  // 3c(2026-10-22):以前查不到能力的 id 对访客放行 —— 缺省往放行的方向兜底。现在关门;非访客照旧只看名单。
  it('unknown provider ids do not throw, and a guest is refused them (fail closed)', () => {
    expect(providerDenialFor('bogus', 'guest', undefined)).toEqual({ kind: 'unconfined_guest' })
    expect(providerDenialFor('bogus', 'trusted', undefined)).toBeNull()
    expect(providerDenialFor('bogus', 'admin', undefined)).toBeNull()
  })
  it('a guest gets exactly the executors whose capabilities declare a tier-confined tool surface (guestSafe) and a per-session MCP tier', () => {
    const open = PROVIDER_IDS.filter(id => providerDenialFor(id, 'guest', undefined) === null)
    expect(open.sort()).toEqual(['claude', 'gemini', 'openai'])
  })
  it('messages + slash words', () => {
    expect(describeProviderDenial({ kind: 'shared_token_guest' }, 'agy')).toBe('/agy 目前仅管理员/信任聊天可用（工具通道暂无法按会话隔离权限）。')
    expect(describeProviderDenial({ kind: 'unconfined_guest' }, 'cursor')).toBe('Cursor 对访客不开放：它在工作区内的文件编辑不经过权限卡，访客的权限约束不到它。')
    expect(describeProviderDenial({ kind: 'not_in_trusted_list', allowed: [] }, 'cursor')).toContain('(无)')
    expect(slashFor('claude')).toBe('cc'); expect(slashFor('agy')).toBe('agy')
    // 10-21:openai 的斜杠词是 /api,以前拒绝语里写成「/openai」(没有这个命令)
    expect(slashFor('openai')).toBe('api')
    for (const id of PROVIDER_IDS) expect(providerForSlash(slashFor(id))).toBe(id)
    expect(providerForSlash('openai')).toBeNull()
    expect(providerForSlash('CC')).toBe('claude')
  })
})

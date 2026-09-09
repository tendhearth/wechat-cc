import { describe, it, expect } from 'vitest'
import { describeProviderDenial, providerDenialFor, slashFor } from './provider-policy'

describe('providerDenialFor', () => {
  it('admin is never denied', () => {
    expect(providerDenialFor('agy', 'admin', ['claude'])).toBeNull()
    expect(providerDenialFor('cursor', 'admin', undefined)).toBeNull()
  })
  it('guest is denied every shared-token provider (agy AND cursor — cursor had no gate before)', () => {
    expect(providerDenialFor('agy', 'guest', undefined)).toEqual({ kind: 'shared_token_guest' })
    expect(providerDenialFor('cursor', 'guest', undefined)).toEqual({ kind: 'shared_token_guest' })
    expect(providerDenialFor('claude', 'guest', undefined)).toBeNull()
    expect(providerDenialFor('openai', 'guest', undefined)).toBeNull()
  })
  it('trusted honors the admin allowlist; undefined = everything', () => {
    expect(providerDenialFor('agy', 'trusted', undefined)).toBeNull()
    expect(providerDenialFor('agy', 'trusted', ['claude', 'openai'])).toEqual({ kind: 'not_in_trusted_list', allowed: ['claude', 'openai'] })
    expect(providerDenialFor('openai', 'trusted', ['claude', 'openai'])).toBeNull()
    // guest: the allowlist applies too (it is "non-admin"), after the shared-token rule
    expect(providerDenialFor('claude', 'guest', ['openai'])).toEqual({ kind: 'not_in_trusted_list', allowed: ['openai'] })
  })
  it('unknown provider ids do not throw (registry validates elsewhere)', () => {
    expect(providerDenialFor('bogus', 'guest', undefined)).toBeNull()
  })
  it('messages + slash words', () => {
    expect(describeProviderDenial({ kind: 'shared_token_guest' }, 'agy')).toBe('❌ /agy 目前仅管理员/信任聊天可用（工具通道暂无法按会话隔离权限）。')
    expect(describeProviderDenial({ kind: 'not_in_trusted_list', allowed: [] }, 'cursor')).toContain('(无)')
    expect(slashFor('claude')).toBe('cc'); expect(slashFor('agy')).toBe('agy')
  })
})

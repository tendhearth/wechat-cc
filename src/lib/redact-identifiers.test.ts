import { describe, it, expect } from 'vitest'
import { redactIdentifiers as r } from './redact-identifiers'

describe('redactIdentifiers', () => {
  it('EIN、尾号、密钥文件、令牌都去掉', () => {
    expect(r('EIN: 61-2390916,Wyoming LLC')).toBe('EIN: [EIN],Wyoming LLC')
    expect(r('美元账户 Active,尾号 3419;连接 Airwallex (尾号3419)')).toBe('美元账户 Active,尾号 ****;连接 Airwallex (尾号 ****)')
    expect(r('card ending in 4242')).toBe('card ending in ****')
    expect(r('STRIPE_SECRET_LIVE 存于 ~/.private_keys/1in8b.env,与测试密钥隔离')).toBe('STRIPE_SECRET_LIVE 存于 [密钥文件],与测试密钥隔离')
    expect(r('key 在 /Users/o/.private_keys 里')).toBe('key 在 [密钥文件] 里')
    expect(r('AuthKey_ABC123.p8 别进仓库')).toBe('[密钥文件] 别进仓库')
    expect(r('用 sk-abcdefghijklmnop1234 调')).toBe('用 [令牌] 调')
    expect(r('ghp_abcdefghijklmnopqrstuvwxyz12')).toBe('[令牌]')
    expect(r('Authorization: Bearer abcdefghijklmnopqrstuvwx')).toBe('Authorization: Bearer [令牌]')
  })
  it('正常的数字、日期、版本、提交号不动', () => {
    for (const s of ['2026-11-04 提交', 'v0.5.18', '延期降低 10.9%', 'commit 3897195', '166.88.197.165', '端口 35721', '18 条链接', '1070 项测试', 'TestFlight 25', '000-1234567']) expect(r(s)).toBe(s)
  })
})

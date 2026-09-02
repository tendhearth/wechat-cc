import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { INVITE_TTL_MS, clearInvite, decodeInvite, mintInvite, slugifyHandName, verifyAndConsumeInvite } from './a2a-pairing'

let stateDir: string
const NOW = 1_000_000

beforeEach(() => { stateDir = mkdtempSync(join(tmpdir(), 'a2a-pair-')) })
afterEach(() => { rmSync(stateDir, { recursive: true, force: true }) })

describe('mint/decode', () => {
  it('round-trips the hand url + secret through the code', () => {
    const { code } = mintInvite(stateDir, { handUrl: 'http://home.ts.net:8717/a2a', nowMs: NOW })
    const decoded = decodeInvite(code)
    expect(decoded.handUrl).toBe('http://home.ts.net:8717/a2a')
    expect(decoded.secret.length).toBeGreaterThan(20)
  })
  it('rejects a non-pairing / malformed code', () => {
    expect(() => decodeInvite('not-a-code')).toThrow(/not a wechat-cc pairing code/)
    expect(() => decodeInvite('WCCP1@@@notbase64json')).toThrow(/invalid pairing code/)
  })
})

describe('verifyAndConsumeInvite', () => {
  it('accepts the matching secret once, then it is consumed (single-use)', () => {
    const { code } = mintInvite(stateDir, { handUrl: 'http://h/a2a', nowMs: NOW })
    const { secret } = decodeInvite(code)
    expect(verifyAndConsumeInvite(stateDir, secret, NOW)).toBe(true)
    // second use fails — consumed
    expect(verifyAndConsumeInvite(stateDir, secret, NOW)).toBe(false)
  })

  it('rejects an empty stored secret — no constant-time empty-match bypass', () => {
    // A corrupt / hand-edited pending file with an empty secret must NOT
    // authenticate an empty presented secret: constantTimeEquals('','') is true.
    writeFileSync(join(stateDir, 'a2a-pair-pending.json'), JSON.stringify({ secret: '', expiresMs: NOW + INVITE_TTL_MS }))
    expect(verifyAndConsumeInvite(stateDir, '', NOW)).toBe(false)
  })

  it('rejects a wrong secret WITHOUT burning the invite', () => {
    const { code } = mintInvite(stateDir, { handUrl: 'http://h/a2a', nowMs: NOW })
    const { secret } = decodeInvite(code)
    expect(verifyAndConsumeInvite(stateDir, 'wrong-secret', NOW)).toBe(false)
    // the real secret still works
    expect(verifyAndConsumeInvite(stateDir, secret, NOW)).toBe(true)
  })

  it('rejects an expired invite', () => {
    const { code } = mintInvite(stateDir, { handUrl: 'http://h/a2a', nowMs: NOW })
    const { secret } = decodeInvite(code)
    expect(verifyAndConsumeInvite(stateDir, secret, NOW + INVITE_TTL_MS + 1)).toBe(false)
  })

  it('returns false when there is no pending invite', () => {
    expect(verifyAndConsumeInvite(stateDir, 'whatever', NOW)).toBe(false)
  })
})

describe('clearInvite', () => {
  it('removes the pending invite', () => {
    mintInvite(stateDir, { handUrl: 'http://h/a2a', nowMs: NOW })
    expect(existsSync(join(stateDir, 'a2a-pair-pending.json'))).toBe(true)
    clearInvite(stateDir)
    expect(existsSync(join(stateDir, 'a2a-pair-pending.json'))).toBe(false)
  })
})

// 2026-09-02。配一台手此前要 4 条命令,其中 `hand join <码> --id linux
// --name 旧机器` 还要用户现想一个 slug。而**手那台自己就知道它叫什么** ——
// 把 hostname 放进邀请码里,大脑那边就只剩「粘贴」。
describe('邀请码带上手的身份 —— join 不用再填 --id/--name', () => {
  it('mintInvite 带 handName,decodeInvite 原样取回', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pair-name-'))
    const { code } = mintInvite(dir, { handUrl: 'http://10.0.0.5:8717/a2a', nowMs: Date.now(), handName: 'MacBook-Pro' })
    expect(decodeInvite(code).handName).toBe('MacBook-Pro')
  })

  it('不带 handName 的老码仍然能解(向后兼容)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pair-name-'))
    const { code } = mintInvite(dir, { handUrl: 'http://10.0.0.5:8717/a2a', nowMs: Date.now() })
    const p = decodeInvite(code)
    expect(p.handUrl).toBe('http://10.0.0.5:8717/a2a')
    expect(p.handName).toBeUndefined()
  })
})

describe('slugifyHandName —— 从机器名推一个合法的 hand id', () => {
  it.each([
    ['MacBook-Pro', 'macbook-pro'],
    ['win-test', 'win-test'],
    ['DESKTOP_ABC123', 'desktop-abc123'],
    ['我的旧电脑', null],            // 纯中文推不出 slug(id 必须是小写 ascii slug)
    ['', null],
    ['---', null],
    ['公司.local', null],
  ])('%s → %s', (input, want) => {
    expect(slugifyHandName(input)).toBe(want)
  })

  it('去掉 .local 之类的后缀,并截断到 id 的长度上限', () => {
    expect(slugifyHandName('MacBook-Pro.local')).toBe('macbook-pro')
    expect(slugifyHandName('a'.repeat(200))).toHaveLength(64)
  })
})

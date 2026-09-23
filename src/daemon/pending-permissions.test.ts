import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PendingPermissions, parsePermissionReply } from './pending-permissions'

describe('PendingPermissions', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('consume resolves register() promise with allow', async () => {
    const reg = new PendingPermissions()
    const p = reg.register('abc12', 10_000)
    const matched = reg.consume('abc12', 'allow')
    expect(matched).toBe(true)
    await expect(p).resolves.toBe('allow')
  })

  it('consume resolves register() promise with deny', async () => {
    const reg = new PendingPermissions()
    const p = reg.register('xyz99', 10_000)
    expect(reg.consume('xyz99', 'deny')).toBe(true)
    await expect(p).resolves.toBe('deny')
  })

  it('fail resolves register() promise with undelivered (fail-fast, no dead-wait)', async () => {
    const reg = new PendingPermissions()
    const p = reg.register('undel1', 600_000)
    expect(reg.fail('undel1')).toBe(true)
    await expect(p).resolves.toBe('undelivered')   // resolves NOW, not after 10min
  })

  it('fail returns false when hash not registered', () => {
    const reg = new PendingPermissions()
    expect(reg.fail('ghost')).toBe(false)
  })

  it('consume returns false when hash not registered', () => {
    const reg = new PendingPermissions()
    expect(reg.consume('ghost', 'allow')).toBe(false)
  })

  it('consume returns false when hash already consumed', async () => {
    const reg = new PendingPermissions()
    const p = reg.register('dup', 10_000)
    reg.consume('dup', 'allow')
    await p
    expect(reg.consume('dup', 'deny')).toBe(false)
  })

  it('sweep resolves expired entries as timeout', async () => {
    const reg = new PendingPermissions()
    const p = reg.register('exp', 1_000)
    vi.advanceTimersByTime(2_000)
    reg.sweep()
    await expect(p).resolves.toBe('timeout')
  })

  it('sweep does not resolve non-expired entries', () => {
    const reg = new PendingPermissions()
    reg.register('fresh', 10_000)
    vi.advanceTimersByTime(1_000)
    reg.sweep()
    expect(reg.size()).toBe(1)
  })

  it('size reflects active pending entries', async () => {
    const reg = new PendingPermissions()
    expect(reg.size()).toBe(0)
    reg.register('a', 10_000)
    reg.register('b', 10_000)
    expect(reg.size()).toBe(2)
    reg.consume('a', 'allow')
    expect(reg.size()).toBe(1)
  })
})

describe('两位数码(主人在手机上回的那个)', () => {
  it('register 按滚动顺序发 01、02…;consume 后不立刻复用,99 才回头', () => {
    const p = new PendingPermissions()
    void p.register('h1', 60_000); void p.register('h2', 60_000)
    expect(p.codeOf('h1')).toBe('01'); expect(p.codeOf('h2')).toBe('02')
    expect(p.hashOfCode('02')).toBe('h2'); expect(p.hashOfCode('03')).toBeNull()
    p.consume('h1', 'allow')
    void p.register('h3', 60_000)
    expect(p.codeOf('h3')).toBe('03')       // 刚过期 / 刚批的 01 不马上给下一条
    expect(p.hashOfCode('01')).toBeNull()
  })
  it('跳过仍在用的码', () => {
    const p = new PendingPermissions()
    for (let i = 1; i <= 99; i++) void p.register(`h${i}`, 60_000)
    p.consume('h5', 'allow')
    void p.register('again', 60_000)
    expect(p.codeOf('again')).toBe('05')    // 转了一圈,只有 05 空着
  })
})

describe('parsePermissionReply', () => {
  it('不带码:「y」「n」「同意」「拒绝」,ref 为 null,由调用方按待批条数决定', () => {
    expect(parsePermissionReply('y')).toEqual({ decision: 'allow', ref: null })
    expect(parsePermissionReply('N')).toEqual({ decision: 'deny', ref: null })
    expect(parsePermissionReply('同意')).toEqual({ decision: 'allow', ref: null })
    expect(parsePermissionReply('  放行 ')).toEqual({ decision: 'allow', ref: null })
    expect(parsePermissionReply('拒绝')).toEqual({ decision: 'deny', ref: null })
    expect(parsePermissionReply('不允许')).toEqual({ decision: 'deny', ref: null })
  })
  it('两位数码:「y 07」「y07」「Y 7」都是 07', () => {
    expect(parsePermissionReply('y 07')).toEqual({ decision: 'allow', ref: { kind: 'code', value: '07' } })
    expect(parsePermissionReply('y07')).toEqual({ decision: 'allow', ref: { kind: 'code', value: '07' } })
    expect(parsePermissionReply('Y 7')).toEqual({ decision: 'allow', ref: { kind: 'code', value: '07' } })
    expect(parsePermissionReply('n 12')).toEqual({ decision: 'deny', ref: { kind: 'code', value: '12' } })
  })
  it('旧的 5 位 hash 仍认(桌面卡片、老截图)', () => {
    expect(parsePermissionReply('y abc12')).toEqual({ decision: 'allow', ref: { kind: 'hash', value: 'abc12' } })
    expect(parsePermissionReply('  N xyz99  ')).toEqual({ decision: 'deny', ref: { kind: 'hash', value: 'xyz99' } })
  })
  it('日常用语不算拍板:「好」「不」「yes please」「y abc」都不认', () => {
    expect(parsePermissionReply('好')).toBeNull()
    expect(parsePermissionReply('不')).toBeNull()
    expect(parsePermissionReply('yes please')).toBeNull()
    expect(parsePermissionReply('n abc')).toBeNull()
    expect(parsePermissionReply('hello world')).toBeNull()
  })
})

describe('hashOfQuote:主人引用卡片回「y」', () => {
  it('引用原文里有两位数码 → 按码;有旧 hash → 按 hash', () => {
    const p = new PendingPermissions()
    void p.register('abc12', 60_000, { chatId: 'o', prompt: 'Bash: run 12 tests' })
    void p.register('h2', 60_000, { chatId: 'o', prompt: 'Write: notes.md' })
    expect(p.hashOfQuote('Write: notes.md\n回「y」放行、「n」拒绝;同时有几条待批时带码:「y 02」。60 秒内有效。')).toBe('h2')
    expect(p.hashOfQuote('老卡片\n回「y abc12」放行')).toBe('abc12')
    // 正文里的「run 12」不是码 12;这条引用按首行认回 abc12
    expect(p.hashOfQuote('Bash: run 12 tests')).toBe('abc12')
  })
  it('引用被截断只剩正文 → 按 prompt 首行认;对上多条或对不上 → null', () => {
    const p = new PendingPermissions()
    void p.register('h1', 60_000, { chatId: 'o', prompt: '✋ claude 等你批准 · wechat-cc · 会话 abc123\nBash: rm -rf ./tmp' })
    void p.register('h2', 60_000, { chatId: 'o', prompt: '✋ codex 等你批准 · hearth · 会话 9f0e1d\nEdit: a.ts' })
    expect(p.hashOfQuote('✋ claude 等你批准 · wechat-cc · 会话 abc123')).toBe('h1')
    expect(p.hashOfQuote('✋ codex 等你批准 · hearth · 会话 9f0e1d\nEdit: a.ts')).toBe('h2')
    expect(p.hashOfQuote('随便一条别的消息')).toBeNull()
    void p.register('h3', 60_000, { chatId: 'o', prompt: '✋ claude 等你批准 · wechat-cc · 会话 abc123\nBash: ls' })
    expect(p.hashOfQuote('✋ claude 等你批准 · wechat-cc · 会话 abc123')).toBeNull()   // 两条同首行,不猜
    expect(p.hashOfQuote('')).toBeNull()
  })
})


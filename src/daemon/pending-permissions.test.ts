import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PendingPermissions, parsePermissionReply } from './pending-permissions'

describe('PendingPermissions', () => {
  it('parses only rejection replies with an optional reason and forwards it to the acknowledged card', async () => {
    expect(parsePermissionReply('n 07 不要 SSH\n只在本机')).toEqual({decision:'deny',ref:{kind:'code',value:'07'},reason:'不要 SSH\n只在本机'})
    expect(parsePermissionReply('n07 原因')).toEqual({decision:'deny',ref:{kind:'code',value:'07'},reason:'原因'})
    expect(parsePermissionReply('y 07 原因')).toBeNull()
    expect(parsePermissionReply('yt 07 原因')).toBeNull()
    expect(parsePermissionReply('n 07 '+'x'.repeat(2001))).toBeNull()
    const reg=new PendingPermissions(),decide=vi.fn(()=>true)
    const answer=reg.register('reason',1000,{chatId:'owner',prompt:'p'},undefined,undefined,decide)
    expect(reg.consume('reason','deny',' 不要 SSH ')).toBe(true)
    expect(decide).toHaveBeenCalledExactlyOnceWith('deny','不要 SSH')
    expect(await answer).toBe('deny');expect(reg.consume('reason','deny','again')).toBe(false)
  })
  it('uses the workbench deadline so network pause freezes both expiry and code consumption', async () => {
    const reg=new PendingPermissions();let deadline:number|null=Date.now()+1000
    const task=reg.register('paused',1000,{chatId:'owner',prompt:'p'},undefined,()=>deadline)
    deadline=null;vi.advanceTimersByTime(5000);reg.sweep();expect(reg.size()).toBe(1)
    deadline=Date.now()+500;expect(reg.consume('paused','allow')).toBe(true);expect(await task).toBe('allow')
    const expired=reg.register('expired',1000,{chatId:'owner',prompt:'p'},undefined,()=>Date.now()-1)
    expect(reg.consume('expired','allow')).toBe(false);expect(await expired).toBe('timeout')
  })
  it('yt codes are explicit task permission; ordinary cards cannot acquire it', async () => {
    expect(parsePermissionReply('yt 07')).toEqual({ decision: 'allow_task', ref: { kind: 'code', value: '07' } })
    expect(parsePermissionReply('yt')).toEqual({ decision: 'allow_task', ref: null })
    const reg = new PendingPermissions(), approved = vi.fn(() => true)
    const plain = reg.register('plain', 10_000, { chatId: 'owner', prompt: 'p' })
    expect(reg.consume('plain', 'allow_task')).toBe(false)
    reg.consume('plain', 'deny'); expect(await plain).toBe('deny')
    const task = reg.register('task', 10_000, { chatId: 'owner', prompt: 'p', canAllowTask: true }, approved)
    expect(reg.list()[0]?.canAllowTask).toBe(true)
    expect(reg.consume('task', 'allow_task')).toBe(true)
    expect(approved).toHaveBeenCalledTimes(1); expect(await task).toBe('allow')
    expect(reg.consume('task', 'allow_task')).toBe(false)
    const changed = reg.register('changed', 10_000, { chatId: 'owner', prompt: 'p', canAllowTask: true }, () => false)
    expect(reg.consume('changed', 'allow_task')).toBe(false); expect(await changed).toBe('deny')
  })
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('onChange:开一条、批 / 拒 / 过期 / 没送到 / 被同 id 顶掉都戳一次(S5:桌宠订的 presence 主题据此重算待批卡)', () => {
    const onChange = vi.fn()
    const reg = new PendingPermissions(undefined, onChange)
    void reg.register('a', 10_000); expect(onChange).toHaveBeenCalledTimes(1)
    void reg.register('a', 10_000); expect(onChange).toHaveBeenCalledTimes(3)   // 旧的按超时了结 + 新开一条
    reg.consume('a', 'allow'); expect(onChange).toHaveBeenCalledTimes(4)
    expect(reg.consume('a', 'allow')).toBe(false); expect(onChange).toHaveBeenCalledTimes(4)   // 不在了 ⇒ 不戳
    void reg.register('b', 10); reg.fail('b'); expect(onChange).toHaveBeenCalledTimes(6)
    void reg.register('c', 10); vi.advanceTimersByTime(20); reg.sweep(); expect(onChange).toHaveBeenCalledTimes(8)
    const boom = new PendingPermissions(undefined, () => { throw new Error('x') })
    expect(() => boom.register('d', 10)).not.toThrow()
  })

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

  // 2026-10-10 评审:同一个 hash 再登记(gemini 重开会话后 seq 从 1 重来、Claude 缺 toolUseID 时都落到同一个 id)
  // 原先直接覆盖 ⇒ 旧的那条 promise 永远不 resolve(调用方一直挂着),主人回的「y」还落到新的那条上。
  it('registering an id that is still pending first settles the old one as timeout', async () => {
    const reg = new PendingPermissions()
    const old = reg.register('dup01', 60_000)
    const fresh = reg.register('dup01', 60_000)
    await expect(old).resolves.toBe('timeout')
    expect(reg.consume('dup01', 'allow')).toBe(true)
    await expect(fresh).resolves.toBe('allow')
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


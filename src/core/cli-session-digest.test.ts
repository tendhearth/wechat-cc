import { describe, it, expect } from 'vitest'
import { formatCliSessionDigest, relativeTime, replyRefOf, withReplyRefs, cliSourceLabel, CLI_DIGEST_MAX_ROWS, type CliDigestView } from './cli-session-digest'

const NOW = 1_800_000_000_000
const MIN = 60_000
const view = (over: Partial<CliDigestView> = {}): CliDigestView => ({
  session_id: 'ab12c3-0000', code: 'ab12c3', source: 'claude', status: 'idle', stale: false,
  project: 'wechat-cc', cwd: '/w/wechat-cc', machine: 'here', origin_agent: null,
  last_summary: null, last_event_at: NOW - 5 * MIN, last_prompt_at: null, created_at: NOW - 60 * MIN, pending: null, ...over,
})
const waiting = (over: Partial<CliDigestView> = {}, pending: Partial<NonNullable<CliDigestView['pending']>> = {}): CliDigestView =>
  view({ status: 'waiting', last_event_at: NOW - MIN, pending: { tool: 'Bash', summary: 'rm -rf dist', since: NOW - 2 * MIN, hash: 'k3x9z', reply_code: '07', ...pending }, ...over })

describe('relativeTime', () => {
  it('刚刚 / 分钟 / 小时 / 昨天 / 天', () => {
    expect(relativeTime(NOW - 10_000, NOW)).toBe('刚刚')
    expect(relativeTime(NOW - 3 * MIN, NOW)).toBe('3 分钟前')
    expect(relativeTime(NOW - 125 * MIN, NOW)).toBe('2 小时前')
    expect(relativeTime(NOW - 30 * 60 * MIN, NOW)).toBe('昨天')
    expect(relativeTime(NOW - 5 * 24 * 60 * MIN, NOW)).toBe('5 天前')
    expect(relativeTime(NOW + 5000, NOW)).toBe('刚刚')   // 时钟略超前不出负数
  })
})

describe('withReplyRefs', () => {
  it('只给等批准的补码;中继没开码 / 读码抛错 ⇒ null;不等批准的原样', () => {
    const plain = view()
    const w = (id: string) => waiting({ session_id: id }, { hash: undefined, reply_code: undefined })
    const out = withReplyRefs([w('a'), w('b'), w('boom'), plain],
      (id) => { if (id === 'boom') throw new Error('x'); return id === 'a' ? 'k3x9z' : null },
      (h) => h === 'k3x9z' ? '07' : null)
    expect(out[0]!.pending).toMatchObject({ hash: 'k3x9z', reply_code: '07', tool: 'Bash' })
    expect(out[1]!.pending).toMatchObject({ hash: null, reply_code: null })
    expect(out[2]!.pending).toMatchObject({ hash: null, reply_code: null })
    expect(out[3]).toBe(plain)
  })
})

describe('replyRefOf / cliSourceLabel', () => {
  it('两位数码优先,其次 5 位码;没开码 ⇒ null', () => {
    expect(replyRefOf(waiting())).toBe('07')
    expect(replyRefOf(waiting({}, { reply_code: null }))).toBe('k3x9z')
    expect(replyRefOf(waiting({}, { reply_code: null, hash: null }))).toBeNull()
    expect(replyRefOf(view())).toBeNull()
    expect(cliSourceLabel('claude')).toBe('Claude Code')
    expect(cliSourceLabel('codex')).toBe('Codex')
    expect(cliSourceLabel('cursor')).toBe('Cursor')
  })
})

describe('formatCliSessionDigest', () => {
  it('没有会话 ⇒ 说清楚怎么让它们出现', () => {
    const t = formatCliSessionDigest([], { now: NOW })
    expect(t).toContain('终端里现在没有会话')
    expect(t).toContain('wechat-cc hook install')
    expect(formatCliSessionDigest([view({ status: 'ended' })], { now: NOW })).toContain('没有会话')
  })

  it('等你批准在前、带怎么回;在跑 / 做完了带最后一句与相对时间;页脚提示看码 / @码', () => {
    const t = formatCliSessionDigest([
      waiting(),
      view({ session_id: '9f8e7d-1', code: '9f8e7d', source: 'codex', status: 'running', project: 'melu', last_event_at: NOW - 3 * MIN }),
      view({ session_id: '1a2b3c-1', code: '1a2b3c', project: 'leni', last_event_at: NOW - 125 * MIN, last_summary: '登录页改好了,\n\n测试也过了' }),
    ], { now: NOW, localMachine: 'here' })
    expect(t.split('\n')).toEqual([
      '终端里 3 个会话(1 个等你批准、1 个在跑):',
      '· 等你批准 · wechat-cc · Claude Code · 码 ab12c3 · 2 分钟前',
      '   Bash: rm -rf dist',
      '   —— 回「y 07」放行、「n 07」拒绝',
      '· 在跑 · melu · Codex · 码 9f8e7d · 3 分钟前',
      '· 做完了 · leni · Claude Code · 码 1a2b3c · 2 小时前',
      '   登录页改好了, 测试也过了',
      '「看 码」看最近的对话,「@码 话」接着说一句',
    ])
  })

  it('等批准但没开码(主人在场、终端自己在问)⇒ 不给 y/n,说回终端处理;hook 的占位 tool 不显示', () => {
    const t = formatCliSessionDigest([waiting({}, { tool: 'permission', summary: '要改 package.json', hash: null, reply_code: null })], { now: NOW })
    expect(t).toContain('   要改 package.json')
    expect(t).not.toContain('permission:')
    expect(t).toContain('终端那边在问,回终端处理')
    expect(t).not.toMatch(/「y /)
  })

  it('那边的机器写出来;stale 写「没动静了」;长摘要截断', () => {
    const t = formatCliSessionDigest([
      view({ machine: 'WIN-PC', status: 'idle', stale: true, last_summary: 'x'.repeat(200) }),
    ], { now: NOW, localMachine: 'here' })
    expect(t).toContain('没动静了 · wechat-cc · 那边(WIN-PC) · Claude Code')
    expect(t).toContain('x'.repeat(59) + '…')
    expect(t).not.toContain('x'.repeat(61))
  })

  it(`最多 ${CLI_DIGEST_MAX_ROWS} 条,多的写「还有 N 个」`, () => {
    const many = Array.from({ length: 11 }, (_, i) => view({ session_id: `s${i}`, code: `s${i}`, last_event_at: NOW - i * MIN }))
    const t = formatCliSessionDigest(many, { now: NOW })
    expect(t.split('\n').filter(l => l.startsWith('· ')).length).toBe(CLI_DIGEST_MAX_ROWS)
    expect(t).toContain('(还有 3 个没列出)')
    expect(formatCliSessionDigest(many, { now: NOW, max: 2 })).toContain('(还有 9 个没列出)')
  })
})

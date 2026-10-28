import { describe, it, expect } from 'vitest'
import { parseCliReply, resumeCommand } from './cli-reply'

describe('parseCliReply', () => {
  it('看 码 / @码 文本;大小写与空白宽容;别的都不是', () => {
    expect(parseCliReply('看 a1b2c3')).toEqual({ kind: 'view', code: 'a1b2c3' })
    expect(parseCliReply('看A1B2')).toEqual({ kind: 'view', code: 'a1b2' })
    expect(parseCliReply('@a1b2c3 改成 X 再跑\n第二行')).toEqual({ kind: 'say', code: 'a1b2c3', text: '改成 X 再跑\n第二行' })
    expect(parseCliReply('看看这个')).toBeNull()
    expect(parseCliReply('@a1b2c3')).toBeNull()
    expect(parseCliReply('看 abc')).toBeNull()
    expect(parseCliReply('y k3x9z')).toBeNull()
  })

  it('「终端」列会话:只认整句的几种说法,可带问号;不认单独的「会话」与夹在句子里的', () => {
    for (const t of ['终端', ' 终端 ', '终端?', '终端？', '终端会话', '终端列表', '看终端', '看看终端', '看终端会话', '会话列表', '/cli', '/CLI'])
      expect(parseCliReply(t)).toEqual({ kind: 'list' })
    for (const t of ['会话', '终端里那几个在干嘛', '打开终端', '终端怎么用', '帮我开个终端', '看 终端x', 'cli'])
      expect(parseCliReply(t)).toBeNull()
  })

  it('「日报」:只认整句的几种说法,可带问号;不认「今天」「今天怎么样」(日常回答 / 寒暄,句尾「怎么样」归管家)', () => {
    for (const t of ['日报', ' 日报 ', '日报?', '日报？', '今天日报', '今日日报', '看日报', '看看日报', '看今天日报', '/today', '/TODAY'])
      expect(parseCliReply(t)).toEqual({ kind: 'today' })
    for (const t of ['今天', '今天怎么样', '今天怎么样?', '今天呢', '写个日报', '日报模板发我', '帮我写今天的日报', 'today', '/today x'])
      expect(parseCliReply(t)).toBeNull()
  })
})

describe('resumeCommand', () => {
  it('claude:-p --resume;codex:exec resume;dangerously 各自的旗子', () => {
    expect(resumeCommand('claude', 'sid', '继续', false)).toEqual({ cmd: 'claude', args: ['-p', '--resume', 'sid', '--', '继续'] })
    expect(resumeCommand('claude', 'sid', '继续', true).args).toContain('--dangerously-skip-permissions')
    expect(resumeCommand('codex', 'tid', '继续', false)).toEqual({ cmd: 'codex', args: ['exec', '--skip-git-repo-check', 'resume', '--', 'tid', '继续'] })
    // 以 - 开头的话不能被当成 CLI 选项(评审 10-15 #4)
    const c = resumeCommand('claude', 'sid', '--help', true).args
    expect(c.indexOf('--')).toBeLessThan(c.indexOf('--help'))
    expect(c.indexOf('--dangerously-skip-permissions')).toBeLessThan(c.indexOf('--'))
    expect(resumeCommand('codex', 'tid', '继续', true).args).toContain('--dangerously-bypass-approvals-and-sandbox')
  })
  it('cursor:cursor-agent --resume=<id> -p --trust [--force] -- 话;以 - 开头的话不会被当成选项', () => {
    expect(resumeCommand('cursor', 'conv-1', '继续', false)).toEqual({ cmd: 'cursor-agent', args: ['--resume=conv-1', '-p', '--trust', '--', '继续'] })
    expect(resumeCommand('cursor', 'conv-1', '继续', true)).toEqual({ cmd: 'cursor-agent', args: ['--resume=conv-1', '-p', '--trust', '--force', '--', '继续'] })
    const a = resumeCommand('cursor', '-weird', '--help', false).args
    expect(a[0]).toBe('--resume=-weird')
    expect(a.indexOf('--')).toBe(a.length - 2)
    expect(a[a.length - 1]).toBe('--help')
  })
})

describe('resumeCommand × resolved binary (device-e2e 10-20)', () => {
  it('claude resume uses the resolved binary when given', () => {
    expect(resumeCommand('claude', 'sid', 'hi', false, { claude: '/Users/u/.local/bin/claude' }).cmd).toBe('/Users/u/.local/bin/claude')
    expect(resumeCommand('claude', 'sid', 'hi', false).cmd).toBe('claude')
    expect(resumeCommand('codex', 'sid', 'hi', false, { claude: '/x' }).cmd).toBe('codex')
  })
})

// 重构第二批步 3a(§1.5 bug 3):会话码是会话 id 的前 6 位(cli-session-store.ts),只有 0-9a-f。
// 以前 [a-z0-9] 都认 ⇒ 主人写「@codex 帮我看看」「@claude 你觉得呢」「看 README」被当成会话码,回「没见过会话码」。
describe('会话码只认十六进制', () => {
  it('@codex / @claude / 看 README 不是会话命令;@a1b2c3 / 看 ab12 仍然是', () => {
    for (const t of ['@codex 帮我看看这个函数', '@claude 你觉得呢', '@cursor 改一下', '看 README', '看 readme', '@hello 你好'])
      expect(parseCliReply(t), t).toBeNull()
    expect(parseCliReply('@a1b2c3 继续')).toEqual({ kind: 'say', code: 'a1b2c3', text: '继续' })
    expect(parseCliReply('看 AB12CD')).toEqual({ kind: 'view', code: 'ab12cd' })
    // 评审 #473:码固定 6 位(8 位以上留给粘贴长 id);全是 a-f 的英文词不是码
    for (const t of ['看 face', '@dead 你说呢', '@beef 帮我看看', '看 cafe', '@abcde 嗯']) expect(parseCliReply(t), t).toBeNull()
    // 前缀查找仍然可用:短的带数字、6 位及以上随意
    expect(parseCliReply('看 ab12')).toEqual({ kind: 'view', code: 'ab12' })
    expect(parseCliReply('@a1b2c3d 继续')).toEqual({ kind: 'say', code: 'a1b2c3d', text: '继续' })
    expect(parseCliReply('@abcdef 继续')).toEqual({ kind: 'say', code: 'abcdef', text: '继续' })
  })
})

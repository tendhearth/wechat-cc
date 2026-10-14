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
    expect(resumeCommand('claude', 'sid', '继续', false)).toEqual({ cmd: 'claude', args: ['-p', '--resume', 'sid', '继续'] })
    expect(resumeCommand('claude', 'sid', '继续', true).args).toContain('--dangerously-skip-permissions')
    expect(resumeCommand('codex', 'tid', '继续', false)).toEqual({ cmd: 'codex', args: ['exec', '--skip-git-repo-check', 'resume', 'tid', '继续'] })
    expect(resumeCommand('codex', 'tid', '继续', true).args).toContain('--dangerously-bypass-approvals-and-sandbox')
  })
})

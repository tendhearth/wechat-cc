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
})

describe('resumeCommand', () => {
  it('claude:-p --resume;codex:exec resume;dangerously 各自的旗子', () => {
    expect(resumeCommand('claude', 'sid', '继续', false)).toEqual({ cmd: 'claude', args: ['-p', '--resume', 'sid', '继续'] })
    expect(resumeCommand('claude', 'sid', '继续', true).args).toContain('--dangerously-skip-permissions')
    expect(resumeCommand('codex', 'tid', '继续', false)).toEqual({ cmd: 'codex', args: ['exec', '--skip-git-repo-check', 'resume', 'tid', '继续'] })
    expect(resumeCommand('codex', 'tid', '继续', true).args).toContain('--dangerously-bypass-approvals-and-sandbox')
  })
})

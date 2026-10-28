import { describe, it, expect } from 'vitest'
import { composeOutcome, composeOutcomeDot, composeOutcomeText } from './compose'
import { UNTIL_COMMAND_MAX, clampRounds, untilConfirmation, untilDraftError, untilLine, untilRequest } from './until'

const on = { isolated: true, unattended: false }

describe('untilRequest:只在独立工作区、填了、执行者不免审时带', () => {
  it('trim 后的原文 + 轮数', () => {
    expect(untilRequest({ command: '  bun run test  ', maxRounds: 3 }, on)).toEqual({ command: 'bun run test', maxRounds: 3 })
  })
  it('没开独立工作区 / 免审 / 空 ⇒ 不带', () => {
    expect(untilRequest({ command: 'bun run test', maxRounds: 3 }, { isolated: false, unattended: false })).toBeUndefined()
    expect(untilRequest({ command: 'bun run test', maxRounds: 3 }, { isolated: true, unattended: true })).toBeUndefined()
    expect(untilRequest({ command: '   ', maxRounds: 3 }, on)).toBeUndefined()
  })
  it('格式不对 ⇒ 不带(页面锁住提交)', () => {
    expect(untilDraftError('a\nb')).toBe('multiline')
    expect(untilRequest({ command: 'a\nb', maxRounds: 3 }, on)).toBeUndefined()
    expect(untilDraftError('x'.repeat(UNTIL_COMMAND_MAX + 1))).toBe('tooLong')
    expect(untilRequest({ command: 'x'.repeat(UNTIL_COMMAND_MAX + 1), maxRounds: 3 }, on)).toBeUndefined()
    expect(untilDraftError('')).toBeNull()
  })
  it('300 字按字符算(与 daemon 的 [...s].length 一致)', () => {
    expect(untilDraftError('测'.repeat(300))).toBeNull()
    expect(untilDraftError('😀'.repeat(300))).toBeNull()
    expect(untilDraftError('😀'.repeat(301))).toBe('tooLong')
  })
  it('轮数夹在 1–10', () => {
    expect(clampRounds(0)).toBe(1)
    expect(clampRounds(11)).toBe(10)
    expect(untilRequest({ command: 'x', maxRounds: 42 }, on)?.maxRounds).toBe(10)
  })
})

describe('untilConfirmation:提交前整条显示的命令 = 带出去的那条', () => {
  it('300 字的命令逐字在确认块里,不截断、不加省略号', () => {
    const head = 'cd pkg && bun run test -- --grep "a b" | tee /tmp/out; '
    const long = head + 'x/y_z'.repeat(60).slice(0, UNTIL_COMMAND_MAX - head.length - 1) + 'Z'
    expect([...long].length).toBe(UNTIL_COMMAND_MAX)
    const spec = untilRequest({ command: long, maxRounds: 4 }, on)!
    expect(spec.command).toBe(long.trim())
    for (const lang of ['zh-Hans', 'en'] as const) {
      const c = untilConfirmation(spec, lang)
      expect(c.command).toBe(spec.command)
      expect(c.command).not.toMatch(/…|\.\.\.$/)
      expect(c.accessibilityLabel).toContain(spec.command)
    }
    expect(untilConfirmation(spec, 'zh-Hans').rounds).toBe('最多 4 轮')
  })
  it('说明那句照设计稿', () => {
    expect(untilConfirmation({ command: 'x', maxRounds: 3 }, 'zh-Hans').note).toBe('每轮做完，CC 在这件事自己的独立工作区里跑一次这条命令；没开放行规则时，执行者每一步照样要你点。')
    expect(untilConfirmation({ command: 'x', maxRounds: 3 }, 'en').note).toMatch(/separate workspace/)
  })
})

describe('untilLine:任务详情那两行', () => {
  type U = Parameters<typeof untilLine>[0]
  const u: U = { command: 'bun run test', maxRounds: 3, rounds: 0, status: 'active', lastExit: null, stopReason: null }
  const st = (x: Partial<U>, lang: 'zh-Hans' | 'en' = 'zh-Hans') => untilLine({ ...u, ...x }, lang).status
  it('进行中:写清哪一轮没过、哪一轮在改', () => {
    expect(st({})).toBe('第 1/3 轮在做，还没检查')
    expect(st({ rounds: 1, lastExit: 1 })).toBe('第 1 轮没过，第 2/3 轮在改')
    expect(st({ rounds: 2, lastExit: 1 }, 'en')).toBe("Round 2 didn't pass; working on round 3/3")
  })
  it('结束了:结果在前', () => {
    expect(st({ rounds: 2, status: 'passed', lastExit: 0 })).toBe('通过了（第 2/3 轮）')
    expect(st({ rounds: 3, status: 'exhausted', lastExit: 1 })).toBe('到上限还没过（3 轮）')
    expect(st({ rounds: 1, status: 'stopped', stopReason: '这件事归档了' })).toBe('停了（这件事归档了）')
    expect(st({ rounds: 0, status: 'stopped' })).toBe('停了')
  })
  it('命令那一行与状态分开:300 字命令不进状态行,结果不会被省略号吃掉;读屏拿到整句', () => {
    const cmd = 'x'.repeat(300)
    const l = untilLine({ ...u, command: cmd, rounds: 3, status: 'exhausted' }, 'zh-Hans')
    expect(l.status).toBe('到上限还没过（3 轮）')
    expect(l.status).not.toContain('x')
    expect(`${l.before}${l.command}${l.after}`).toBe(`直到 ${cmd} 通过`)
    expect(l.accessibilityLabel).toContain(cmd)
    expect(l.accessibilityLabel.startsWith('到上限还没过')).toBe(true)
  })
})

describe('交办失败码里的 until 三条', () => {
  it('各有一句,中英文都有', () => {
    expect(composeOutcome('until_invalid')).toBe('untilInvalid')
    expect(composeOutcome('until_requires_worktree')).toBe('untilNeedsWorktree')
    expect(composeOutcome('until_unattended')).toBe('untilUnattended')
    for (const o of ['untilInvalid', 'untilNeedsWorktree', 'untilUnattended'] as const) {
      expect(composeOutcomeDot(o)).toBe('bad')
      for (const lang of ['zh-Hans', 'en'] as const) expect(composeOutcomeText(o, lang, null, false)).not.toBe(composeOutcomeText('refused', lang, null, false))
    }
    expect(composeOutcomeText('untilNeedsWorktree', 'zh-Hans', null, false)).toContain('独立工作区')
  })
})

import { describe, expect, it } from 'vitest'

import { claudeArgs, makeClaudeRunner, parseClaudeJson, runnerEnv, type RunnerInput } from './runner'

const base: RunnerInput = { cwd: '/tmp/repo', prompt: '做点事', budgetUsd: 20, maxTurns: 300 }

describe('claudeArgs', () => {
  it('最朴素的一轮:固定头 + 预算 + 轮数 + 需求在最后', () => {
    expect(claudeArgs(base)).toEqual([
      '-p', '--output-format', 'json', '--dangerously-skip-permissions',
      '--max-budget-usd', '20', '--max-turns', '300',
      '做点事',
    ])
  })

  it('修复轮:--resume 接在固定头后面,需求仍在最后', () => {
    const args = claudeArgs({ ...base, resume: 'sess-1' })
    expect(args).toContain('--resume')
    expect(args[args.indexOf('--resume') + 1]).toBe('sess-1')
    expect(args.at(-1)).toBe('做点事')
  })

  it('实现轮:--append-system-prompt-file 带上交代文件', () => {
    const args = claudeArgs({ ...base, systemPromptFile: '/w/briefs/ab12.md' })
    expect(args[args.indexOf('--append-system-prompt-file') + 1]).toBe('/w/briefs/ab12.md')
    expect(args).not.toContain('--disallowedTools')
  })

  it('评审轮:readOnly 关掉四把写工具', () => {
    const args = claudeArgs({ ...base, readOnly: true })
    expect(args[args.indexOf('--disallowedTools') + 1]).toBe('Edit,Write,MultiEdit,NotebookEdit')
  })

  it('四样都给时顺序稳定', () => {
    expect(claudeArgs({ ...base, resume: 's', systemPromptFile: '/b.md', readOnly: true })).toEqual([
      '-p', '--output-format', 'json', '--dangerously-skip-permissions',
      '--max-budget-usd', '20', '--max-turns', '300',
      '--resume', 's',
      '--append-system-prompt-file', '/b.md',
      '--disallowedTools', 'Edit,Write,MultiEdit,NotebookEdit',
      '做点事',
    ])
  })
})

describe('runnerEnv', () => {
  it('摘掉嵌套守卫的两个变量和 daemon 凭据,留下 PATH / HOME', () => {
    const env = runnerEnv({
      PATH: '/usr/bin', HOME: '/Users/me',
      CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli',
      WECHAT_CC_STATE_DIR: '/s', HEARTH_TOKEN: 'secret',
    })
    expect(env.PATH).toBe('/usr/bin')
    expect(env.HOME).toBe('/Users/me')
    expect(env.CLAUDECODE).toBeUndefined()
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined()
    expect(env.WECHAT_CC_STATE_DIR).toBeUndefined()
    expect(env.HEARTH_TOKEN).toBeUndefined()
  })

  it('不改调用方传进来的那份 env', () => {
    const src = { CLAUDECODE: '1' }
    runnerEnv(src)
    expect(src.CLAUDECODE).toBe('1')
  })
})

describe('parseClaudeJson', () => {
  const payload = { session_id: 's1', result: '改完了', total_cost_usd: 1.5, num_turns: 7, is_error: false, subtype: 'success' }

  it('前面有噪声行时取最后一个能解析的行', () => {
    const out = `warning: something\n[plugin] loaded\n${JSON.stringify(payload)}\n`
    expect(parseClaudeJson(out)).toEqual({ sessionId: 's1', text: '改完了', costUsd: 1.5, turns: 7, isError: false, subtype: 'success' })
  })

  it('整份 stdout 就是一份(多行的)JSON 时也认', () => {
    expect(parseClaudeJson(JSON.stringify(payload, null, 2))?.sessionId).toBe('s1')
  })

  it('没有 JSON ⇒ null', () => {
    expect(parseClaudeJson('command not found: claude\n')).toBeNull()
  })

  it('能解析但不是对象的行(数字 / 字符串)不算', () => {
    expect(parseClaudeJson('42\n"hello"\n')).toBeNull()
  })

  it('字段缺失时给出安全缺省', () => {
    expect(parseClaudeJson('{}')).toEqual({ sessionId: null, text: '', costUsd: 0, turns: 0, isError: false, subtype: null })
  })
})

interface SpawnCall { cmd: string; args: string[]; opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number } }

function fakeSpawn(result: { code: number | null; stdout: string; stderr: string } | Error) {
  const calls: SpawnCall[] = []
  const spawn = async (cmd: string, args: string[], opts: SpawnCall['opts']) => {
    calls.push({ cmd, args, opts })
    if (result instanceof Error) throw result
    return result
  }
  return { calls, spawn }
}

describe('makeClaudeRunner', () => {
  const ok = JSON.stringify({ session_id: 's9', result: '做完了', total_cost_usd: 2.25, num_turns: 11, is_error: false, subtype: 'success' })

  it('成功路径:字段逐个映射,cwd / env / 二进制都传下去', async () => {
    const { calls, spawn } = fakeSpawn({ code: 0, stdout: `noise\n${ok}`, stderr: '' })
    const runner = makeClaudeRunner({ spawn, env: { PATH: '/usr/bin', CLAUDECODE: '1' }, claudeBin: '/opt/claude' })
    const r = await runner.run({ ...base, timeoutMs: 1000 })
    expect(r).toEqual({ ok: true, sessionId: 's9', text: '做完了', costUsd: 2.25, turns: 11, stderrTail: [] })
    expect(calls[0]!.cmd).toBe('/opt/claude')
    expect(calls[0]!.opts.cwd).toBe('/tmp/repo')
    expect(calls[0]!.opts.timeoutMs).toBe(1000)
    expect(calls[0]!.opts.env.CLAUDECODE).toBeUndefined()
  })

  it('缺省二进制是 claude', async () => {
    const { calls, spawn } = fakeSpawn({ code: 0, stdout: ok, stderr: '' })
    await makeClaudeRunner({ spawn, env: {} }).run(base)
    expect(calls[0]!.cmd).toBe('claude')
  })

  it('非零退出 ⇒ ok:false,error 带上退出码,stderr 尾巴只留 200 行', async () => {
    const stderr = Array.from({ length: 250 }, (_, i) => `line ${i}`).join('\n')
    const { spawn } = fakeSpawn({ code: 1, stdout: 'boom', stderr })
    const r = await makeClaudeRunner({ spawn, env: {} }).run(base)
    expect(r.ok).toBe(false)
    expect(r.error).toBe('claude_exit_1')
    expect(r.stderrTail).toHaveLength(200)
    expect(r.stderrTail.at(-1)).toBe('line 249')
    expect(r.text).toContain('boom')
  })

  it('claude 自己报错(is_error / subtype)⇒ ok:false,error 用 subtype,正文照带', async () => {
    const stdout = JSON.stringify({ session_id: 's3', result: '超预算了', total_cost_usd: 20, num_turns: 99, is_error: true, subtype: 'error_max_budget' })
    const { spawn } = fakeSpawn({ code: 0, stdout, stderr: '' })
    const r = await makeClaudeRunner({ spawn, env: {} }).run(base)
    expect(r).toMatchObject({ ok: false, error: 'error_max_budget', sessionId: 's3', text: '超预算了', costUsd: 20 })
  })

  it('超时被杀(code 为 null)⇒ ok:false', async () => {
    const { spawn } = fakeSpawn({ code: null, stdout: '', stderr: 'killed' })
    const r = await makeClaudeRunner({ spawn, env: {} }).run(base)
    expect(r.ok).toBe(false)
    expect(r.error).toBe('claude_exit_null')
  })

  it('spawn 自己抛(claude 不在 PATH 上)⇒ ok:false,原因进 stderrTail', async () => {
    const { spawn } = fakeSpawn(new Error('ENOENT claude'))
    const r = await makeClaudeRunner({ spawn, env: {} }).run(base)
    expect(r).toMatchObject({ ok: false, error: 'claude_spawn_failed', sessionId: null })
    expect(r.stderrTail.join('\n')).toContain('ENOENT claude')
  })
})

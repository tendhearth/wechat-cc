import { describe, expect, it } from 'vitest'

import { DEFAULT_GIT_TIMEOUT_MS, gitEnv, makeGit, type GitSpawnSync } from './git'

type Call = { cmd: string; args: string[]; opts: Parameters<GitSpawnSync>[2] }

function spy(reply: Partial<{ status: number | null; stdout: string; stderr: string; error: Error }> = {}): { spawn: GitSpawnSync; calls: Call[] } {
  const calls: Call[] = []
  return {
    calls,
    spawn: (cmd, args, opts) => {
      calls.push({ cmd, args, opts })
      return { status: reply.status ?? 0, stdout: reply.stdout ?? '', stderr: reply.stderr ?? '', ...(reply.error ? { error: reply.error } : {}) }
    },
  }
}

describe('gitEnv', () => {
  it('继承来的 GIT_* 一个不留(不然每条命令可能打到别人的仓库上)', () => {
    const env = gitEnv({ PATH: '/usr/bin', GIT_DIR: '/someone/else/.git', GIT_INDEX_FILE: '/tmp/idx', HOME: '/h' })
    expect(env.GIT_DIR).toBeUndefined()
    expect(env.GIT_INDEX_FILE).toBeUndefined()
    expect(env.PATH).toBe('/usr/bin')
    expect(env.HOME).toBe('/h')
  })

  it('后台进程不能被分页器 / 凭据提示吊住', () => {
    const env = gitEnv({})
    expect(env.GIT_PAGER).toBe('cat')
    expect(env.GIT_TERMINAL_PROMPT).toBe('0')
    expect(env.LC_ALL).toBe('C')
  })

  // 这些 git 跑在一个执行者刚动过的克隆里,而 .git/config 不在 guard 的管辖内:
  // credential.helper / core.sshCommand / url.*.insteadOf 都能把一条 git push
  // 变成一条命令 —— 而且是在主人看到拍板卡之前。
  it('daemon 的凭据一个不进 git(和 runner / exec 同一条规矩)', () => {
    const env = gitEnv({
      PATH: '/usr/bin',
      WECHAT_TOKEN: 'secret', WECHAT_IPC_KEY: 'k2', HEARTH_KEY: 'k', WXVAULT_TOKEN: 't', WXGRAPH_URL: 'u',
      ANTHROPIC_API_KEY: 'keep', HTTPS_PROXY: 'keep-too',
    })
    expect(Object.keys(env).filter(k => /^(WECHAT_|HEARTH_|WXVAULT_|WXGRAPH_)/i.test(k))).toEqual([])
    // 供应商鉴权和代理照留 —— push 要走网,credential.helper 也要跑起来。
    expect(env.ANTHROPIC_API_KEY).toBe('keep')
    expect(env.HTTPS_PROXY).toBe('keep-too')
  })

  it('全局配置**不能**屏蔽:push 要 credential.helper,commit 要身份', () => {
    const env = gitEnv({})
    expect(env.GIT_CONFIG_GLOBAL).toBeUndefined()
    expect(env.GIT_CONFIG_NOSYSTEM).toBeUndefined()
  })
})

describe('makeGit', () => {
  it('每条命令都带 --no-pager / 关 hook / windowsHide,cwd 可以按次覆盖', () => {
    const { spawn, calls } = spy({ stdout: 'ok\n' })
    const git = makeGit(spawn, '/w/repo', { PATH: '/usr/bin' })
    expect(git.run(['status', '--porcelain'])).toEqual({ code: 0, stdout: 'ok\n', stderr: '' })

    const call = calls[0]!
    expect(call.cmd).toBe('git')
    expect(call.args.slice(0, 2)).toEqual(['--no-pager', '--no-optional-locks'])
    expect(call.args.join(' ')).toContain('core.hooksPath=')
    expect(call.args.slice(-2)).toEqual(['status', '--porcelain'])
    expect(call.opts.cwd).toBe('/w/repo')
    expect(call.opts.windowsHide).toBe(true)
    expect(call.opts.timeout).toBe(DEFAULT_GIT_TIMEOUT_MS)

    git.run(['clone', 'x', 'repo'], { cwd: '/w', timeoutMs: 1000 })
    expect(calls[1]!.opts).toMatchObject({ cwd: '/w', timeout: 1000 })
  })

  it('真正交给 spawnSync 的那份 env 里没有 daemon 凭据', () => {
    const { spawn, calls } = spy()
    makeGit(spawn, '/w/repo', { PATH: '/usr/bin', WECHAT_TOKEN: 'secret', HEARTH_KEY: 'k' }).run(['status'])
    const env = calls[0]!.opts.env
    expect(Object.keys(env).filter(k => k.startsWith('WECHAT_'))).toEqual([])
    expect(env.HEARTH_KEY).toBeUndefined()
    expect(env.PATH).toBe('/usr/bin')
  })

  it('起不来 / 超时(status 为 null)时把原因搬到 stderr 上,不然失败报告是空的', () => {
    const { spawn } = spy({ status: null, error: new Error('ETIMEDOUT') })
    const r = makeGit(spawn, '/w/repo', {}).run(['fetch'])
    expect(r.code).toBeNull()
    expect(r.stderr).toContain('ETIMEDOUT')
  })
})

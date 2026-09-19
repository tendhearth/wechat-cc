import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { makeSelfChangeSpawner, resolveSelfCli } from './self-change-spawn'

describe('resolveSelfCli', () => {
  it('源码模式:bun + <repo>/cli.ts', () => {
    const r = resolveSelfCli({
      compiled: false,
      execPath: '/usr/local/bin/bun',
      repoRoot: '/repo',
      bunPath: '/usr/local/bin/bun',
      exists: (p) => p === join('/repo', 'cli.ts'),
    })
    expect(r).toEqual({ cmd: '/usr/local/bin/bun', args: [join('/repo', 'cli.ts')] })
  })

  it('打包模式:和 execPath 并排的 wechat-cc-cli,不带参数', () => {
    const r = resolveSelfCli({
      compiled: true,
      execPath: '/Applications/wechat-cc.app/Contents/MacOS/wechat-cc-cli',
      repoRoot: '/irrelevant',
      bunPath: null,
      exists: () => true,
    })
    expect(r).toEqual({ cmd: join('/Applications/wechat-cc.app/Contents/MacOS', 'wechat-cc-cli'), args: [] })
  })

  it('源码模式但 cli.ts 不在 ⇒ self_cli_not_found', () => {
    expect(resolveSelfCli({
      compiled: false, execPath: '/x', repoRoot: '/repo', bunPath: '/bun', exists: () => false,
    })).toEqual({ error: 'self_cli_not_found' })
  })

  it('源码模式但 PATH 里没有 bun ⇒ bun_not_found', () => {
    expect(resolveSelfCli({
      compiled: false, execPath: '/x', repoRoot: '/repo', bunPath: null, exists: () => true,
    })).toEqual({ error: 'bun_not_found' })
  })
})

describe('makeSelfChangeSpawner', () => {
  let stateDir: string
  let spawn: ReturnType<typeof vi.fn>
  let unref: ReturnType<typeof vi.fn>
  let log: ReturnType<typeof vi.fn>

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'self-change-spawn-'))
    unref = vi.fn()
    spawn = vi.fn(() => ({ pid: 4242, unref }))
    log = vi.fn()
  })
  afterEach(() => { rmSync(stateDir, { recursive: true, force: true }) })

  function make(overrides: Partial<Parameters<typeof makeSelfChangeSpawner>[0]> = {}) {
    return makeSelfChangeSpawner({
      resolve: () => ({ cmd: '/usr/local/bin/bun', args: ['/repo/cli.ts'] }),
      spawn: spawn as unknown as Parameters<typeof makeSelfChangeSpawner>[0]['spawn'],
      env: { PATH: '/usr/bin', WECHAT_TOKEN: 'secret', HEARTH_KEY: 'k', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', ANTHROPIC_API_KEY: 'keep' },
      stateDir,
      log: log as unknown as (l: string) => void,
      ...overrides,
    })
  }

  it('start 把需求放在 `--` 之后交给 `self change --from wechat --json`', () => {
    const r = make().start('  在手册里加一行  ')
    expect(r).toEqual({ ok: true, pid: 4242 })
    expect(spawn).toHaveBeenCalledOnce()
    const [cmd, args] = spawn.mock.calls[0]!
    expect(cmd).toBe('/usr/local/bin/bun')
    expect(args).toEqual(['/repo/cli.ts', 'self', 'change', '--from', 'wechat', '--json', '--', '在手册里加一行'])
  })

  // `--` 不是装饰:需求是主人在微信里随口说的一句话。少了它,「自改 --unhalt」
  // 会被 citty 解析成开关,**静默解除停机**(退 0、stdio 丢弃,daemon 还回一句
  //「自改开始了」);「自改 -x …」则整句需求丢失,进程以 request_required 退 1。
  it('以 `-` 开头的需求仍然是位置参数,不会变成开关', () => {
    for (const text of ['--unhalt', '-x 把这个删了', '--list']) {
      spawn.mockClear()
      expect(make().start(text).ok).toBe(true)
      const args = spawn.mock.calls[0]![1] as string[]
      expect(args.at(-1)).toBe(text)
      expect(args.at(-2)).toBe('--')
      // 开关只能出现在 `--` 前面那一段。
      expect(args.slice(0, args.indexOf('--'))).not.toContain(text)
    }
  })

  it('start 是 detached / stdio ignore / windowsHide,并且 unref 了', () => {
    make().start('x')
    const opts = spawn.mock.calls[0]![2] as Record<string, unknown>
    expect(opts.detached).toBe(true)
    expect(opts.stdio).toBe('ignore')
    expect(opts.windowsHide).toBe(true)
    expect(unref).toHaveBeenCalledOnce()
  })

  it('子进程环境里没有 daemon 凭据,也没有 Claude Code 的在场标记', () => {
    make().start('x')
    const env = (spawn.mock.calls[0]![2] as { env: Record<string, string | undefined> }).env
    expect(Object.keys(env).filter(k => k.startsWith('WECHAT_'))).toEqual([])
    expect(env.HEARTH_KEY).toBeUndefined()
    // 流水线里要 spawn `claude -p`,带着这两个进去会被当成嵌套会话拒掉。
    expect(env.CLAUDECODE).toBeUndefined()
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined()
    // 供应商鉴权照留 —— 执行者要用。
    expect(env.ANTHROPIC_API_KEY).toBe('keep')
  })

  it('解析不出命令行 ⇒ 不 spawn,给一句人能看懂的理由', () => {
    const r = make({ resolve: () => ({ error: 'bun_not_found' }) }).start('x')
    expect(r.ok).toBe(false)
    expect((r as { reason: string }).reason).toContain('bun')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('spawn 抛异常 ⇒ 返回失败而不是把 daemon 掀翻', () => {
    const r = make({ spawn: (() => { throw new Error('ENOENT') }) as never }).start('x')
    expect(r).toEqual({ ok: false, reason: 'ENOENT' })
  })

  it('空需求不起进程', () => {
    expect(make().start('   ').ok).toBe(false)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('list 按 startedAt 倒序读状态目录,坏文件跳过', () => {
    const dir = join(stateDir, 'self-change')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'aaa.json'), JSON.stringify({ id: 'aaa', step: 'done', result: 'merged', startedAt: 100 }))
    writeFileSync(join(dir, 'bbb.json'), JSON.stringify({ id: 'bbb', step: 'tests', result: null, startedAt: 200 }))
    writeFileSync(join(dir, 'broken.json'), '{ not json')
    writeFileSync(join(dir, 'lock'), '{"pid":1}')
    expect(make().list()).toEqual([
      { id: 'bbb', step: 'tests', result: null, startedAt: 200 },
      { id: 'aaa', step: 'done', result: 'merged', startedAt: 100 },
    ])
  })

  it('状态目录还不存在 ⇒ 空列表', () => {
    expect(make().list()).toEqual([])
  })
})

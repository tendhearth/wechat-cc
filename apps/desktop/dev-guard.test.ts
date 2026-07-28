import { describe, it, expect } from 'vitest'
import { commandPath, isReadonlyCli, guardCliInvoke } from './dev-guard'

const live = { allowMutations: false }

describe('commandPath', () => {
  it('取开头连续的位置参数', () => {
    expect(commandPath(['memory', 'read', 'u', 'p', '--json'])).toEqual(['memory', 'read', 'u', 'p'])
    expect(commandPath(['doctor'])).toEqual(['doctor'])
  })

  it('argv 以 flag 开头时返回 null(fail-closed)', () => {
    // citty 的 findSubCommandIndex 会跳过前导 flag,所以 ['--json','setup']
    // 真的会跑 setup。桌面永远不会产生这种形状,直接拒绝。
    expect(commandPath(['--json', 'setup'])).toBeNull()
    expect(commandPath(['-v', 'service', 'status'])).toBeNull()
    expect(commandPath([])).toBeNull()
  })

  it('`--` 终止命令路径', () => {
    expect(commandPath(['memory', 'read', '--', 'not-a-subcommand'])).toEqual(['memory', 'read'])
  })
})

describe('isReadonlyCli', () => {
  it('认出桌面实际用的读类命令', () => {
    expect(isReadonlyCli(['memory', 'list', '--json'])).toBe(true)
    expect(isReadonlyCli(['memory', 'read', 'u', 'p', '--json'])).toBe(true)
    expect(isReadonlyCli(['doctor', '--json'])).toBe(true)
    expect(isReadonlyCli(['sessions', 'list-chats', '--json'])).toBe(true)
    expect(isReadonlyCli(['daemon', 'api-info', '--json'])).toBe(true)
    expect(isReadonlyCli(['service', 'status', '--json'])).toBe(true)
    expect(isReadonlyCli(['dialogue', 'threads', '--chat-id', 'c', '--json'])).toBe(true)
  })

  it('改真实状态的命令一律不在白名单', () => {
    expect(isReadonlyCli(['setup'])).toBe(false)
    expect(isReadonlyCli(['setup-poll', '--qrcode', 'x'])).toBe(false)
    expect(isReadonlyCli(['update', '--json'])).toBe(false)
    expect(isReadonlyCli(['daemon', 'kill-residual', '--json'])).toBe(false)
    // 评审发现的漏网之鱼——每个都对应仪表盘上一个按钮
    expect(isReadonlyCli(['account', 'remove', 'bot1', '--json'])).toBe(false)
    expect(isReadonlyCli(['provider', 'set', 'kimi'])).toBe(false)
    expect(isReadonlyCli(['memory', 'write', 'u', 'p', '--body-base64', 'x'])).toBe(false)
    expect(isReadonlyCli(['avatar', 'set', 'k', '--base64', 'x'])).toBe(false)
    expect(isReadonlyCli(['sessions', 'delete', 'a', '--json'])).toBe(false)
    expect(isReadonlyCli(['mode', 'set', 'c', 'auto', '--json'])).toBe(false)
    expect(isReadonlyCli(['observations', 'archive', 'c', 'o', '--json'])).toBe(false)
    expect(isReadonlyCli(['service', 'install', '--json'])).toBe(false)
    expect(isReadonlyCli(['service', 'stop', '--json'])).toBe(false)
  })

  it('未知/未来的命令默认不放行(白名单的意义)', () => {
    expect(isReadonlyCli(['some-new-command', '--json'])).toBe(false)
  })

  it('connection probe 是有意为之的例外(它会写 session_state)', () => {
    // 审计发现白名单里唯一会写的一条:errcode -14 时 markExpired。保留放行
    // 的理由写在 dev-guard.ts 的注释里(桌面正常渲染就会跑它、可自愈)。
    // 这条测试的作用是:将来谁想收紧,先看见这是个已知取舍而不是疏漏。
    expect(isReadonlyCli(['connection', 'probe', '--json'])).toBe(true)
  })

  it('service 的 action 是位置参数,只有 status 放行', () => {
    // `service` 没有 subCommands,action 是 positional —— 前缀匹配照样区分。
    expect(isReadonlyCli(['service', 'status', '--json'])).toBe(true)
    expect(isReadonlyCli(['service', 'uninstall', '--json'])).toBe(false)
    expect(isReadonlyCli(['service', '--json', 'status'])).toBe(false)  // 形状不对 → 拒
  })

  it('requireFlag:update 只有 --check 算读类', () => {
    expect(isReadonlyCli(['update', '--check', '--json'])).toBe(true)
    expect(isReadonlyCli(['update', '--json'])).toBe(false)
  })

  it('--out-file 一律拒绝(任意文件覆写,评审实测过的 CRITICAL)', () => {
    // cli.ts 的 emitJson 对 --out-file 做 writeFileSync(outFile, body)。
    // 指向 access.json 就是主人的 bot 再次被静默 deafen —— 正是本阀门要挡的事故。
    // shim 自己需要 --out-file 时走 runCli 的 outFile 选项,不经客户端 args。
    expect(isReadonlyCli(['logs', '--json', '--out-file', '/tmp/x'])).toBe(false)
    expect(isReadonlyCli(['sessions', 'list-chats', '--json', '--out-file', '/tmp/x'])).toBe(false)
    expect(isReadonlyCli(['sessions', 'search', 'q', '--out-file=/tmp/x'])).toBe(false)
  })

  it('service status 不许带任何 flag(--unattended 会先落盘再看 action)', () => {
    // cli.ts:2086 的 saveAgentConfig 在 `if (action === 'status')` 之前无条件执行,
    // 一个"只读状态查询"就能把 daemon 翻成交互模式,bot 从此不回消息。
    expect(isReadonlyCli(['service', 'status', '--json'])).toBe(true)
    expect(isReadonlyCli(['service', 'status', '--unattended', 'false', '--json'])).toBe(false)
    expect(isReadonlyCli(['service', 'status', '--auto-start', 'false'])).toBe(false)
  })

  it('--check 被显式证伪时不算只读', () => {
    // citty 的 boolean 认 `=false`,所以"出现过"不等于"为真"。
    expect(isReadonlyCli(['update', '--check', '--json'])).toBe(true)
    expect(isReadonlyCli(['update', '--check=true'])).toBe(true)
    expect(isReadonlyCli(['update', '--check=false'])).toBe(false)
    expect(isReadonlyCli(['update', '--check=0'])).toBe(false)
    expect(isReadonlyCli(['update', '--check=no'])).toBe(false)
    // --no-check 作为未列出的 flag 被拒
    expect(isReadonlyCli(['update', '--check', '--no-check'])).toBe(false)
  })

  it('未列出的 flag 一律拒绝(flag 也是白名单)', () => {
    expect(isReadonlyCli(['logs', '--tail', '10', '--json'])).toBe(true)
    expect(isReadonlyCli(['logs', '--tail', '10', '--some-future-flag'])).toBe(false)
    expect(isReadonlyCli(['doctor', '--fix'])).toBe(false)
  })

  it('桌面实际用的带 flag 调用都放行', () => {
    expect(isReadonlyCli(['dialogue', 'threads', '--chat-id', 'c', '--facet', 'f', '--json'])).toBe(true)
    expect(isReadonlyCli(['dialogue', 'timeline', '--chat-id', 'c', '--limit', '20', '--before', 't', '--json'])).toBe(true)
    expect(isReadonlyCli(['dialogue', 'unlock', '--passphrase', 'p', '--json'])).toBe(true)
    expect(isReadonlyCli(['events', 'list', 'c', '--json', '--limit', '30'])).toBe(true)
    expect(isReadonlyCli(['memory', 'profile', 'status', '--chat-id', 'c', '--json'])).toBe(true)
    expect(isReadonlyCli(['sessions', 'read-jsonl', 'a', '--json', '--chat', 'c'])).toBe(true)
  })

  it('前导 flag 绕过被堵死(评审实测过的洞)', () => {
    // 修复前:['--json','service','status'] 会被放行并真的执行
    expect(isReadonlyCli(['--json', 'service', 'status'])).toBe(false)
    expect(isReadonlyCli(['--json', 'setup'])).toBe(false)
    // 命令路径被 flag 打断时也不当成更长的白名单项
    expect(isReadonlyCli(['memory', '--chat', 'read'])).toBe(false)
  })
})

describe('guardCliInvoke', () => {
  it('拦下非只读命令,给结构化错误 + hint', () => {
    const r = guardCliInvoke(['account', 'remove', 'bot1'], live)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toBe('mutating_command_blocked_in_dev')
      expect(r.hint).toContain('--allow-mutations')
    }
  })

  it('放行只读命令', () => {
    expect(guardCliInvoke(['memory', 'list', '--json'], live).ok).toBe(true)
  })

  it('--allow-mutations 显式放行', () => {
    expect(guardCliInvoke(['setup'], { allowMutations: true }).ok).toBe(true)
  })

  it('mock/DRY_RUN 不再是免死金牌(评审 #4)', () => {
    // DRY_RUN 只拦截显式列出的命令,其余照样落到真 cli.ts —— 所以阀门
    // 必须在每个模式下都生效,签名里干脆没有 dryRun 这个逃生口。
    expect(guardCliInvoke(['account', 'remove', 'bot1'], live).ok).toBe(false)
  })
})

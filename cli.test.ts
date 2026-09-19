import { describe, it, expect } from 'vitest'
import { runCommand } from 'citty'
import { cittyRoot, computeProviderSetOutcome, parseBudgetUsdFlag, parseTimeoutMsFlag } from './cli'
import { activeModel, type AgentConfig } from './src/lib/agent-config'

// PR4 batch 3c removed parseCliArgs — every subcommand now flows through
// citty. The legacy describe('parseCliArgs') block + per-subcommand parse
// tests are replaced by citty-routed tests in the `citty migrated commands`
// describe below.

// demo seed/unseed parseCliArgs tests removed in PR4 batch 3b — see
// the `citty migrated commands` block below.

describe('citty migrated commands', () => {
  // Citty-migrated subcommands. Asserted via a stub `run` override (citty
  // calls subCommand.run with parsed args) so the tests verify argument
  // parsing without invoking real handlers (which would touch
  // ~/.claude/channels/wechat state and the doctor probe matrix).
  type Captured = { args: Record<string, unknown> } | null

  async function runWithStub(rawArgs: string[], subName: string): Promise<Captured> {
    const subs = cittyRoot.subCommands as Record<string, { run?: unknown }>
    const original = subs[subName]
    if (!original || typeof original !== 'object') throw new Error(`no subcommand ${subName}`)
    let captured: Captured = null
    const stub = { ...original, run: (ctx: { args: Record<string, unknown> }) => { captured = { args: ctx.args } } }
    subs[subName] = stub
    try {
      await runCommand(cittyRoot, { rawArgs })
    } finally {
      subs[subName] = original
    }
    return captured
  }

  /** Stub a leaf inside a nested subcommand path (e.g. ['events', 'list']). */
  async function runWithNestedStub(rawArgs: string[], path: [string, string]): Promise<Captured> {
    const [parentName, leafName] = path
    const subs = cittyRoot.subCommands as Record<string, { subCommands?: Record<string, { run?: unknown }> }>
    const parent = subs[parentName]
    if (!parent?.subCommands) throw new Error(`no parent subcommand ${parentName}`)
    const original = parent.subCommands[leafName]
    if (!original || typeof original !== 'object') throw new Error(`no leaf ${parentName}.${leafName}`)
    let captured: Captured = null
    const stub = { ...original, run: (ctx: { args: Record<string, unknown> }) => { captured = { args: ctx.args } } }
    parent.subCommands[leafName] = stub
    try {
      await runCommand(cittyRoot, { rawArgs })
    } finally {
      parent.subCommands[leafName] = original
    }
    return captured
  }

  it('exposes the full migrated subcommand surface (batches 1 through 3c)', () => {
    const subs = cittyRoot.subCommands as Record<string, unknown>
    expect(Object.keys(subs).sort()).toEqual([
      'access',
      'account',
      'agent',
      'avatar',
      'backup',
      'ci',
      'companion',
      'connection',
      'conversations',
      'daemon',
      'demo',
      'dialogue',
      'doctor',
      'events',
      'federated-source',
      'guard',
      'hand',
      'hook',
      'install',
      'install-progress',
      'license',
      'list',
      'log',
      'logs',
      'mcp-server',
      'memory',
      'milestones',
      'mode',
      'observations',
      'pair',
      'plugin',
      'provider',
      'reply',
      'run',
      'self',
      'selftest',
      'service',
      'sessions',
      'setup',
      'setup-poll',
      'setup-status',
      'social',
      'status',
      'update',
    ])
  })

  // 自维护三件套(spec 2026-09-18-self-maintenance)——子命令面也要钉住:
  // `self deploy` / `selftest workbench|chat` 是手册里写死的入口,改名/漏挂
  // 会让 docs/maintainer/*.md 里的每条命令一起失效。
  it('exposes the self / selftest subcommand surface', () => {
    const subs = cittyRoot.subCommands as Record<string, { subCommands?: Record<string, unknown> }>
    expect(Object.keys(subs.self?.subCommands ?? {}).sort()).toEqual(['change', 'deploy'])
    expect(Object.keys(subs.selftest?.subCommands ?? {}).sort()).toEqual(['chat', 'workbench'])
  })

  // CI 信号面(spec 2026-09-18-ci-triage)——`ci triage` 是手册与 AGENTS.md 里
  // 写死的「看 CI」那一步,改名/漏挂会让那几行一起失效。
  it('exposes the ci subcommand surface', () => {
    const subs = cittyRoot.subCommands as Record<string, { subCommands?: Record<string, unknown> }>
    expect(Object.keys(subs.ci?.subCommands ?? {}).sort()).toEqual(['triage'])
  })

  it('ci triage parses its documented flags', async () => {
    const r = await runWithNestedStub(
      ['ci', 'triage', '--sha', '25113589', '--branch', 'dev', '--wait', '--rerun', '--max-reruns', '2', '--timeout-min', '45', '--json'],
      ['ci', 'triage'],
    )
    expect(r?.args.sha).toBe('25113589')
    expect(r?.args.branch).toBe('dev')
    expect(r?.args.wait).toBe(true)
    expect(r?.args.rerun).toBe(true)
    expect(r?.args['max-reruns']).toBe('2')
    expect(r?.args['timeout-min']).toBe('45')
    expect(r?.args.json).toBe(true)
  })

  it('self deploy parses its documented flags', async () => {
    const r = await runWithNestedStub(
      ['self', 'deploy', '--binary', '/tmp/x', '--app', '/Applications/wechat-cc.app', '--no-rollback', '--health-timeout-ms', '90000', '--json'],
      ['self', 'deploy'],
    )
    expect(r?.args.binary).toBe('/tmp/x')
    expect(r?.args.app).toBe('/Applications/wechat-cc.app')
    // citty/mri parses `--no-rollback` as the negation of a boolean
    // `rollback`, NOT as a flag literally named `no-rollback` — the handler
    // has to read both spellings or the flag is a no-op.
    expect(r?.args.rollback).toBe(false)
    expect(r?.args['health-timeout-ms']).toBe('90000')
    expect(r?.args.json).toBe(true)
  })

  it('self change parses its documented flags', async () => {
    const r = await runWithNestedStub(
      ['self', 'change', '在 flake 表里加一行', '--from', 'wechat', '--budget-usd', '8', '--no-deploy', '--json'],
      ['self', 'change'],
    )
    expect(r?.args.request).toBe('在 flake 表里加一行')
    expect(r?.args.from).toBe('wechat')
    expect(r?.args['budget-usd']).toBe('8')
    // 同 `self deploy --no-rollback`:citty/mri 把 `--no-deploy` 解析成布尔
    // `deploy` 的否定,所以开关必须声明成 `deploy: { default: true }` ——
    // 声明成 `'no-deploy'` 的话这个标志是个哑弹,会照样部署。
    expect(r?.args.deploy).toBe(false)
    expect(r?.args.json).toBe(true)

    const listing = await runWithNestedStub(['self', 'change', '--list'], ['self', 'change'])
    expect(listing?.args.list).toBe(true)
    // 没写 `--no-deploy` 时 deploy 是 true(默认部署),不是 undefined。
    expect(listing?.args.deploy).toBe(true)

    const resumed = await runWithNestedStub(['self', 'change', '--resume', 'a1b2c3d4', '--unhalt'], ['self', 'change'])
    expect(resumed?.args.resume).toBe('a1b2c3d4')
    expect(resumed?.args.unhalt).toBe(true)
  })

  // 微信进件口(src/daemon/self-change-spawn.ts)把需求放在 `--` 之后。这条钉住
  // 的是**另一端**:citty 确实把 `--` 之后的东西原样当位置参数,而不是开关。
  // 不这样的话「自改 --unhalt」会静默解除停机 —— 主人以为在提需求。
  it('self change 把 `--` 之后的需求当位置参数,哪怕它长得像开关', async () => {
    const r = await runWithNestedStub(
      ['self', 'change', '--from', 'wechat', '--json', '--', '--unhalt'],
      ['self', 'change'],
    )
    expect(r?.args.request).toBe('--unhalt')
    expect(Boolean(r?.args.unhalt)).toBe(false)
    expect(r?.args.from).toBe('wechat')
    expect(r?.args.json).toBe(true)

    const dashed = await runWithNestedStub(
      ['self', 'change', '--from', 'wechat', '--json', '--', '-x 把这个删了'],
      ['self', 'change'],
    )
    expect(dashed?.args.request).toBe('-x 把这个删了')

    const plain = await runWithNestedStub(
      ['self', 'change', '--from', 'wechat', '--json', '--', '给 flake 表加一行'],
      ['self', 'change'],
    )
    expect(plain?.args.request).toBe('给 flake 表加一行')
  })

  it('selftest workbench / chat parse their documented flags', async () => {
    const wb = await runWithNestedStub(
      ['selftest', 'workbench', '--executor', 'cursor', '--image', '--resume', '--json', '--timeout-ms', '300000', '--keep'],
      ['selftest', 'workbench'],
    )
    expect(wb?.args.executor).toBe('cursor')
    expect(wb?.args.image).toBe(true)
    expect(wb?.args.resume).toBe(true)
    expect(wb?.args.json).toBe(true)
    expect(wb?.args['timeout-ms']).toBe('300000')
    expect(wb?.args.keep).toBe(true)

    const chat = await runWithNestedStub(
      ['selftest', 'chat', '--provider', 'cursor', '--text', '你好', '--resume', '--json', '--timeout-ms', '200000'],
      ['selftest', 'chat'],
    )
    expect(chat?.args.provider).toBe('cursor')
    expect(chat?.args.text).toBe('你好')
    expect(chat?.args.resume).toBe(true)
    expect(chat?.args.json).toBe(true)
    expect(chat?.args['timeout-ms']).toBe('200000')
  })

  it('doctor accepts --json', async () => {
    const r = await runWithStub(['doctor', '--json'], 'doctor')
    expect(r?.args.json).toBe(true)
  })

  it('doctor without --json defaults to false-y', async () => {
    const r = await runWithStub(['doctor'], 'doctor')
    expect(r?.args.json).toBeFalsy()
  })

  it('setup-status accepts --json', async () => {
    const r = await runWithStub(['setup-status', '--json'], 'setup-status')
    expect(r?.args.json).toBe(true)
  })

  it('status / list parse with no extra args', async () => {
    expect(await runWithStub(['status'], 'status')).not.toBeNull()
    expect(await runWithStub(['list'], 'list')).not.toBeNull()
  })

  it('install accepts legacy --user flag (for backward arg compat)', async () => {
    const r = await runWithStub(['install', '--user'], 'install')
    expect(r?.args.user).toBe(true)
  })

  // ── PR4 batch 2 — read-only inspection commands ─────────────────────

  it('events list parses chat-id positional + --json + --limit', async () => {
    const r = await runWithNestedStub(
      ['events', 'list', 'chat_x', '--json', '--limit', '20'],
      ['events', 'list'],
    )
    expect(r?.args.chatId).toBe('chat_x')
    expect(r?.args.json).toBe(true)
    expect(r?.args.limit).toBe('20')
  })

  it('observations list parses chat-id + --include-archived', async () => {
    const r = await runWithNestedStub(
      ['observations', 'list', 'chat_x', '--include-archived'],
      ['observations', 'list'],
    )
    expect(r?.args.chatId).toBe('chat_x')
    expect(r?.args['include-archived']).toBe(true)
  })

  it('observations archive parses chat-id + obs-id', async () => {
    const r = await runWithNestedStub(
      ['observations', 'archive', 'chat_x', 'obs_abc', '--json'],
      ['observations', 'archive'],
    )
    expect(r?.args.chatId).toBe('chat_x')
    expect(r?.args.obsId).toBe('obs_abc')
    expect(r?.args.json).toBe(true)
  })

  it('milestones list parses chat-id', async () => {
    const r = await runWithNestedStub(
      ['milestones', 'list', 'chat_x', '--json'],
      ['milestones', 'list'],
    )
    expect(r?.args.chatId).toBe('chat_x')
    expect(r?.args.json).toBe(true)
  })

  it('conversations list parses --json', async () => {
    const r = await runWithNestedStub(
      ['conversations', 'list', '--json'],
      ['conversations', 'list'],
    )
    expect(r?.args.json).toBe(true)
  })

  it('logs accepts --tail + --json', async () => {
    const r = await runWithStub(['logs', '--tail', '20', '--json'], 'logs')
    expect(r?.args.tail).toBe('20')
    expect(r?.args.json).toBe(true)
  })

  it('logs without flags uses defaults', async () => {
    const r = await runWithStub(['logs'], 'logs')
    expect(r?.args.tail).toBeFalsy()
    expect(r?.args.json).toBeFalsy()
  })

  // ── PR4 batch 3a — sessions / avatar / guard / provider ─────────────

  it('sessions list-projects parses --json + --out-file', async () => {
    const r = await runWithNestedStub(
      ['sessions', 'list-projects', '--json', '--out-file', '/tmp/x.json'],
      ['sessions', 'list-projects'],
    )
    expect(r?.args.json).toBe(true)
    expect(r?.args['out-file']).toBe('/tmp/x.json')
  })

  it('sessions read-jsonl parses alias positional + --out-file', async () => {
    const r = await runWithNestedStub(
      ['sessions', 'read-jsonl', 'compass', '--json', '--out-file', '/tmp/x.json'],
      ['sessions', 'read-jsonl'],
    )
    expect(r?.args.alias).toBe('compass')
    expect(r?.args.json).toBe(true)
    expect(r?.args['out-file']).toBe('/tmp/x.json')
  })

  it('sessions delete parses alias positional', async () => {
    const r = await runWithNestedStub(
      ['sessions', 'delete', 'compass', '--json'],
      ['sessions', 'delete'],
    )
    expect(r?.args.alias).toBe('compass')
    expect(r?.args.json).toBe(true)
  })

  it('sessions search parses query + --limit', async () => {
    const r = await runWithNestedStub(
      ['sessions', 'search', 'ilink', '--limit', '20', '--json'],
      ['sessions', 'search'],
    )
    expect(r?.args.query).toBe('ilink')
    expect(r?.args.limit).toBe('20')
    expect(r?.args.json).toBe(true)
  })

  it('avatar info parses key positional', async () => {
    const r = await runWithNestedStub(
      ['avatar', 'info', 'chat_x', '--json'],
      ['avatar', 'info'],
    )
    expect(r?.args.key).toBe('chat_x')
    expect(r?.args.json).toBe(true)
  })

  it('avatar set parses key + required --base64', async () => {
    const r = await runWithNestedStub(
      ['avatar', 'set', 'chat_x', '--base64', 'eA=='],
      ['avatar', 'set'],
    )
    expect(r?.args.key).toBe('chat_x')
    expect(r?.args.base64).toBe('eA==')
  })

  it('avatar remove parses key positional', async () => {
    const r = await runWithNestedStub(
      ['avatar', 'remove', 'chat_x', '--json'],
      ['avatar', 'remove'],
    )
    expect(r?.args.key).toBe('chat_x')
    expect(r?.args.json).toBe(true)
  })

  it('guard status / enable / disable parse with --json', async () => {
    expect(await runWithNestedStub(['guard', 'status', '--json'], ['guard', 'status'])).not.toBeNull()
    expect(await runWithNestedStub(['guard', 'enable'], ['guard', 'enable'])).not.toBeNull()
    expect(await runWithNestedStub(['guard', 'disable', '--json'], ['guard', 'disable'])).not.toBeNull()
  })

  // 心愿 (spec 2026-09-04-wish-postcard §4) CLI form — parse-only (the real
  // handler needs a running daemon).
  it('social wishes parses --json', async () => {
    const r = await runWithNestedStub(['social', 'wishes', '--json'], ['social', 'wishes'])
    expect(r?.args.json).toBe(true)
  })

  it('provider show parses --json', async () => {
    const r = await runWithNestedStub(['provider', 'show', '--json'], ['provider', 'show'])
    expect(r?.args.json).toBe(true)
  })

  it('provider set parses positional + --model + tri-state --unattended', async () => {
    const r = await runWithNestedStub(
      ['provider', 'set', 'codex', '--model', 'gpt-5.3-codex', '--unattended', 'true'],
      ['provider', 'set'],
    )
    expect(r?.args.provider).toBe('codex')
    expect(r?.args.model).toBe('gpt-5.3-codex')
    expect(r?.args.unattended).toBe('true')  // string, parsed to bool inside the run handler
  })

  it('provider set accepts cursor as a valid provider', async () => {
    const r = await runWithNestedStub(
      ['provider', 'set', 'cursor'],
      ['provider', 'set'],
    )
    expect(r?.args.provider).toBe('cursor')
  })

  it('provider set accepts openai with --model and --base-url', async () => {
    const r = await runWithNestedStub(
      ['provider', 'set', 'openai', '--model', 'deepseek-chat', '--base-url', 'https://api.deepseek.com/v1'],
      ['provider', 'set'],
    )
    expect(r?.args.provider).toBe('openai')
    expect(r?.args.model).toBe('deepseek-chat')
    expect(r?.args['base-url']).toBe('https://api.deepseek.com/v1')
  })

  // ── provider set: computeProviderSetOutcome behavior (pure, no STATE_DIR I/O) ──

  const baseConfig: AgentConfig = {
    provider: 'claude',
    dangerouslySkipPermissions: true,
    autoStart: true,
    closeStopsDaemon: false,
  }

  it('provider set openai persists provider + openaiModel + openaiBaseUrl', () => {
    const outcome = computeProviderSetOutcome(
      { provider: 'openai', model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com/v1' },
      baseConfig,
      {},
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('expected ok')
    expect(outcome.config.provider).toBe('openai')
    expect(outcome.config.openaiModel).toBe('deepseek-chat')
    expect(outcome.config.openaiBaseUrl).toBe('https://api.deepseek.com/v1')
    // openai never writes the generic `model` field.
    expect(outcome.config.model).toBeUndefined()
    expect(outcome.message).toContain('记得设置 WECHAT_OPENAI_API_KEY')
  })

  it('provider set openai reports the env key as detected when present', () => {
    const outcome = computeProviderSetOutcome(
      { provider: 'openai', model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com/v1' },
      baseConfig,
      { WECHAT_OPENAI_API_KEY: 'sk-test' },
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('expected ok')
    expect(outcome.message).toContain('已检测到 WECHAT_OPENAI_API_KEY')
  })

  it('provider set openai errors when --base-url is missing and none is stored', () => {
    const outcome = computeProviderSetOutcome({ provider: 'openai', model: 'deepseek-chat' }, baseConfig, {})
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('expected error')
    expect(outcome.error).toContain('--base-url')
    expect(outcome.error).toContain('WECHAT_OPENAI_API_KEY')
  })

  it('provider set openai errors when --model is missing and none is stored', () => {
    const outcome = computeProviderSetOutcome({ provider: 'openai', baseUrl: 'https://api.deepseek.com/v1' }, baseConfig, {})
    expect(outcome.ok).toBe(false)
    if (outcome.ok) throw new Error('expected error')
    expect(outcome.error).toContain('--model')
  })

  it('provider set openai reuses a stored base-url/model when flags are omitted', () => {
    const existing: AgentConfig = { ...baseConfig, provider: 'openai', openaiBaseUrl: 'https://api.deepseek.com/v1', openaiModel: 'deepseek-chat' }
    const outcome = computeProviderSetOutcome({ provider: 'openai' }, existing, {})
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('expected ok')
    expect(outcome.config.openaiBaseUrl).toBe('https://api.deepseek.com/v1')
    expect(outcome.config.openaiModel).toBe('deepseek-chat')
  })

  it('provider set claude is unaffected by openai support (no openai fields touched)', () => {
    const outcome = computeProviderSetOutcome({ provider: 'claude', model: 'sonnet' }, baseConfig, {})
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('expected ok')
    expect(outcome.config.provider).toBe('claude')
    expect(outcome.config.model).toBe('sonnet')
    expect(outcome.config.openaiModel).toBeUndefined()
    expect(outcome.config.openaiBaseUrl).toBeUndefined()
    expect(outcome.message).not.toContain('WECHAT_OPENAI_API_KEY')
  })

  it('provider set warns when --base-url is supplied for a non-openai provider', () => {
    const outcome = computeProviderSetOutcome({ provider: 'claude', baseUrl: 'https://example.com' }, baseConfig, {})
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('expected ok')
    expect(outcome.warning).toContain('ignored')
  })

  it('provider set cursor with --model persists cursorModel, not the generic model field', () => {
    const outcome = computeProviderSetOutcome({ provider: 'cursor', model: 'composer-2' }, baseConfig, {})
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('expected ok')
    expect(outcome.config.cursorModel).toBe('composer-2')
    expect(outcome.config.model).toBeUndefined()
    expect(outcome.message).toContain('composer-2')
    expect(activeModel(outcome.config)).toBe('composer-2')
  })

  it('provider set openai retains a prior claude/codex generic model as a stale-but-harmless field, while activeModel resolves to the new openai model', () => {
    const existing: AgentConfig = { ...baseConfig, provider: 'claude', model: 'sonnet-x' }
    const outcome = computeProviderSetOutcome(
      { provider: 'openai', model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com/v1' },
      existing,
      {},
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('expected ok')
    expect(outcome.config.openaiModel).toBe('deepseek-chat')
    // Stale generic `model` from the previous (claude) provider is retained
    // rather than deleted — harmless since `show`/activeModel() key off the
    // current provider, and it means switching back to claude later still
    // remembers 'sonnet-x'.
    expect(outcome.config.model).toBe('sonnet-x')
    expect(activeModel(outcome.config)).toBe('deepseek-chat')
  })

  // ── PR4 batch 3b — memory / account / daemon / demo ─────────────────

  it('memory list parses --json', async () => {
    const r = await runWithNestedStub(['memory', 'list', '--json'], ['memory', 'list'])
    expect(r?.args.json).toBe(true)
  })

  it('memory read parses user-id + path positionals', async () => {
    const r = await runWithNestedStub(
      ['memory', 'read', 'u@x', 'profile.md', '--json'],
      ['memory', 'read'],
    )
    expect(r?.args.userId).toBe('u@x')
    expect(r?.args.path).toBe('profile.md')
    expect(r?.args.json).toBe(true)
  })

  it('memory write parses positionals + required --body-base64', async () => {
    const r = await runWithNestedStub(
      ['memory', 'write', 'u@x', 'profile.md', '--body-base64', 'IyBoaQ==', '--json'],
      ['memory', 'write'],
    )
    expect(r?.args.userId).toBe('u@x')
    expect(r?.args.path).toBe('profile.md')
    expect(r?.args['body-base64']).toBe('IyBoaQ==')
    expect(r?.args.json).toBe(true)
  })

  it('account remove parses bot-id positional', async () => {
    const r = await runWithNestedStub(
      ['account', 'remove', 'abc-im-bot', '--json'],
      ['account', 'remove'],
    )
    expect(r?.args.botId).toBe('abc-im-bot')
    expect(r?.args.json).toBe(true)
  })

  it('daemon kill parses pid positional (string; coerced inside run)', async () => {
    const r = await runWithNestedStub(
      ['daemon', 'kill', '12345', '--json'],
      ['daemon', 'kill'],
    )
    expect(r?.args.pid).toBe('12345')
    expect(r?.args.json).toBe(true)
  })

  it('demo seed parses --chat-id', async () => {
    const r = await runWithNestedStub(
      ['demo', 'seed', '--chat-id', 'chat_x', '--json'],
      ['demo', 'seed'],
    )
    expect(r?.args['chat-id']).toBe('chat_x')
    expect(r?.args.json).toBe(true)
  })

  it('demo seed without --chat-id (handler resolves default)', async () => {
    const r = await runWithNestedStub(['demo', 'seed'], ['demo', 'seed'])
    expect(r?.args['chat-id']).toBeFalsy()
  })

  it('demo unseed parses --json', async () => {
    const r = await runWithNestedStub(['demo', 'unseed', '--json'], ['demo', 'unseed'])
    expect(r?.args.json).toBe(true)
  })

  // ── PR4 batch 3c — heavy entry points ───────────────────────────────

  it('run accepts --dangerously', async () => {
    const r = await runWithStub(['run', '--dangerously'], 'run')
    expect(r?.args.dangerously).toBe(true)
  })

  it('run defaults --dangerously to falsy', async () => {
    const r = await runWithStub(['run'], 'run')
    expect(r?.args.dangerously).toBeFalsy()
  })

  it('run accepts legacy v0.x flags (--fresh, --mcp-config) without rejecting', async () => {
    // The actual `console.warn` calls happen inside the real `run` handler
    // before it imports main.ts. With the handler stubbed for arg-capture
    // we can't observe the warnings here — but verifying citty parses the
    // flags (instead of erroring on unknown args) is what this test
    // protects: regression would surface as a citty parse error which
    // runWithStub would propagate as a test failure.
    const r = await runWithStub(['run', '--fresh', '--mcp-config', 'x'], 'run')
    expect(r?.args.fresh).toBe(true)
    expect(r?.args['mcp-config']).toBe('x')
  })

  it('setup accepts --qr-json', async () => {
    const r = await runWithStub(['setup', '--qr-json'], 'setup')
    expect(r?.args['qr-json']).toBe(true)
  })

  it('setup without flags', async () => {
    const r = await runWithStub(['setup'], 'setup')
    expect(r?.args['qr-json']).toBeFalsy()
  })

  it('setup-poll parses required --qrcode + optional --base-url + --json', async () => {
    const r = await runWithStub(
      ['setup-poll', '--qrcode', 'qr-token', '--base-url', 'https://next', '--json'],
      'setup-poll',
    )
    expect(r?.args.qrcode).toBe('qr-token')
    expect(r?.args['base-url']).toBe('https://next')
    expect(r?.args.json).toBe(true)
  })

  it('service parses positional action + --json + tri-state flags', async () => {
    const r = await runWithStub(
      ['service', 'install', '--json', '--unattended', 'true', '--auto-start', 'false'],
      'service',
    )
    expect(r?.args.action).toBe('install')
    expect(r?.args.json).toBe(true)
    expect(r?.args.unattended).toBe('true')  // string; coerced inside run
    expect(r?.args['auto-start']).toBe('false')
  })

  it('service status with no flags', async () => {
    const r = await runWithStub(['service', 'status'], 'service')
    expect(r?.args.action).toBe('status')
  })

  it('reply with single positional text lands in args._', async () => {
    const r = await runWithStub(['reply', 'hello'], 'reply')
    expect(r?.args._).toEqual(['hello'])
  })

  it('reply with --to and multi-word text', async () => {
    const r = await runWithStub(
      ['reply', '--to', 'u@chat', 'hello', 'world'],
      'reply',
    )
    expect(r?.args.to).toBe('u@chat')
    expect(r?.args._).toEqual(['hello', 'world'])
  })

  it('reply with --json and no text (stdin path)', async () => {
    const r = await runWithStub(['reply', '--json'], 'reply')
    expect(r?.args.json).toBe(true)
    expect(r?.args._ ?? []).toEqual([])
  })

  it('update parses --check + --json', async () => {
    const checkOnly = await runWithStub(['update', '--check'], 'update')
    expect(checkOnly?.args.check).toBe(true)
    expect(checkOnly?.args.json).toBeFalsy()
    const both = await runWithStub(['update', '--check', '--json'], 'update')
    expect(both?.args.check).toBe(true)
    expect(both?.args.json).toBe(true)
  })

  it('update default (no flags)', async () => {
    const r = await runWithStub(['update'], 'update')
    expect(r?.args.check).toBeFalsy()
    expect(r?.args.json).toBeFalsy()
  })

  // ── connection probe ─────────────────────────────────────────────────────

  it('connection probe parses --json', async () => {
    const r = await runWithNestedStub(
      ['connection', 'probe', '--json'],
      ['connection', 'probe'],
    )
    expect(r?.args.json).toBe(true)
  })

  it('connection probe defaults --json to falsy', async () => {
    const r = await runWithNestedStub(
      ['connection', 'probe'],
      ['connection', 'probe'],
    )
    expect(r?.args.json).toBeFalsy()
  })
})

describe('connection probe CLI — integration (empty state dir)', () => {
  it('prints a JSON envelope with an accounts array when state dir is empty', () => {
    const { spawnSync } = require('node:child_process')
    const r = spawnSync('bun', ['cli.ts', 'connection', 'probe', '--json'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, WECHAT_STATE_DIR: '/tmp/wechat-cc-probe-empty' },
    })
    expect(r.status).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(Array.isArray(out.accounts)).toBe(true)
    expect(out.accounts).toHaveLength(0)
  })
})

describe('computeProviderSetOutcome — 名单跟 lib/provider-ids 走', () => {
  it('accepts agy (the desktop 大脑 menu lists it; `provider set agy` used to be refused)', async () => {
    const { computeProviderSetOutcome } = await import('./cli')
    const existing = { provider: 'claude' as const, dangerouslySkipPermissions: true, autoStart: true, closeStopsDaemon: false }
    const r = computeProviderSetOutcome({ provider: 'agy' }, existing as never)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.config.provider).toBe('agy')
    const bad = computeProviderSetOutcome({ provider: 'bogus' }, existing as never)
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error).toContain('agy')
  })
})

describe('parseTimeoutMsFlag — 数值开关写错了当场报错,别替用户猜', () => {
  it('omitted ⇒ ok with no value (caller falls back to its default)', () => {
    expect(parseTimeoutMsFlag(undefined)).toEqual({ ok: true })
    expect(parseTimeoutMsFlag('')).toEqual({ ok: true })
  })

  it('a positive number parses', () => {
    expect(parseTimeoutMsFlag('90000')).toEqual({ ok: true, value: 90_000 })
    expect(parseTimeoutMsFlag(1500)).toEqual({ ok: true, value: 1500 })
  })

  it('non-numeric / zero / negative are errors (they used to silently become the default)', () => {
    for (const bad of ['abc', '30s', '0', '-1', 'NaN', 'Infinity']) {
      const r = parseTimeoutMsFlag(bad)
      expect(r.ok, bad).toBe(false)
      if (!r.ok) expect(r.error).toContain(bad)
    }
  })
})

// `self change --budget-usd` 走的是同一条规矩(钱比毫秒更不能替用户猜:
// 写错了悄悄退回缺省值,就是按 $20 而不是他以为的 $8 跑一整轮实现会话)。
describe('parseBudgetUsdFlag — 钱的开关写错了当场报错', () => {
  it('omitted ⇒ ok with no value (caller falls back to implement_budget_usd)', () => {
    expect(parseBudgetUsdFlag(undefined)).toEqual({ ok: true })
    expect(parseBudgetUsdFlag(null)).toEqual({ ok: true })
    expect(parseBudgetUsdFlag('')).toEqual({ ok: true })
  })

  it('a positive number parses (整数和小数都要认 —— 预算不是毫秒)', () => {
    expect(parseBudgetUsdFlag('8')).toEqual({ ok: true, value: 8 })
    expect(parseBudgetUsdFlag('2.5')).toEqual({ ok: true, value: 2.5 })
    expect(parseBudgetUsdFlag(20)).toEqual({ ok: true, value: 20 })
  })

  it('non-numeric / zero / negative are errors', () => {
    for (const bad of ['abc', '$8', '0', '-1', 'NaN', 'Infinity']) {
      const r = parseBudgetUsdFlag(bad)
      expect(r.ok, bad).toBe(false)
      if (!r.ok) expect(r.error).toContain(bad)
    }
  })
})

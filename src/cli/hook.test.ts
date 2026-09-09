import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  normalizeHookPayload, shouldSkipHook, postCliEvent, hookCommandLine,
  installHooks, uninstallHooks, hookStatus, claudeSettingsPath, codexHooksPath, summarizeToolInput,
  parsePermissionRequest, relayPermission, permissionDecisionOutput, isAutomatedPrompt,
} from './hook'

const tmpDirs: string[] = []
let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'wechat-cc-hook-')); tmpDirs.push(dir) })
afterAll(() => { for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }) } catch {} } })

const common = { session_id: 'abc-123', transcript_path: '/t.jsonl', cwd: '/w/p', permission_mode: 'default' }

describe('normalizeHookPayload — claude', () => {
  it('Stop → stop 带 last_assistant_message', () => {
    expect(normalizeHookPayload('claude', { ...common, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: '搞定' }))
      .toEqual({ source: 'claude', kind: 'stop', session_id: 'abc-123', cwd: '/w/p', text: '搞定' })
  })
  it('Notification / PermissionRequest 不是事件 → null(PermissionRequest 走 parsePermissionRequest)', () => {
    expect(normalizeHookPayload('claude', { ...common, hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'x' })).toBeNull()
    expect(normalizeHookPayload('claude', { ...common, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: {} })).toBeNull()
  })
  it('UserPromptSubmit → prompt;harness 塞的 prompt 标 automated;SessionEnd → session_end;其他事件 → null', () => {
    expect(normalizeHookPayload('claude', { ...common, hook_event_name: 'UserPromptSubmit', prompt: 'hi' })).toEqual({ source: 'claude', kind: 'prompt', session_id: 'abc-123', cwd: '/w/p' })
    expect(normalizeHookPayload('claude', { ...common, hook_event_name: 'UserPromptSubmit', prompt: '/loop 完善这部分' })?.automated).toBe(true)
    expect(normalizeHookPayload('claude', { ...common, hook_event_name: 'UserPromptSubmit', prompt: '<task-notification>\n<task-id>x</task-id>' })?.automated).toBe(true)
    expect(isAutomatedPrompt('  <system-reminder>x')).toBe(true)
    expect(isAutomatedPrompt('<command-message>loop</command-message>\n<command-name>/loop</command-name>')).toBe(true)
    expect(isAutomatedPrompt('<command-message>commit</command-message>')).toBe(false)
    expect(isAutomatedPrompt('帮我看看 loop 这个函数')).toBe(false)
    expect(normalizeHookPayload('claude', { ...common, hook_event_name: 'SessionEnd', reason: 'exit' })?.kind).toBe('session_end')
    expect(normalizeHookPayload('claude', { ...common, hook_event_name: 'PreToolUse', tool_name: 'Bash' })).toBeNull()
  })
  it('子代理(带 agent_id)、缺 session_id / cwd、不是对象 → null', () => {
    expect(normalizeHookPayload('claude', { ...common, hook_event_name: 'Stop', agent_id: 'sub-1' })).toBeNull()
    expect(normalizeHookPayload('claude', { hook_event_name: 'Stop', cwd: '/w' })).toBeNull()
    expect(normalizeHookPayload('claude', 'nope')).toBeNull()
    expect(normalizeHookPayload('claude', null)).toBeNull()
  })
})

describe('normalizeHookPayload — codex', () => {
  const cx = { ...common, turn_id: 't1', model: 'gpt', permission_mode: 'default' }
  it('Stop → stop;last_assistant_message 为 null 时 text 省略', () => {
    expect(normalizeHookPayload('codex', { ...cx, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: null }))
      .toEqual({ source: 'codex', kind: 'stop', session_id: 'abc-123', cwd: '/w/p' })
  })
  it('PermissionRequest 不进 normalize', () => {
    expect(normalizeHookPayload('codex', { ...cx, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm -rf ./tmp' } })).toBeNull()
  })
  it('UserPromptSubmit / SessionEnd 同 claude', () => {
    expect(normalizeHookPayload('codex', { ...cx, hook_event_name: 'UserPromptSubmit', prompt: 'x' })?.kind).toBe('prompt')
    expect(normalizeHookPayload('codex', { ...cx, hook_event_name: 'SessionEnd' })?.kind).toBe('session_end')
  })
})

describe('parsePermissionRequest', () => {
  it('两家形状相同:tool_name + tool_input 摘要;子代理 / 别的事件 / 缺字段 → null', () => {
    expect(parsePermissionRequest('claude', { ...common, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm -rf ./tmp' }, permission_suggestions: [] }))
      .toEqual({ source: 'claude', session_id: 'abc-123', cwd: '/w/p', tool_name: 'Bash', summary: 'rm -rf ./tmp' })
    expect(parsePermissionRequest('codex', { ...common, turn_id: 't', hook_event_name: 'PermissionRequest', tool_name: 'apply_patch', tool_input: null }))
      .toEqual({ source: 'codex', session_id: 'abc-123', cwd: '/w/p', tool_name: 'apply_patch' })
    expect(parsePermissionRequest('claude', { ...common, hook_event_name: 'PermissionRequest', tool_name: 'Bash', agent_id: 'sub' })).toBeNull()
    expect(parsePermissionRequest('claude', { ...common, hook_event_name: 'Stop' })).toBeNull()
    expect(parsePermissionRequest('claude', { ...common, hook_event_name: 'PermissionRequest' })).toBeNull()
  })
})

describe('relayPermission — 登记 + 轮询', () => {
  const preq = { source: 'claude' as const, session_id: 's', cwd: '/w', tool_name: 'Bash', summary: 'ls' }
  function api(dir: string) {
    const tokenFile = join(dir, 'tok'); writeFileSync(tokenFile, 'secret')
    writeFileSync(join(dir, 'internal-api-info.json'), JSON.stringify({ baseUrl: 'http://127.0.0.1:1', tokenFilePath: tokenFile }))
  }
  it('daemon 没跑 → decision null', async () => {
    expect(await relayPermission(dir, preq)).toEqual({ decision: null, status: 'daemon_not_running' })
  })
  it('POST 回 owner_present → null,不轮询', async () => {
    api(dir)
    const f = vi.fn(async () => new Response(JSON.stringify({ status: 'owner_present' }), { status: 200 }))
    expect(await relayPermission(dir, preq, { fetchImpl: f as unknown as typeof fetch })).toEqual({ decision: null, status: 'owner_present' })
    expect(f).toHaveBeenCalledTimes(1)
  })
  it('pending → 轮询到 allow;GET 带 hash 与 wait_ms', async () => {
    api(dir)
    const urls: string[] = []
    const answers = ['pending', 'allow']
    const f = vi.fn(async (url: string, init: RequestInit) => {
      urls.push(url)
      if (init.method === 'POST') return new Response(JSON.stringify({ status: 'pending', hash: 'k3x9z' }), { status: 200 })
      return new Response(JSON.stringify({ hash: 'k3x9z', status: answers.shift() }), { status: 200 })
    })
    expect(await relayPermission(dir, preq, { fetchImpl: f as unknown as typeof fetch, pollMs: 100 })).toEqual({ decision: 'allow', status: 'allow' })
    expect(urls[1]).toContain('/v1/cli/permission?hash=k3x9z&wait_ms=100')
    expect(f).toHaveBeenCalledTimes(3)
  })
  it('轮询到 timeout / undelivered → null 带原因;总时限到 → deadline', async () => {
    api(dir)
    const f1 = vi.fn(async (_u: string, init: RequestInit) => new Response(JSON.stringify(init.method === 'POST' ? { status: 'pending', hash: 'h' } : { hash: 'h', status: 'undelivered' }), { status: 200 }))
    expect(await relayPermission(dir, preq, { fetchImpl: f1 as unknown as typeof fetch })).toEqual({ decision: null, status: 'undelivered' })
    let t = 0
    const f2 = vi.fn(async (_u: string, init: RequestInit) => { t += 60; return new Response(JSON.stringify(init.method === 'POST' ? { status: 'pending', hash: 'h' } : { hash: 'h', status: 'pending' }), { status: 200 }) })
    expect(await relayPermission(dir, preq, { fetchImpl: f2 as unknown as typeof fetch, totalMs: 200, pollMs: 50, now: () => t })).toEqual({ decision: null, status: 'deadline' })
  })
  it('permissionDecisionOutput:两家同一形状', () => {
    expect(JSON.parse(permissionDecisionOutput('allow'))).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } })
    expect(JSON.parse(permissionDecisionOutput('deny')).hookSpecificOutput.decision.behavior).toBe('deny')
  })
})

describe('summarizeToolInput', () => {
  it('有 command 就用 command;否则 JSON 截断', () => {
    expect(summarizeToolInput({ command: 'ls -la' })).toBe('ls -la')
    expect(summarizeToolInput({ command: ['git', 'status'] })).toBe('git status')
    expect(summarizeToolInput({ path: '/a', content: 'x'.repeat(500) }).length).toBeLessThanOrEqual(200)
    expect(summarizeToolInput(undefined)).toBe('')
  })
})

describe('shouldSkipHook — 回环守卫', () => {
  it('daemon 的孩子(WECHAT_CC_DAEMON_CHILD=1)跳过;否则不跳', () => {
    expect(shouldSkipHook({ WECHAT_CC_DAEMON_CHILD: '1' })).toBe(true)
    expect(shouldSkipHook({})).toBe(false)
  })
})

describe('postCliEvent', () => {
  const ev = { source: 'claude' as const, kind: 'stop' as const, session_id: 's', cwd: '/w', text: 't' }
  it('daemon 没跑(无 info 文件)→ ok:false daemon_not_running,不抛', async () => {
    expect(await postCliEvent(dir, ev)).toEqual({ ok: false, reason: 'daemon_not_running' })
  })
  it('有 info + token → POST /v1/cli/event 带 Bearer;非 2xx → http_<status>;fetch 抛 → reason', async () => {
    const tokenFile = join(dir, 'tok'); writeFileSync(tokenFile, 'secret\n')
    writeFileSync(join(dir, 'internal-api-info.json'), '\uFEFF' + JSON.stringify({ baseUrl: 'http://127.0.0.1:1', tokenFilePath: tokenFile }))
    const calls: { url: string; init: RequestInit }[] = []
    const fetchOk = vi.fn(async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response('{"ok":true,"action":"scheduled"}', { status: 200 }) })
    expect(await postCliEvent(dir, ev, { fetchImpl: fetchOk as unknown as typeof fetch })).toEqual({ ok: true, action: 'scheduled' })
    expect(calls[0]!.url).toBe('http://127.0.0.1:1/v1/cli/event')
    expect((calls[0]!.init.headers as Record<string, string>)['authorization']).toBe('Bearer secret')
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual(ev)

    const fetch503 = vi.fn(async () => new Response('{"error":"cli_events_not_wired"}', { status: 503 }))
    expect(await postCliEvent(dir, ev, { fetchImpl: fetch503 as unknown as typeof fetch })).toEqual({ ok: false, reason: 'http_503' })

    const fetchBoom = vi.fn(async () => { throw new Error('ECONNREFUSED') })
    expect(await postCliEvent(dir, ev, { fetchImpl: fetchBoom as unknown as typeof fetch })).toEqual({ ok: false, reason: 'ECONNREFUSED' })
  })
})

describe('hookCommandLine', () => {
  it('源码模式 = "bun" "cli.ts" hook <source>;编译包 = "binary" hook <source>', () => {
    expect(hookCommandLine({ execPath: '/opt/bun', compiled: false, cliEntry: '/r/cli.ts', source: 'claude' })).toBe('"/opt/bun" "/r/cli.ts" hook claude')
    expect(hookCommandLine({ execPath: 'C:\\App\\wechat-cc-cli.exe', compiled: true, cliEntry: '/ignored', source: 'codex' })).toBe('"C:\\App\\wechat-cc-cli.exe" hook codex')
  })
})

describe('installHooks / uninstallHooks / hookStatus', () => {
  const cmd = '"/opt/bun" "/r/cli.ts" hook claude'
  it('claude:文件不存在 → 建;四个事件各一组;PermissionRequest 同步 + 150s,其余 async + 5s', () => {
    const file = join(dir, 'settings.json')
    expect(installHooks(file, 'claude', cmd)).toEqual({ changed: true })
    const cfg = JSON.parse(readFileSync(file, 'utf8'))
    expect(Object.keys(cfg.hooks).sort()).toEqual(['PermissionRequest', 'SessionEnd', 'Stop', 'UserPromptSubmit'])
    expect(cfg.hooks.PermissionRequest[0].hooks[0]).toMatchObject({ type: 'command', command: cmd, async: false, timeout: 150 })
    expect(cfg.hooks.Stop[0].matcher).toBeUndefined()
    expect(cfg.hooks.Stop[0].hooks[0]).toMatchObject({ type: 'command', command: cmd, async: true, timeout: 5 })
    expect(hookStatus(file, 'claude')).toEqual({ installed: true, command: cmd })
  })
  it('幂等;别人的 hook 与别的设置原样保留;命令变了会替换', () => {
    const file = join(dir, 'settings.json')
    writeFileSync(file, JSON.stringify({
      model: 'opus',
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'ntfy send done' }] }], PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'lint' }] }] },
    }))
    installHooks(file, 'claude', cmd)
    expect(installHooks(file, 'claude', cmd)).toEqual({ changed: false })
    const cfg = JSON.parse(readFileSync(file, 'utf8'))
    expect(cfg.model).toBe('opus')
    expect(cfg.hooks.PreToolUse).toEqual([{ matcher: 'Bash', hooks: [{ type: 'command', command: 'lint' }] }])
    expect(cfg.hooks.Stop.map((g: { hooks: { command: string }[] }) => g.hooks[0]!.command)).toEqual(['ntfy send done', cmd])
    const cmd2 = '"/new/wechat-cc-cli" hook claude'
    expect(installHooks(file, 'claude', cmd2)).toEqual({ changed: true })
    const cfg2 = JSON.parse(readFileSync(file, 'utf8'))
    expect(cfg2.hooks.Stop.map((g: { hooks: { command: string }[] }) => g.hooks[0]!.command)).toEqual(['ntfy send done', cmd2])
    expect(cfg2.hooks.Stop).toHaveLength(2)
  })
  it('codex:hooks.json 形状同款,事件是 Stop / PermissionRequest / UserPromptSubmit / SessionEnd,没有 matcher', () => {
    const file = join(dir, '.codex', 'hooks.json')
    const c = '"/opt/bun" "/r/cli.ts" hook codex'
    installHooks(file, 'codex', c)
    const cfg = JSON.parse(readFileSync(file, 'utf8'))
    expect(Object.keys(cfg.hooks).sort()).toEqual(['PermissionRequest', 'SessionEnd', 'Stop', 'UserPromptSubmit'])
    expect(cfg.hooks.PermissionRequest[0].matcher).toBeUndefined()
    expect(cfg.hooks.PermissionRequest[0].hooks[0].command).toBe(c)
  })
  it('uninstall 只删自己的;删空的事件键一并去掉;没装过 → changed:false', () => {
    const file = join(dir, 'settings.json')
    writeFileSync(file, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'ntfy send done' }] }] } }))
    installHooks(file, 'claude', cmd)
    expect(uninstallHooks(file, 'claude')).toEqual({ changed: true, removed: 4 })
    const cfg = JSON.parse(readFileSync(file, 'utf8'))
    expect(cfg.hooks).toEqual({ Stop: [{ hooks: [{ type: 'command', command: 'ntfy send done' }] }] })
    expect(uninstallHooks(file, 'claude')).toEqual({ changed: false, removed: 0 })
    expect(hookStatus(file, 'claude')).toEqual({ installed: false, command: null })
    expect(hookStatus(join(dir, 'missing.json'), 'claude')).toEqual({ installed: false, command: null })
  })
  it('settings.json 坏了 → 抛错,不覆盖', () => {
    const file = join(dir, 'settings.json')
    writeFileSync(file, '{ not json')
    expect(() => installHooks(file, 'claude', cmd)).toThrow(/parse/)
    expect(readFileSync(file, 'utf8')).toBe('{ not json')
  })
  it('路径:claude 在 ~/.claude/settings.json;codex 认 CODEX_HOME,缺省 ~/.codex/hooks.json', () => {
    expect(claudeSettingsPath('/home/u')).toBe(join('/home/u', '.claude', 'settings.json'))
    expect(codexHooksPath('/home/u', {})).toBe(join('/home/u', '.codex', 'hooks.json'))
    expect(codexHooksPath('/home/u', { CODEX_HOME: '/x/codex' })).toBe(join('/x/codex', 'hooks.json'))
    expect(existsSync(dir)).toBe(true); mkdirSync(join(dir, 'z'))
  })
})

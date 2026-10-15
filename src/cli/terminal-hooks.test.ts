import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installHooks, hookStatus } from './hook'
import {
  commandPaths, connectTerminalHooks, disconnectTerminalHooks, hookFileFor, hookHealth, readTerminalHooks, selfHookCommand,
  type TerminalHooksDeps,
} from './terminal-hooks'

// 一律在临时 HOME / CODEX_HOME 里:绝不碰主人真的 ~/.claude/settings.json 与 ~/.codex/hooks.json。
const tmpDirs: string[] = []
let home: string
let sidecar: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'wechat-cc-term-hooks-')); tmpDirs.push(home)
  sidecar = join(home, 'App', 'tendhearth-cc-cli')
  mkdirSync(join(home, 'App'), { recursive: true }); writeFileSync(sidecar, '')
})
afterAll(() => { for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }) } catch {} } })

const deps = (over: Partial<TerminalHooksDeps> = {}): TerminalHooksDeps => ({
  home, env: { CODEX_HOME: join(home, 'codex-home') },
  self: { execPath: sidecar, compiled: true, cliEntry: '' },
  locate: (s) => `/usr/local/bin/${s}`,
  exists: existsSync,
  ...over,
})
const claudeFile = () => join(home, '.claude', 'settings.json')
const codexFile = () => join(home, 'codex-home', 'hooks.json')

describe('selfHookCommand / hookFileFor —— 与 `wechat-cc hook install` 同一个出处', () => {
  it('编译包:sidecar 自己;源码模式:bun + cli.ts', () => {
    expect(selfHookCommand('claude', { execPath: '/A/tendhearth-cc-cli', compiled: true, cliEntry: '' })).toBe('"/A/tendhearth-cc-cli" hook claude')
    expect(selfHookCommand('codex', { execPath: '/b/bun', compiled: false, cliEntry: '/r/cli.ts' })).toBe('"/b/bun" "/r/cli.ts" hook codex')
  })
  it('codex 认 CODEX_HOME,缺省 ~/.codex', () => {
    expect(hookFileFor('claude', '/h', {})).toBe(join('/h', '.claude', 'settings.json'))
    expect(hookFileFor('codex', '/h', { CODEX_HOME: '/x' })).toBe(join('/x', 'hooks.json'))
    expect(hookFileFor('codex', '/h', {})).toBe(join('/h', '.codex', 'hooks.json'))
  })
})

describe('状态判定', () => {
  it('commandPaths 只取引号里的绝对路径', () => {
    expect(commandPaths(`"${join(home, 'bun')}" "${join(home, 'cli.ts')}" hook claude`)).toEqual([join(home, 'bun'), join(home, 'cli.ts')])
    expect(commandPaths('wechat-cc hook claude')).toEqual([])
  })
  it('missing / ok / stale(程序或源码脚本不在了)', () => {
    const okBin = join(home, 'ok-bin'), okCli = join(home, 'ok-cli.ts'), gone = join(home, 'gone', 'tendhearth-cc-cli')
    const exists = (p: string) => p === okBin || p === okCli
    expect(hookHealth({ installed: false, command: null }, exists)).toBe('missing')
    expect(hookHealth({ installed: true, command: `"${okBin}" hook claude` }, exists)).toBe('ok')
    expect(hookHealth({ installed: true, command: `"${okBin}" "${okCli}" hook claude` }, exists)).toBe('ok')
    expect(hookHealth({ installed: true, command: `"${gone}" hook claude` }, exists)).toBe('stale')
    expect(hookHealth({ installed: true, command: `"${okBin}" "${join(home, 'gone.ts')}" hook claude` }, exists)).toBe('stale')
    expect(hookHealth({ installed: true, command: null }, exists)).toBe('stale')
  })
  it('readTerminalHooks:没装 / 装了指向自己 / 指向不在的位置 / 指向另一份还在的安装', () => {
    expect(readTerminalHooks(deps()).map(s => [s.source, s.health, s.installed])).toEqual([['claude', 'missing', false], ['codex', 'missing', false]])
    installHooks(claudeFile(), 'claude', selfHookCommand('claude', deps().self))
    installHooks(codexFile(), 'codex', `"${join(home, 'Old.app', 'wechat-cc-cli')}" hook codex`)
    const [c, x] = readTerminalHooks(deps())
    expect(c).toMatchObject({ source: 'claude', cli: '/usr/local/bin/claude', file: claudeFile(), installed: true, health: 'ok', matchesSelf: true })
    expect(x).toMatchObject({ source: 'codex', file: codexFile(), installed: true, health: 'stale', matchesSelf: false })
    const other = join(home, 'other-bun'); writeFileSync(other, '')
    installHooks(codexFile(), 'codex', `"${other}" "${other}" hook codex`)
    expect(readTerminalHooks(deps())[1]).toMatchObject({ health: 'ok', matchesSelf: false })
  })
})

describe('connectTerminalHooks / disconnectTerminalHooks(幂等,只动自家条目)', () => {
  const onlyClaude = (s: 'claude' | 'codex') => s === 'claude' ? '/usr/local/bin/claude' : null
  it('缺省只接这台机上有、还没接好的;再点一次什么都不做', () => {
    const cmd = selfHookCommand('claude', deps().self)
    expect(connectTerminalHooks(deps({ locate: onlyClaude }))).toEqual([{ source: 'claude', ok: true, file: claudeFile(), changed: true, command: cmd }])
    expect(existsSync(codexFile())).toBe(false)   // 没装 codex ⇒ 不碰它的配置
    expect(hookStatus(claudeFile(), 'claude')).toEqual({ installed: true, command: cmd })
    const before = readFileSync(claudeFile(), 'utf8')
    expect(connectTerminalHooks(deps({ locate: onlyClaude }))).toEqual([])
    expect(connectTerminalHooks(deps(), ['claude'])).toEqual([{ source: 'claude', ok: true, file: claudeFile(), changed: false, command: cmd }])
    expect(readFileSync(claudeFile(), 'utf8')).toBe(before)
  })
  it('修复:stale 的改成自己;主人别的 hook 与设置原样保留', () => {
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(claudeFile(), JSON.stringify({ model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } }))
    installHooks(claudeFile(), 'claude', `"${join(home, 'gone', 'wechat-cc-cli')}" hook claude`)
    const r = connectTerminalHooks(deps({ locate: () => null }))   // PATH 里找不到,但装过 ⇒ 仍算这台机上有
    expect(r.map(x => [x.source, x.ok, x.changed])).toEqual([['claude', true, true]])
    const cfg = JSON.parse(readFileSync(claudeFile(), 'utf8'))
    expect(cfg.model).toBe('opus')
    expect(JSON.stringify(cfg.hooks.Stop)).toContain('say done')
    expect(readTerminalHooks(deps())[0]).toMatchObject({ health: 'ok', matchesSelf: true })
  })
  it('点名一家但这台机上没有 ⇒ skipped,不写文件', () => {
    expect(connectTerminalHooks(deps({ locate: () => null }), ['codex'])).toEqual([{ source: 'codex', ok: false, file: codexFile(), skipped: 'cli_not_found' }])
    expect(existsSync(codexFile())).toBe(false)
  })
  it('配置文件坏了 ⇒ 这一家 ok:false 带原因,不覆盖主人的文件', () => {
    mkdirSync(join(home, '.claude'), { recursive: true }); writeFileSync(claudeFile(), '{not json')
    const [c] = connectTerminalHooks(deps(), ['claude'])
    expect(c).toMatchObject({ source: 'claude', ok: false })
    expect(c!.error).toContain('cannot parse')
    expect(readFileSync(claudeFile(), 'utf8')).toBe('{not json')
  })
  it('撤掉:只删自家条目;再撤一次 changed:false', () => {
    connectTerminalHooks(deps())
    const r = disconnectTerminalHooks(deps())
    expect(r.map(x => [x.source, x.ok, x.changed, (x.removed ?? 0) > 0])).toEqual([['claude', true, true, true], ['codex', true, true, true]])
    expect(disconnectTerminalHooks(deps()).map(x => x.changed)).toEqual([false, false])
    expect(readTerminalHooks(deps()).map(s => s.health)).toEqual(['missing', 'missing'])
  })
})

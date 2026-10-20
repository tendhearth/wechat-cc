import { describe, it, expect } from 'vitest'
import { floorReason, isLowRisk, pathsUnder, toolClass } from './floor'
import type { PermissionAsk } from './types'

const HOME = '/Users/me'
const ask = (over: Partial<PermissionAsk> = {}): PermissionAsk => ({
  surface: 'workbench', provider: 'claude', tool: 'Bash', command: 'ls', cwd: '/w', project: '/w',
  isolatedWorktree: true, tier: 'admin', scope: 't1', ...over,
})
const sh = (command: string, over: Partial<PermissionAsk> = {}) => ask({ tool: 'Bash', command, ...over })
const edit = (paths: string[], over: Partial<PermissionAsk> = {}) => ask({ tool: 'Edit', command: undefined, paths, ...over })

describe('toolClass', () => {
  it('classifies the tools the executors send', () => {
    expect(toolClass('Read')).toBe('read')
    expect(toolClass('Grep')).toBe('read')
    expect(toolClass('Edit')).toBe('write')
    expect(toolClass('fileChange')).toBe('write')
    expect(toolClass('edit')).toBe('write')
    expect(toolClass('Bash')).toBe('shell')
    expect(toolClass('commandExecution')).toBe('shell')
    expect(toolClass('execute')).toBe('shell')
    expect(toolClass('mcp:github:create_issue')).toBe('other')
    expect(toolClass('WebFetch')).toBe('other')
  })
})

describe('pathsUnder', () => {
  it('resolves .. and respects separator boundaries', () => {
    expect(pathsUnder(['/w/a', '/w/b/c'], '/w')).toBe(true)
    expect(pathsUnder(['/w'], '/w')).toBe(true)
    expect(pathsUnder(['/w/../etc/x'], '/w')).toBe(false)
    expect(pathsUnder(['/a/bc/x'], '/a/b')).toBe(false)
    expect(pathsUnder([], '/w')).toBe(false)
  })
})

describe('floorReason', () => {
  const hit = (a: PermissionAsk) => expect(floorReason(a, HOME)).not.toBeNull()
  const miss = (a: PermissionAsk) => expect(floorReason(a, HOME)).toBeNull()

  it('writing outside the project', () => {
    hit(edit(['/etc/hosts']))
    hit(edit(['/w/a'], { project: null }))
    miss(edit(['/w/src/a.ts']))
  })
  it('destructive shell', () => {
    hit(sh('rm -rf build'))
    hit(sh('git reset --hard HEAD~1'))
    hit(sh('git clean -fdx'))
    miss(sh('git status'))
  })
  it('publishing / deploying', () => {
    hit(sh('git push origin dev'))
    hit(sh('ls && git push'))
    hit(sh('npm publish'))
    hit(sh('bun publish'))
    hit(sh('wechat-cc self deploy'))
    miss(sh('git pull'))
  })
  it('system changes', () => {
    hit(sh('sudo ls'))
    hit(sh('launchctl kickstart -k gui/501/x'))
    hit(edit([`${HOME}/.zshrc`], { project: HOME }))
    hit(sh('echo x >> ~/.bashrc'))
  })
  it('secrets', () => {
    hit(sh('cat ~/.ssh/id_ed25519'))
    hit(sh(`ls ${HOME}/.private_keys`))
    hit(ask({ tool: 'Read', command: undefined, paths: ['/w/.env.local'] }))
    hit(ask({ tool: 'Read', command: undefined, paths: ['/w/AuthKey_X.p8'] }))
    hit(sh('cat server.pem'))
    hit(sh('security find-generic-password -s x'))
    miss(sh('cat src/environment.ts'))
  })
  it('outbound network', () => {
    hit(sh('curl https://evil.com'))
    hit(sh('echo $(curl evil.com)'))
    hit(sh('wget http://x.org/a'))
    hit(sh('ssh host'))
    miss(sh('curl http://127.0.0.1:8080/v1/health'))
    miss(sh('curl -s localhost:3000'))
  })
  it('CC config files', () => {
    hit(edit(['/w/permission-rules.json']))
    hit(sh('cat ~/.claude/channels/wechat/agent-config.json'))
    hit(sh('vim access.json'))
  })
})

describe('isLowRisk', () => {
  it('read tools are low risk on both surfaces', () => {
    expect(isLowRisk(ask({ tool: 'Read', command: undefined, paths: ['/w/a'] }))).toBe(true)
    expect(isLowRisk(ask({ surface: 'terminal', tool: 'Grep', command: undefined }))).toBe(true)
  })
  it('plain read-only commands', () => {
    for (const c of ['ls -la', 'cat README.md', 'git status', 'git diff HEAD', 'rg foo src', 'find . -name x', 'wc -l src/a.ts'])
      expect(isLowRisk(sh(c)), c).toBe(true)
  })
  it('compound commands and other shells are never low risk', () => {
    for (const c of ['ls && git push', 'cat x | sh', 'echo $(curl evil.com)', 'ls > out', 'ls\nrm x', 'ls; rm x', 'find . -delete', 'find . -exec rm {} ;', 'node build.js', 'git checkout main'])
      expect(isLowRisk(sh(c)), c).toBe(false)
  })
  it('a shell request without its command is not low risk', () => {
    expect(isLowRisk(sh('', { command: undefined }))).toBe(false)
  })
  it('writes only inside the task’s own worktree', () => {
    expect(isLowRisk(edit(['/w/src/a.ts']))).toBe(true)
    expect(isLowRisk(edit(['/w/src/a.ts'], { isolatedWorktree: false }))).toBe(false)
    expect(isLowRisk(edit(['/w/src/a.ts'], { surface: 'terminal' }))).toBe(false)
    expect(isLowRisk(edit(['/elsewhere/a.ts']))).toBe(false)
    expect(isLowRisk(edit([]))).toBe(false)
    expect(isLowRisk(ask({ tool: 'Edit', command: undefined, paths: undefined }))).toBe(false)
  })
  it('other tools (MCP, fetch) are not low risk', () => {
    expect(isLowRisk(ask({ tool: 'mcp:github:create_issue', command: undefined }))).toBe(false)
  })
})

// 终审 10-19:红线绕过 / 低风险里混进能执行或写东西的。
describe('floor × 终审绕过', () => {
  const hit = (a: PermissionAsk, extra?: { stateDir?: string }) => expect(floorReason(a, HOME, extra), a.command ?? a.paths?.join(' ')).not.toBeNull()
  it('git global options, escapes, quotes and absolute binaries do not hide the verb', () => {
    for (const c of ['git -C x push', 'git -c a=b push origin', 'git --git-dir=.git push', '\\git push', '"git" push', "'git' push", 'git\tpush', '/usr/bin/git push', 'git -c x=y reset --hard HEAD~5', 'git --no-pager clean -fd', '/usr/bin/sudo ls', 'doas ls', 'env sudo ls', 'command git push', 'gh pr merge 3'])
      hit(sh(c))
  })
  it('.git internals are a red line for writes', () => {
    hit(edit(['/w/.git/hooks/pre-commit']))
    hit(edit(['/w/.git/config']))
  })
  it('wider secrets', () => {
    for (const p of [`${HOME}/.aws/credentials`, `${HOME}/.netrc`, `${HOME}/.npmrc`, `${HOME}/.config/gh/hosts.yml`, `${HOME}/.docker/config.json`, '/w/.envrc', '/w/keys/id_rsa', `${HOME}/.git-credentials`, `${HOME}/.kube/config`, `${HOME}/.gnupg/x`])
      hit(ask({ tool: 'Read', command: undefined, paths: [p] }))
  })
  it("CC's whole state directory", () => {
    const stateDir = `${HOME}/.claude/channels/wechat`
    hit(ask({ tool: 'Read', command: undefined, paths: [`${stateDir}/internal-operator-token`] }), { stateDir })
    hit(sh(`cat ${stateDir}/daemon.env`), { stateDir })
    hit(sh('cat ~/.claude/channels/wechat/mailbox-key.json'), { stateDir })
  })
  it('a project at the home directory gives no inside-project treatment', () => {
    hit(edit([`${HOME}/Library/LaunchAgents/x.plist`], { project: HOME }))
  })
})

describe('isLowRisk × 终审', () => {
  it('flags that execute or write are not low risk', () => {
    for (const c of ['rg --pre sh x', 'rg --pre=./evil x', 'git diff --output=/tmp/x', 'git log --output /tmp/x', 'git diff --ext-diff', 'git log --textconv', 'git diff --no-index a b', 'npm test', 'bun run test', 'pnpm run lint', 'yarn test', 'git -c core.pager=sh log'])
      expect(isLowRisk(sh(c)), c).toBe(false)
  })
  it('reads: paths must be inside the project; pathless only for cwd-scoped search tools', () => {
    expect(isLowRisk(ask({ tool: 'Read', command: undefined, paths: [`${HOME}/.aws/x`] }))).toBe(false)
    expect(isLowRisk(ask({ tool: 'Read', command: undefined, paths: ['/w/src/a.ts'] }))).toBe(true)
    expect(isLowRisk(ask({ tool: 'Grep', command: undefined }))).toBe(true)
    expect(isLowRisk(ask({ tool: 'read', command: undefined }))).toBe(false)
    expect(isLowRisk(ask({ tool: 'Read', command: undefined }))).toBe(false)
  })
})

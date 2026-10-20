import { describe, it, expect } from 'vitest'
import { canonPath, pathsUnder } from './paths'
import { matchRule } from './rules-file'
import { floorReason, isLowRisk } from './floor'
import type { PermissionAsk } from './types'

// Windows CI 10-20:大小写、\ 与 /、盘符 —— 用 path.win32 在任何平台上模拟。
describe('paths on win32', () => {
  it('canonPath folds case and separators, resolves ..', () => {
    expect(canonPath('C:\\Users\\Me\\Proj\\..\\Other\\A.ts', 'win32')).toBe('c:/users/me/other/a.ts')
    expect(canonPath('c:/users/me/x', 'win32')).toBe('c:/users/me/x')
    expect(canonPath('/a/b/../c', 'darwin')).toBe('/a/c')
  })
  it('pathsUnder ignores case and separator style, keeps segment boundaries', () => {
    expect(pathsUnder(['C:\\Work\\Proj\\src\\a.ts'], 'c:/work/proj', 'win32')).toBe(true)
    expect(pathsUnder(['src\\a.ts'], 'C:\\Work\\Proj', 'win32')).toBe(true)
    expect(pathsUnder(['C:\\Work\\ProjX\\a.ts'], 'C:\\Work\\Proj', 'win32')).toBe(false)
    expect(pathsUnder(['C:\\Work\\Proj\\..\\x'], 'C:\\Work\\Proj', 'win32')).toBe(false)
  })
  const ask = (over: Partial<PermissionAsk>): PermissionAsk => ({ surface: 'workbench', provider: 'claude', tool: 'Edit', cwd: null, project: 'C:\\Work\\Proj', isolatedWorktree: true, tier: 'admin', scope: 't', ...over })
  it('rule globs and project prefixes match Windows paths', () => {
    expect(matchRule([{ id: 'g', when: { paths: 'C:/Work/Proj/src/**' }, then: 'allow' }], ask({ paths: ['c:\\work\\proj\\src\\deep\\a.ts'] }), 'win32')).not.toBeNull()
    expect(matchRule([{ id: 'g', when: { paths: 'C:/Work/Proj/src/*' }, then: 'allow' }], ask({ paths: ['C:\\Work\\Proj\\src\\deep\\a.ts'] }), 'win32')).toBeNull()
    expect(matchRule([{ id: 'p', when: { project: 'c:\\work' }, then: 'allow' }], ask({ paths: ['C:\\Work\\Proj\\a'] }), 'win32')).not.toBeNull()
  })
  it("the state directory red line holds across case and separators", () => {
    const stateDir = 'C:\\Users\\Me\\.claude\\channels\\wechat'
    expect(floorReason(ask({ tool: 'Read', paths: ['c:/users/me/.claude/channels/wechat/internal-operator-token'] }), 'C:\\Users\\Me', { stateDir, platform: 'win32' })).not.toBeNull()
    expect(floorReason(ask({ tool: 'Bash', command: 'type C:\\USERS\\ME\\.CLAUDE\\CHANNELS\\WECHAT\\daemon.env' }), 'C:\\Users\\Me', { stateDir, platform: 'win32' })).not.toBeNull()
  })
})

describe('shell reads stay inside the project (2a 10-20)', () => {
  const sh = (command: string): PermissionAsk => ({ surface: 'terminal', provider: 'claude', tool: 'Bash', command, cwd: '/w', project: '/w', isolatedWorktree: false, tier: 'admin', scope: 's' })
  it('absolute paths, ~ and .. in arguments are not low risk', () => {
    for (const c of ['cat ~/Library/Messages/chat.db', 'grep -r x ~', 'cat /etc/passwd', 'ls ../other', 'rg foo /Users', 'head ~/x'])
      expect(isLowRisk(sh(c)), c).toBe(false)
    for (const c of ['cat src/a.ts', 'grep -rn foo src', 'ls -la', 'git log -3'])
      expect(isLowRisk(sh(c)), c).toBe(true)
  })
})

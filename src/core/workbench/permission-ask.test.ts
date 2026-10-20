import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, symlinkSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { workbenchAsk } from './permission-ask'

describe('workbenchAsk', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'wb-ask-')))
  const proj = join(base, 'proj'), tree = join(base, 'tree')
  mkdirSync(proj); mkdirSync(tree)

  it('a live worktree is the project and marks the request isolated', () => {
    const a = workbenchAsk({ id: 't1', path: proj, providerId: 'codex' }, { root: tree, removedAt: null }, '修登录', { tool: 'fileChange', paths: [join(tree, 'a.ts')] })
    expect(a).toEqual({ surface: 'workbench', provider: 'codex', tool: 'fileChange', paths: [join(tree, 'a.ts')], cwd: null, project: tree, isolatedWorktree: true, intent: '修登录', tier: 'admin', scope: 't1' })
  })
  it('no worktree / removed worktree ⇒ the task path, not isolated', () => {
    expect(workbenchAsk({ id: 't', path: proj, providerId: 'claude' }, null, null, { tool: 'Bash', command: 'ls' })).toMatchObject({ project: proj, isolatedWorktree: false, command: 'ls' })
    expect(workbenchAsk({ id: 't', path: proj, providerId: 'claude' }, { root: tree, removedAt: 5 }, null, { tool: 'Bash' })).toMatchObject({ project: proj, isolatedWorktree: false })
  })
  it('the project root is realpath-ed (a symlinked task path)', () => {
    const link = join(base, 'link'); symlinkSync(proj, link)
    expect(workbenchAsk({ id: 't', path: link, providerId: 'claude' }, null, null, { tool: 'Read' }).project).toBe(proj)
  })
  it('a vanished project path ⇒ null project', () => {
    expect(workbenchAsk({ id: 't', path: join(base, 'gone'), providerId: 'claude' }, null, null, { tool: 'Read' }).project).toBeNull()
  })
  it('intent is clipped to 2000 and omitted when empty', () => {
    expect(workbenchAsk({ id: 't', path: proj, providerId: 'claude' }, null, 'x'.repeat(3000), { tool: 'Read' }).intent!.length).toBe(2000)
    expect(workbenchAsk({ id: 't', path: proj, providerId: 'claude' }, null, '  ', { tool: 'Read' })).not.toHaveProperty('intent')
  })
  it('carries the executor description for the reviewer', () => {
    expect(workbenchAsk({ id: 't', path: proj, providerId: 'codex' }, null, null, { tool: 'fileChange', description: '-a\n+b', paths: [join(proj, 'a')] }).description).toBe('-a\n+b')
  })
})

import { afterEach, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeTempDir } from '../../lib/test-temp'
import { inspectPermissionCommand } from './permission-command'
import { makeRunPermissions } from './permissions'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach(removeTempDir))

it.each([
  ['/opt/homebrew/bin/bun install --frozen-lockfile', []],
  ['bun install --frozen-lockfile', []],
  ['python3 ./x.py', ['x.py']],
  ['python3 -W default ./x.py', ['x.py']],
  ['node --conditions development ./x.js', ['x.js']],
  ['node --test --test-name-pattern smoke ./x.js', ['x.js']],
  ['node --test --test-reporter spec ./x.js', ['x.js']],
  ['env -i python3 ./x.py', ['x.py']],
  ['env -u UNUSED python3 ./x.py', ['x.py']],
  ['env MODE=one bun ./x.js', ['x.js']],
  ['env -i bun ./x.js', ['x.js']],
  ['bun ./x.js --output ./data.ts', ['x.js']],
  ['bun ./x.js -- ./data.ts', ['x.js']],
  ['bun --bun ./x.js', ['x.js']],
  ['bun --no-env-file ./x.js', ['x.js']],
  ['bun --conditions development ./x.js', ['x.js']],
  ['bun --bun run ./x.js', ['x.js']],
  ['bun --bun vitest run ./data.ts', []],
  ['./scripts/x.sh', ['scripts/x.sh']],
  ['bash --rcfile ./config.sh ./scripts/x.sh', ['scripts/x.sh']],
  ['node /abs/outside.js', []],
  ['/opt/homebrew/bin/custom-program', []],
  ['/bin/zsh -lc "/opt/homebrew/bin/bun install --frozen-lockfile"', []],
  ['/bin/bash -lc "python3 ./x.py"', []],
  ['cat ./x.py', []],
  ['echo node ./x.py', []],
  ['python3 ./scripts/../x.py', ['x.py']],
] as const)('#889: classifies and presents %s without external or command-text script paths', async (command, paths) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-command-card-'))); roots.push(root)
  mkdirSync(join(root, 'scripts'))
  writeFileSync(join(root, 'x.py'), 'print("preview-source")\n')
  writeFileSync(join(root, 'x.js'), 'console.log("preview-source")\n')
  writeFileSync(join(root, 'data.ts'), 'data operand\n')
  writeFileSync(join(root, 'config.sh'), 'echo config\n')
  writeFileSync(join(root, 'scripts/x.sh'), 'echo preview-source\n')
  const options = { taskId: 'task', provider: 'codex', root,
    executionEnvironment: () => ({ kind: 'direct' as const, env: { PATH: '/usr/bin:/bin' } }) }
  const snapshot = inspectPermissionCommand({ tool: 'Bash', command, cwd: root }, options)
  expect(snapshot.scripts.map(s => s.path)).toEqual(paths)
  expect(snapshot.hash).toBeUndefined()
  const permissions = makeRunPermissions(options)
  const pending = permissions.request({ tool: 'Bash', command, description: command, cwd: root })
  const card = permissions.pending()[0]!
  expect((card.scripts ?? []).map(s => s.path)).toEqual(paths)
  expect(card.scripts?.some(s => s.path.startsWith('../')) ?? false).toBe(false)
  for (const script of card.scripts ?? []) {
    if (command.includes('/../')) expect(script.error).toBe('无法安全读取此脚本')
    else {
      expect(script.content).toContain('preview-source')
      expect(script.sha256).toMatch(/^[a-f0-9]{64}$/)
      expect(script.error).toBeUndefined()
    }
  }
  expect(card.canAllowTask).not.toBe(true)
  expect(permissions.resolve(card.id, 'allow_task')).toBe(false)
  const notice = permissions.notice(card.id)!
  expect(notice).not.toContain('preview-source')
  expect(notice).not.toContain('无法安全读取此脚本')
  expect(permissions.resolve(card.id, 'allow')).toBe(true)
  expect(await pending).toBe(true)
  const next = permissions.request({ tool: 'Bash', command, description: command, cwd: root })
  expect(permissions.pending()).toHaveLength(1)
  permissions.rejectAll(); expect(await next).toBe(false)
})

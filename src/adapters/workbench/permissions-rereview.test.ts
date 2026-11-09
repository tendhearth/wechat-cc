import { afterEach, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeRunPermissions } from './permissions'
import { inspectPermissionCommand } from './permission-command'
import * as executables from './permission-executable'

const cleanups: Array<() => void> = []
afterEach(() => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) cleanup() })
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-approval-rereview-')))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'check.py'), 'print("first")\n')
  writeFileSync(join(root, 'check.ts'), 'console.log("first")\n')
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { verify: 'echo checking' } }))
  return root
}

const ONE_SHOT_COMMANDS = [
  'python3 check.py', 'bun check.ts', "python3 <<'PY'\nprint('hello')\nPY",
  'git status\ngit diff --stat', 'bun run verify', "bun --bun vitest run check.test.ts -t 'normal case'",
  'git status', 'MODE=one echo ok',
]

it.each(ONE_SHOT_COMMANDS)('R2: one-shot owner approval of %s accepts exactly this request and creates no grant', async command => {
  const root = fixture(), permissions = makeRunPermissions({ taskId: 'task', provider: 'codex', root })
  cleanups.push(() => permissions.rejectAll())
  const request = () => permissions.request({ tool: 'commandExecution', command, description: command, cwd: root })
  const first = request(), card = permissions.pending()[0]!
  expect(card.canAllowTask).not.toBe(true)
  expect(permissions.resolve(card.id, 'allow')).toBe(true)
  expect(await first).toBe(true)
  expect(permissions.resolve(card.id, 'allow')).toBe(false)
  expect(card.description).toContain('预览是批准时的快照，运行以当时内容为准')
  const next = request()
  expect(permissions.pending()).toHaveLength(1)
  expect(permissions.resolve(permissions.pending()[0]!.id, 'allow_task')).toBe(false)
  permissions.resolve(permissions.pending()[0]!.id, 'deny'); expect(await next).toBe(false)
})

it('R2: an edited script remains a one-shot invocation approval, not a byte authorization', async () => {
  const root = fixture(), permissions = makeRunPermissions({ taskId: 'task', provider: 'codex', root })
  const answer = permissions.request({ tool: 'Bash', command: 'python3 check.py', description: 'python3 check.py', cwd: root })
  const card = permissions.pending()[0]!
  writeFileSync(join(root, 'check.py'), 'print("runtime content")\n')
  expect(card.scripts?.[0]?.content).toBe('print("first")\n')
  expect(permissions.resolve(card.id, 'allow')).toBe(true)
  expect(await answer).toBe(true)
  expect(permissions.resolve(card.id, 'allow_task')).toBe(false)
})

it.skipIf(process.platform === 'win32')('R2: inherited writable PATH bin/ls cannot obtain or reuse task permission after replacement', async () => {
  const root = fixture(), bin = join(root, 'bin'); mkdirSync(bin)
  const executable = join(bin, 'ls'), executionPath = `${bin}:/usr/bin:/bin`
  writeFileSync(executable, '#!/bin/sh\nprintf %s FIRST\n', { mode: 0o755 })
  const options = { taskId: 'task', provider: 'codex', root, executionEnvironment: () => ({ kind: 'direct' as const, env: { PATH: executionPath } }) }
  const permissions = makeRunPermissions(options); cleanups.push(() => permissions.rejectAll())
  const request = () => permissions.request({ tool: 'Bash', command: 'ls', description: 'ls', cwd: root })
  const first = request(), card = permissions.pending()[0]!
  const taskAccepted = permissions.resolve(card.id, 'allow_task')
  if (!taskAccepted) permissions.resolve(card.id, 'allow')
  expect(await first).toBe(true)
  const run = () => spawnSync('ls', [], { cwd: root, env: { PATH: executionPath }, encoding: 'utf8' }).stdout
  expect(run()).toBe('FIRST')
  writeFileSync(executable, '#!/bin/sh\nprintf %s SECOND\n')
  const second = request(), askedAgain = permissions.pending().length === 1
  if (askedAgain) permissions.resolve(permissions.pending()[0]!.id, 'allow')
  expect(await second).toBe(true); expect(run()).toBe('SECOND')
  expect(taskAccepted).toBe(false)
  expect(card.canAllowTask).not.toBe(true)
  expect(askedAgain).toBe(true)
})

it.skipIf(process.platform === 'win32')('R2: protected executable identity enters the hash and PATH is resolved again on every reuse', async () => {
  const root = fixture(); let executionPath = '/usr/bin:/bin'
  const options = { taskId: 'task', provider: 'codex', root, executionEnvironment: () => ({ kind: 'direct' as const, env: { PATH: executionPath } }) }
  const snapshot = inspectPermissionCommand({ tool: 'Bash', command: 'ls', cwd: root }, options)
  expect(snapshot).toHaveProperty('executable.path', realpathSync('/bin/ls'))
  expect(snapshot).toHaveProperty('executable.sha256', expect.stringMatching(/^[a-f0-9]{64}$/))
  const permissions = makeRunPermissions(options); cleanups.push(() => permissions.rejectAll())
  const request = () => permissions.request({ tool: 'Bash', command: 'ls', description: 'ls', cwd: root })
  const first = request(); expect(permissions.resolve(permissions.pending()[0]!.id, 'allow_task')).toBe(true)
  expect(await first).toBe(true); expect(await request()).toBe(true)
  expect(spawnSync('ls', [], { cwd: root, env: { PATH: executionPath }, encoding: 'utf8' }).status).toBe(0)
  const bin = join(root, 'bin'); mkdirSync(bin); writeFileSync(join(bin, 'ls'), '#!/bin/sh\necho changed\n', { mode: 0o755 })
  executionPath = `${bin}:/usr/bin:/bin`
  expect(inspectPermissionCommand({ tool: 'Bash', command: 'ls', cwd: root }, options).hash).toBeUndefined()
  const changed = request(); expect(permissions.pending()).toHaveLength(1)
  permissions.resolve(permissions.pending()[0]!.id, 'deny'); expect(await changed).toBe(false)
})

it.each(['ls', '/bin/ls'])('R2: unknown execution environment never grants %s based on daemon PATH or absolute spelling', async command => {
  const root = fixture(), permissions = makeRunPermissions({ taskId: 'task', provider: 'codex', root })
  const answer = permissions.request({ tool: 'Bash', command, description: command, cwd: root })
  const card = permissions.pending()[0]!
  expect(card.canAllowTask).not.toBe(true)
  expect(permissions.resolve(card.id, 'allow_task')).toBe(false)
  permissions.resolve(card.id, 'allow'); expect(await answer).toBe(true)
})

it.skipIf(process.platform === 'win32')('R2: the same path and bytes with a new executable file identity invalidate the command hash', () => {
  const root = fixture(), options = { taskId: 'task', provider: 'codex', root, executionEnvironment: () => ({ kind: 'direct' as const, env: { PATH: '/usr/bin:/bin' } }) }
  const inspect = () => inspectPermissionCommand({ tool: 'Bash', command: 'ls', cwd: root }, options)
  const before = inspect(); expect(before.hash).toBeTruthy(); expect(inspect().hash).toBe(before.hash)
  const original = before.executable!
  // Simulate an OS replacement at the executable inspection boundary, without
  // modifying any system file. Path and file bytes deliberately remain equal.
  vi.spyOn(executables, 'inspectPermissionExecutable').mockReturnValue({ ...original, identity: original.identity.map((value, i) => i === 1 ? String(BigInt(value) + 1n) : value) })
  const after = inspect()
  expect(after.executable?.path).toBe(original.path)
  expect(after.executable?.sha256).toBe(original.sha256)
  expect(after.hash).not.toBe(before.hash)
})

it.skipIf(process.platform === 'win32')('R2: a shell function can shadow a system absolute name, so a CLI boolean cannot certify its identity', () => {
  const result = spawnSync('/bin/bash', ['--noprofile', '--norc', '-c', 'function /bin/echo() { builtin printf SHADOWED; }; /bin/echo SYSTEM'], { env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8' })
  expect(result.status).toBe(0); expect(result.stdout).toBe('SHADOWED')
  const root = fixture()
  expect(inspectPermissionCommand({ tool: 'Bash', command: '/bin/echo SYSTEM', cwd: root }, { taskId: 'task', provider: 'codex', root }).hash).toBeUndefined()
})

it.runIf(process.platform === 'win32')('R2: Windows without verified protected ACLs remains one-shot even with an execution contract', async () => {
  const root = fixture(), permissions = makeRunPermissions({ taskId: 'task', provider: 'codex', root, executionEnvironment: () => ({ kind: 'direct', env: { PATH: '/usr/bin:/bin' } }) })
  const answer = permissions.request({ tool: 'Bash', command: 'ls', description: 'ls', cwd: root }), card = permissions.pending()[0]!
  expect(card.canAllowTask).not.toBe(true)
  expect(permissions.resolve(card.id, 'allow_task')).toBe(false)
  expect(permissions.resolve(card.id, 'allow')).toBe(true)
  expect(await answer).toBe(true)
})

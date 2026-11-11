import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeRunPermissions, type PermissionDecide } from './permissions'
import { inspectPermissionCommand, literalCommand } from './permission-command'
import { decide } from '../permission-rules/decide'
import { floorReason } from '../permission-rules/floor'

const cleanup: Array<() => void> = []
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn() })
function fixture(provider = 'codex', gate?: PermissionDecide) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-approval-security-')))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const permissions = makeRunPermissions({ taskId: 'task', provider, root, decide: gate, executionEnvironment: () => ({ kind: 'direct', env: { PATH: '/usr/bin:/bin' } }) })
  cleanup.push(() => permissions.rejectAll())
  const request = (command: string) => permissions.request({ tool: 'Bash', command, description: command, cwd: root })
  const inspect = (command: string) => inspectPermissionCommand({ tool: 'Bash', command, cwd: root }, { taskId: 'task', provider, root, executionEnvironment: () => ({ kind: 'direct', env: { PATH: '/usr/bin:/bin' } }) })
  return { root, permissions, request, inspect }
}

it.each(['cursor', 'custom-acp', 'agy', ''])('P1-1: %s cannot establish a task grant through the real shared gate or a missing gate', async provider => {
  for (const wired of [true, false]) for (const command of ['git status', 'echo ok']) {
    let root = ''
    const gate: PermissionDecide = facts => decide({ ...facts, surface: 'workbench', provider, tier: 'admin', scope: 'task', cwd: root, project: root, isolatedWorktree: false },
      { version: 1, enabled: true, review: 'off', rules: [{ id: 'read', when: { surface: 'workbench', tool: 'Bash' }, then: 'allow' }] }, {})
    const f = fixture(provider, wired ? gate : undefined); root = f.root
    const answer = f.request(command)
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    const card = f.permissions.pending()[0]!
    expect(card.canAllowTask).not.toBe(true)
    expect(f.permissions.resolve(card.id, 'allow_task')).toBe(false)
    f.permissions.resolve(card.id, 'deny'); expect(await answer).toBe(false)
    const next = f.request(command)
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(f.permissions.pending()).toHaveLength(1)
    f.permissions.rejectAll(); expect(await next).toBe(false)
  }
})

it.skipIf(process.platform === 'win32')('P1-1: a failed gate cannot create a grant; an existing task grant cannot override later rule ask/deny', async () => {
  const broken = fixture('codex', async () => { throw Error('gate unavailable') })
  const answer = broken.request('echo ok')
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  expect(broken.permissions.pending()[0]!.canAllowTask).not.toBe(true)
  broken.permissions.rejectAll(); expect(await answer).toBe(false)
  let ruling: Awaited<ReturnType<PermissionDecide>> = { verdict: 'ask', by: 'default' }
  const f = fixture('codex', async () => ruling)
  const first = f.request('echo ok')
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  expect(f.permissions.resolve(f.permissions.pending()[0]!.id, 'allow_task')).toBe(true)
  expect(await first).toBe(true)
  ruling = { verdict: 'ask', by: 'rule' }
  const ask = f.request('echo ok')
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  expect(f.permissions.pending()[0]!.canAllowTask).not.toBe(true)
  f.permissions.resolve(f.permissions.pending()[0]!.id, 'deny'); expect(await ask).toBe(false)
  ruling = { verdict: 'deny', by: 'rule' }
  expect(await f.request('echo ok')).toBe(false)
})

it.each(['source ./helper', '. ./helper'])('P1-2: reads the extensionless entry of %s and never grants reuse', async command => {
  const f = fixture(); writeFileSync(join(f.root, 'helper'), 'echo original\n')
  const first = f.request(command), card = f.permissions.pending()[0]!
  expect(card.scripts?.[0]).toMatchObject({ path: 'helper', content: 'echo original\n', sha256: expect.any(String) })
  expect(card.canAllowTask).not.toBe(true)
  expect(f.permissions.resolve(card.id, 'allow_task')).toBe(false)
  f.permissions.resolve(card.id, 'deny'); expect(await first).toBe(false)
  writeFileSync(join(f.root, 'helper'), 'GIT push\n')
  const next = f.request(command), changed = f.permissions.pending()[0]!
  expect(changed.scripts?.[0]?.content).toBe('GIT push\n')
  expect(changed.canAllowTask).not.toBe(true)
  expect(f.permissions.resolve(changed.id, 'allow_task')).toBe(false)
  f.permissions.rejectAll(); expect(await next).toBe(false)
})

it.each(['GIT push', 'GiT push', '"GIT" push', '\\GIT push', '/usr/bin/GIT push', 'SUDO true', '"SuDo" true', 'CURL https://example.com'])('P1-3: red line spelling %s is ineligible without executing it', command => {
  const f = fixture(), snapshot = f.inspect(command)
  expect(snapshot.hash).toBeUndefined()
  expect(floorReason(snapshot.ask, undefined, { platform: 'darwin' })).toBeTruthy()
})

it.each(['cat .ENV', 'cat .GIT/config', 'cat .SSH/config', 'cat .Config/GH/hosts.yml', "cat '.GIT/config'", 'cat .G"IT"/config', 'cat .\\S\\SH/config'])('P1-3: macOS protected path %s remains a red line without folding the command hash', command => {
  const f = fixture(), snapshot = f.inspect(command)
  expect(floorReason(snapshot.ask, undefined, { platform: 'darwin' })).toBeTruthy()
  if (process.platform === 'darwin') expect(snapshot.hash).toBeUndefined()
})

it('P1-3: rejects unquoted zsh equals expansion while preserving quoted/escaped literal arguments and case', () => {
  expect(literalCommand('=git push')).toBeNull()
  expect(literalCommand('echo =git')).toBeNull()
  expect(literalCommand("echo '=git'")).toEqual(['echo', '=git'])
  expect(literalCommand('echo \\=git')).toEqual(['echo', '=git'])
  const f = fixture()
  if (process.platform === 'win32') expect(f.inspect("echo '=git'").hash).toBeUndefined()
  else expect(f.inspect("echo '=git'").hash).toBeTruthy()
  expect(f.inspect('echo =git').hash).toBeUndefined()
  if (process.platform === 'win32') expect(literalCommand('echo Upper')).not.toEqual(literalCommand('echo upper'))
  else expect(f.inspect('echo Upper').hash).not.toBe(f.inspect('echo upper').hash)
})

it.each(['make check', 'just check', 'unknown-runner ./helper', 'bun test', 'npx vitest', 'python3 -c "pass"'])('P1-2/P1-4: unbound execution entry %s never gets reusable permission', command => {
  expect(fixture().inspect(command).hash).toBeUndefined()
})

it.each(['Bash', 'execute', 'shell', 'commandExecution'])('P1-4: opaque %s execution requires a fresh one-shot owner decision', async tool => {
  const f = fixture(), answer = f.permissions.request({ tool, description: 'opaque executor operation', cwd: f.root })
  const card = f.permissions.pending()[0]!
  expect(card.canAllowTask).not.toBe(true)
  expect(f.permissions.resolve(card.id, 'allow_task')).toBe(false)
  expect(f.permissions.resolve(card.id, 'allow')).toBe(true)
  expect(await answer).toBe(true)
})

it.each(['other', 'tool', 'custom-command'])('P1-4: a self-reported %s tool kind cannot grant automatic permission for script facts', async tool => {
  const f = fixture(), answer = f.permissions.request({ tool, command: 'python3 helper.py', description: 'script operation', cwd: f.root })
  expect(f.permissions.pending()[0]!.canAllowTask).not.toBe(true)
  expect(f.permissions.resolve(f.permissions.pending()[0]!.id, 'allow_task')).toBe(false)
  expect(f.permissions.resolve(f.permissions.pending()[0]!.id, 'allow')).toBe(true)
  expect(await answer).toBe(true)
})

it('P2-6: permission notice command summaries redact tokens before their own length cap', async () => {
  const f = fixture(), answer = f.request('echo ' + 'x'.repeat(1188) + ' sk-' + 's'.repeat(32))
  const card = f.permissions.pending()[0]!
  expect(f.permissions.notice(card.id)).not.toContain('sk-sss')
  expect(f.permissions.notice(card.id)).toContain('[已打码]')
  f.permissions.resolve(card.id, 'deny'); expect(await answer).toBe(false)
})

it.each(['sudo python3 helper', 'find . -exec ./helper \\;', 'rg --pre ./helper term', 'sort --compress-program=./helper input', 'git -c alias.check=helper check', 'git diff --ext-diff', 'git status', 'rg --hostname-bin=./helper --hyperlink-format=default term src', 'sort --compress-prog=./helper input', 'wget --use-askpass=./helper localhost'])('P1-4: native program delegation %s cannot create a reusable grant', async command => {
  const f = fixture(), answer = f.request(command), card = f.permissions.pending()[0]!
  expect(card.canAllowTask).not.toBe(true)
  expect(f.permissions.resolve(card.id, 'allow_task')).toBe(false)
  expect(f.permissions.resolve(card.id, 'allow')).toBe(true)
  expect(await answer).toBe(true)
})

it.each(['allow', 'allow_task'] as const)('P1-4: %s distinguishes one-shot script invocation from automatic approval', async decision => {
  for (const gate of [undefined, async () => ({ verdict: 'allow' as const, by: 'rule' })]) {
    const f = fixture('codex', gate); writeFileSync(join(f.root, 'check.py'), 'print("approved")\n')
    const answer = f.request('python3 check.py')
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    const card = f.permissions.pending()[0]!
    expect(card).toBeDefined()
    expect(card.description).toContain('预览是批准时的快照，运行以当时内容为准')
    expect(card.canAllowTask).not.toBe(true)
    expect(f.permissions.resolve(card.id, decision)).toBe(decision === 'allow')
    if (decision === 'allow_task') f.permissions.resolve(card.id, 'deny')
    // Invocation approval explicitly permits runtime content and dependencies.
    writeFileSync(join(f.root, 'check.py'), 'print("replaced after approval")\n')
    expect(await answer).toBe(decision === 'allow')
  }
})

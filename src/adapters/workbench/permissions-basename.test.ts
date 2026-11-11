import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeRunPermissions } from './permissions'
import { decide } from '../permission-rules/decide'
import { inspectPermissionCommand } from './permission-command'
const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })
it.each(['relative', 'absolute'] as const)('a writable script named like a native command stays explicit under existing allow rule (%s)', async spelling => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-r3-rule-')))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'ls'), '#!/bin/sh\nprintf %s SCRIPT\n', { mode: 0o755 })
  const command = spelling === 'relative' ? './ls' : join(root, 'ls')
  const gate = (facts: any) => decide({ ...facts, surface: 'workbench', provider: 'codex', tier: 'admin', scope: 'task', cwd: root, project: root, isolatedWorktree: false },
    { version: 1, enabled: true, review: 'off', rules: [{ id: 'owner-shell', when: { surface: 'workbench', tool: 'commandExecution' }, then: 'allow' }] }, {})
  const permissions = makeRunPermissions({ taskId: 'task', provider: 'codex', root, decide: gate })
  cleanups.push(() => permissions.rejectAll())
  const facts = { tool: 'commandExecution', command, description: command, cwd: root }
  const snapshot = inspectPermissionCommand(facts, { taskId: 'task', provider: 'codex', root })
  const ruling = await gate(facts)
  const answer = permissions.request(facts)
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  const pending = permissions.pending()
  const automaticallyAllowed = pending.length === 0 ? await answer : false
  console.info(JSON.stringify({ spelling, ruling: ruling.verdict, requiresBoundExecution: snapshot.requiresBoundExecution, scripts: snapshot.scripts.map(s => s.path), hasHash: !!snapshot.hash, pending: pending.length, automaticallyAllowed }))
  if (pending.length) permissions.resolve(pending[0]!.id, 'deny')
  await answer
  expect(automaticallyAllowed).toBe(false)
  expect(pending).toHaveLength(1)
})

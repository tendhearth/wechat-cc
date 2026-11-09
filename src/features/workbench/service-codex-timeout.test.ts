import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from '../../lib/db'
import { removeTempDir } from '../../lib/test-temp'
import { createProviderRegistry } from '../../app/provider-registry'
import { makeWorkbenchStore } from '../../adapters/store/workbench/store'
import { createWorkbenchCodexProvider } from '../../adapters/executors/codex/codex-app-server'
import { workbenchCodexConfig } from '../../adapters/executors/codex/codex-config'
import { createScriptedCodex, type CodexScriptStep } from '../../test-support/executors/codex-scripted'
import { MANAGED_NATIVE_CAPABILITIES } from '../../domain/workbench/executor-capabilities'
import { makeWorkbenchService, type WorkbenchService } from './service'

// Codex workbench explicitly rejects Windows until process-tree cleanup there
// is verified (the adapter's own protocol suite has the same platform limit).
const codexTest = it.skipIf(process.platform === 'win32')

// Only CLI discovery is replaced. The service, adapter, lifetime stream,
// permission bridge and writer isolation run together, without a real CLI.
vi.mock('../../adapters/executors/codex/codex-config', async importOriginal => ({
  ...await importOriginal<typeof import('../../adapters/executors/codex/codex-config')>(),
  discoverWorkbenchCodexConfig: async () => ({ servers: [], config: workbenchCodexConfig([]) }),
}))

let root: string, project: string, db: Db, service: WorkbenchService
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-codex-timeout-')))
  project = join(root, 'project'); mkdirSync(project)
  db = openDb({ path: join(root, 'state.db') })
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
})
afterEach(async () => {
  await service?.shutdown(); vi.useRealTimers(); db.close(); removeTempDir(root)
})
// Drain real filesystem I/O and microtasks without advancing the task clocks.
async function until(check: () => boolean) {
  for (let n = 0; n < 2000; n++) {
    if (check()) return
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  throw new Error('scripted Codex did not reach the expected barrier')
}
function wire(orphan: boolean, evidence: 'empty' | 'unavailable' | 'running' = 'empty', idleMs = 1_200_000) {
  const command: CodexScriptStep[] = orphan ? [
    { notify: { method: 'item/started', params: { item: { id: 'approved-command', type: 'commandExecution', command: 'pwd', status: 'inProgress', processId: null } } } },
    { request: { method: 'item/commandExecution/requestApproval', params: { itemId: 'approved-command', kind: 'command', command: 'pwd', cwd: project } } },
    // Native launch failure returns to the model, without item/completed for
    // the approval's synthetic start. The model can recover and finish.
  ] : []
  const native = createScriptedCodex({
    turns: [{ steps: [...command, { say: '已修复并提交。' }] }, { steps: [{ say: '下一项也完成。' }] }],
    rewrite: message => {
      // A missing optional cleanup endpoint used to reject close even after
      // the app-server had exited. Only read-only registry evidence is usable.
      if (String(message.id).startsWith('cc-close-')) return { id: message.id, error: { message: 'unsupported terminal API' } }
      if (String(message.id).startsWith('cc-check-')) {
        if (evidence === 'unavailable') return { id: message.id, error: { message: 'unsupported terminal API' } }
        if (evidence === 'running') return { id: message.id, result: { data: [{ processId: 'real-writer' }], nextCursor: null } }
      }
      return message
    },
  })
  const registry = createProviderRegistry()
  registry.register('codex', createWorkbenchCodexProvider({ codexPathOverride: '/unused-codex', spawnProcess: native.spawn }), { displayName: 'Codex', canResume: () => true, workbench: MANAGED_NATIVE_CAPABILITIES })
  service = makeWorkbenchService({ store: makeWorkbenchStore(db), registry, stateDir: root, ownerChatId: () => null, timeoutMs: 600_000, retainedIdleCloseMs: idleMs, handoffGraceMs: 15_000 })
  return native
}
const create = () => service.create({ path: project, providerId: 'codex', text: '完成这项任务' })
async function approve(id: string) {
  await until(() => service.detail(id).permissions.length === 1)
  service.resolvePermission(id, service.detail(id).permissions[0]!.id, 'allow')
}

codexTest('keeps a reconciled retained reply healthy beyond ten minutes and hands off only after confirmed close', async () => {
  const native = wire(true), first = create(); await approve(first.id)
  await until(() => service.detail(first.id).runtime?.foreground === 'idle')
  await vi.advanceTimersByTimeAsync(600_001)
  expect(service.detail(first.id).task).toMatchObject({ status: 'running', phase: 'replied', error: null })
  expect(service.detail(first.id).runtime).toMatchObject({ retained: true, backgroundCount: 0 })
  expect(native.alive()).toBe(1)
  const second = create()
  expect(service.detail(second.id).task.status).toBe('queued')
  await vi.advanceTimersByTimeAsync(15_001)
  await until(() => service.detail(first.id).task.status === 'completed' && service.detail(second.id).task.status === 'completed')
  expect(service.detail(first.id).events.some(e => e.kind === 'error' || e.text.includes('未确认退出'))).toBe(false)
  expect(service.detail(first.id).task.error).toBeNull()
  expect(native.alive()).toBe(0)
})

codexTest('completes normally when idle-close and the turn watchdog both have the default ten-minute interval', async () => {
  const native = wire(true, 'empty', 600_000), first = create(); await approve(first.id)
  await until(() => service.detail(first.id).task.phase === 'replied')
  await vi.advanceTimersByTimeAsync(600_001)
  await until(() => service.detail(first.id).task.status === 'completed')
  expect(service.detail(first.id).task).toMatchObject({ phase: 'replied', error: null })
  expect(service.detail(first.id).events.some(e => e.kind === 'error' || e.text.includes('未确认退出'))).toBe(false)
  expect(native.alive()).toBe(0)
})

codexTest('completes an ordinary reply and releases its folder when optional cleanup RPCs are unavailable', async () => {
  const native = wire(false), first = create()
  await until(() => !['queued', 'running', 'cancelling'].includes(service.detail(first.id).task.status))
  expect(service.detail(first.id).task).toMatchObject({ status: 'completed', phase: 'replied', error: null })
  const second = create()
  await until(() => service.detail(second.id).task.status === 'completed')
  expect(native.alive()).toBe(0)
})

codexTest.each(['unavailable', 'running'] as const)('preserves writer_not_closed isolation when registry evidence is %s', async evidence => {
  const native = wire(true, evidence), first = create(); await approve(first.id)
  await until(() => service.detail(first.id).runtime?.foreground === 'idle')
  await vi.advanceTimersByTimeAsync(600_001)
  await until(() => service.detail(first.id).task.status === 'interrupted')
  expect(service.detail(first.id).task.error).toBe('writer_not_closed')
  expect(service.detail(first.id).events.some(e => e.kind === 'error' && e.text === 'turn_timeout')).toBe(true)
  const second = create()
  expect(service.detail(second.id).task.waitingFor).toMatchObject({ taskId: first.id, reason: 'writer_not_closed' })
  expect(native.alive()).toBe(0) // app-server exit alone never proves detached writers gone
})

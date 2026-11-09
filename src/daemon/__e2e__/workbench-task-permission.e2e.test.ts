import { expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openTestDb } from '../../lib/db'
import { makeConversationStore } from '../../adapters/store/conversation-store'
import { makeWorkbenchStore } from '../../adapters/store/workbench/store'
import { createProviderRegistry } from '../../app/provider-registry'
import { MANAGED_NATIVE_CAPABILITIES } from '../../domain/workbench/executor-capabilities'
import { makeWorkbenchService } from '../../features/workbench/service'
import { makeWorkbenchPermissionPrompt } from '../../features/workbench/permission-prompt'
import { makeIlinkAdapter } from '../ilink-glue'

// Real service → permission manager → shared WeChat registry → owner reply →
// executor. Only the executor process and WeChat delivery are system substitutes.
it('task card: yt remembers exact bytes, an edited script asks again, desktop settlement removes its code, cancellation clears everything', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-task-permission-e2e-')))
  const project = join(root, 'project'), stateDir = join(root, 'state'); mkdirSync(project); mkdirSync(stateDir)
  const file = join(project, 'check.py'); writeFileSync(file, 'print("first")\n')
  const db = openTestDb(), sent: string[] = [], answers: boolean[] = []
  const ilink = makeIlinkAdapter({ stateDir, db, conversationStore: makeConversationStore(db), accounts: [] })
  const delivery = vi.spyOn(ilink, 'sendMessage').mockImplementation(async (_chat, text) => { sent.push(text); return { msgId: 'test-delivery' } })
  const registry = createProviderRegistry()
  registry.register('codex', { async spawn(_project, ctx) { return {
    async *dispatch() {
      const request = (command: string) => ctx.requestPermission!({ tool: 'commandExecution', command, description: command, cwd: project })
      answers.push(await request('python3 check.py'))
      answers.push(await request('python3   "check.py"'))
      writeFileSync(file, 'print("changed")\n')
      answers.push(await request('python3 check.py'))
      answers.push(await request('git push'))
      yield { kind: 'result' as const, sessionId: 'test-session', numTurns: 1, durationMs: 1 }
    }, async close() {},
  } } }, { displayName: 'Codex', canResume:()=>false, workbench: MANAGED_NATIVE_CAPABILITIES })
  const store=makeWorkbenchStore(db)
  const service = makeWorkbenchService({ store, registry, stateDir, ownerChatId: () => 'owner', permissionPrompt: makeWorkbenchPermissionPrompt(ilink, () => 'owner') })
  try {
    const task = service.create({ path: project, providerId: 'codex', text: '检查脚本' })
    service.setWechatWatch(task.id,'test-account',true)
    await expect.poll(() => ilink.listPendingPermissions()).toHaveLength(1)
    const card = ilink.listPendingPermissions()[0]!
    expect(card.scripts?.[0]?.content).toBe('print("first")\n')
    expect(store.wechatNotifications.list(task.id)[0]?.text).toContain(`yt ${card.code}`)
    expect(sent).toHaveLength(0) // Code registration never sends a second speech event.
    expect(ilink.handlePermissionReply(`yt ${card.code}`, 'stranger')).toBe(false)
    expect(ilink.handlePermissionReply(`yt ${card.code}`, 'owner')).toBe(true)
    await expect.poll(() => answers.length).toBe(2)
    expect(answers).toEqual([true, true])
    await expect.poll(() => service.detail(task.id).permissions[0]?.scripts?.[0]?.content).toBe('print("changed")\n')
    expect(store.wechatNotifications.list(task.id).filter(n=>n.kind==='permission')).toHaveLength(2)
    const changed = service.detail(task.id).permissions[0]!
    const oldCode = ilink.listPendingPermissions()[0]!.code
    service.resolvePermission(task.id, changed.id, 'allow')
    expect(ilink.handlePermissionReply(`y ${oldCode}`, 'owner')).toBe(false)
    await expect.poll(() => service.detail(task.id).permissions[0]?.description).toBe('git push')
    const red = ilink.listPendingPermissions()[0]!
    expect(red.canAllowTask).not.toBe(true)
    expect(ilink.handlePermissionReply(`yt ${red.code}`, 'owner')).toBe(false)
    expect(ilink.handlePermissionReply(`n ${red.code}`, 'owner')).toBe(true)
    await expect.poll(() => service.detail(task.id).task.status).toBe('completed')
    expect(answers).toEqual([true, true, true, false]); expect(ilink.listPendingPermissions()).toEqual([])
    const other = service.create({ path: project, providerId: 'codex', text: '再检查一次' })
    await expect.poll(() => service.detail(other.id).permissions).toHaveLength(1)
    expect(ilink.listPendingPermissions()).toHaveLength(1)
    await service.cancel(other.id)
    expect(ilink.listPendingPermissions()).toEqual([])
  } finally { await service.shutdown(); delivery.mockRestore(); await ilink.flush(); db.close(); rmSync(root, { recursive: true, force: true }) }
})

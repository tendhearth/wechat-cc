import { expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openTestDb } from '../../lib/db'
import { makeConversationStore } from '../../adapters/store/conversation-store'
import { makeIlinkAdapter } from '../../daemon/ilink-glue'
import { makeWorkbenchPermissionPrompt } from './permission-prompt'

it.each(['wechat', 'pet'] as const)('R2: %s waits for the server decision before acknowledging or consuming the card', async surface => {
  const root = mkdtempSync(join(tmpdir(), 'cc-permission-ack-')), db = openTestDb()
  const ilink = makeIlinkAdapter({ stateDir: root, db, conversationStore: makeConversationStore(db), accounts: [] })
  const prompt = makeWorkbenchPermissionPrompt(ilink, () => 'owner'), closes: Array<() => void> = []
  try {
    for (const accepted of [false, true]) {
      const id = randomUUID(), during: number[] = []
      const answer = vi.fn(() => { during.push(ilink.listPendingPermissions().filter(p => p.hash === id).length); return accepted })
      closes.push(prompt('task', { id, taskId: 'task', tool: 'Bash', description: 'python3 check.py', createdAt: Date.now() }, answer, () => Date.now() + 10_000))
      const reply = surface === 'wechat' ? ilink.handlePermissionReply(`y ${ilink.pendingPermissionCodeOf(id)}`, 'owner') : ilink.resolvePermission(id, 'allow')
      expect(reply).toBe(accepted)
      expect(answer).toHaveBeenCalledExactlyOnceWith('allow')
      expect(during).toEqual([1])
      expect(ilink.listPendingPermissions().some(p => p.hash === id)).toBe(!accepted)
      if (accepted) expect(ilink.resolvePermission(id, 'allow')).toBe(false)
    }
  } finally { for (const close of closes) close(); await ilink.flush(); db.close(); rmSync(root, { recursive: true, force: true }) }
})

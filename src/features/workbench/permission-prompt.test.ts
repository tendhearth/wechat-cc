import { expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openTestDb } from '../../lib/db'
import { makeConversationStore } from '../../adapters/store/conversation-store'
import { makeIlinkAdapter } from '../../daemon/ilink-glue'
import { makeWorkbenchPermissionPrompt } from './permission-prompt'

it('strict WeChat reason replies consume only a capable owner card; ordinary chat stays ordinary',async()=>{
  const root=mkdtempSync(join(tmpdir(),'cc-reason-format-')),db=openTestDb()
  const ilink=makeIlinkAdapter({stateDir:root,db,conversationStore:makeConversationStore(db),accounts:[]})
  const prompt=makeWorkbenchPermissionPrompt(ilink,()=> 'owner'),answer=vi.fn(()=>true)
  const closers:Array<()=>void>=[]
  try{
    for(let i=1;i<=10;i++)closers.push(prompt('task',{id:randomUUID(),taskId:'task',tool:'Bash',description:'x',createdAt:Date.now(),canDenyWithReason:i===10},answer,()=>Date.now()+10000))
    expect(ilink.handlePermissionReply('不行 10 分钟后再说','owner')).toBe(false)
    expect(ilink.listPendingPermissions()).toHaveLength(10)
    expect(ilink.handlePermissionReply('n 01 不要 SSH','owner')).toBe(false)
    expect(ilink.listPendingPermissions()).toHaveLength(10)
    expect(ilink.handlePermissionReply('n 10 不要 SSH','stranger')).toBe(false)
    expect(answer).not.toHaveBeenCalled()
    expect(ilink.handlePermissionReply('n 10 不要 SSH','owner')).toBe(true)
    expect(answer).toHaveBeenCalledExactlyOnceWith('deny','不要 SSH')
    expect(ilink.listPendingPermissions()).toHaveLength(9)
  }finally{for(const close of closers)close();await ilink.flush();db.close();rmSync(root,{recursive:true,force:true})}
})

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

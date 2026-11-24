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
      closes.push(prompt('task', { id, taskId: 'task', tool: 'Bash', description: 'command=python3 check.py', cwd: '/demo', createdAt: Date.now() }, answer, () => Date.now() + 10_000))
      const reply = surface === 'wechat' ? ilink.handlePermissionReply(`y ${ilink.pendingPermissionCodeOf(id)}`, 'owner') : ilink.resolvePermission(id, 'allow')
      expect(reply).toBe(accepted)
      expect(answer).toHaveBeenCalledExactlyOnceWith('allow')
      expect(during).toEqual([1])
      expect(ilink.listPendingPermissions().some(p => p.hash === id)).toBe(!accepted)
      if (accepted) expect(ilink.resolvePermission(id, 'allow')).toBe(false)
    }
  } finally { for (const close of closes) close(); await ilink.flush(); db.close(); rmSync(root, { recursive: true, force: true }) }
})

async function withRegistry(run: (ilink: ReturnType<typeof makeIlinkAdapter>, sent: string[]) => void | Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'cc-wechat-quote-')), db = openTestDb()
  const ilink = makeIlinkAdapter({ stateDir: root, db, conversationStore: makeConversationStore(db), accounts: [] })
  const sent: string[] = []
  vi.spyOn(ilink, 'sendMessage').mockImplementation(async (_chat, text) => { sent.push(text); return { msgId: 'offline' } })
  try { await run(ilink, sent) }
  finally { await ilink.flush(); db.close(); rmSync(root, { recursive: true, force: true }) }
}

it.each(['allow', 'deny', 'cancel', 'expired', 'overdue'] as const)('quotes for a %s request cannot approve the next card in the same task', async settlement => {
  await withRegistry((ilink, sent) => {
    const prompt = makeWorkbenchPermissionPrompt(ilink, () => 'owner')
    const old = randomUUID(), fresh = randomUUID()
    let deadline = Date.now() + 10_000
    const task = { taskId: '112233aa', tool: 'Bash', description: 'command=printf test', cwd: '/demo', createdAt: 0 }
    const oldAnswer = vi.fn(() => true), newAnswer = vi.fn(() => true)
    const close = prompt('同一件事', { ...task, id: old }, oldAnswer, () => deadline)
    const quoted = ilink.pendingWechatPermissionCard(old)!.text
    if (settlement === 'cancel') close()
    else if (settlement === 'expired' || settlement === 'overdue') {
      deadline = Date.now() - 1
      if (settlement === 'expired') ilink.sweepPendingPermissions()
    } else expect(ilink.resolvePermission(old, settlement)).toBe(true)
    prompt('同一件事', { ...task, id: fresh }, newAnswer, () => Date.now() + 10_000)
    expect(ilink.probePermissionReply('y', 'owner', quoted)).toBe(true)
    expect(ilink.handlePermissionReply('y', 'owner', quoted)).toBe(true)
    expect(sent.at(-1)).toBe('这条请求已经处理过了或已经过期。')
    expect(newAnswer).not.toHaveBeenCalled()
    expect(ilink.listPendingPermissions().some(card => card.hash === fresh)).toBe(true)
    expect(ilink.handlePermissionReply('y', 'owner', ilink.pendingWechatPermissionCard(fresh)!.text)).toBe(true)
    expect(newAnswer).toHaveBeenCalledExactlyOnceWith('allow')
  })
})

it('binds to the complete quote and its owner even if a different request code appears in the reply', async () => {
  await withRegistry((ilink, sent) => {
    const prompt = makeWorkbenchPermissionPrompt(ilink, () => 'owner')
    const first = randomUUID(), second = randomUUID(), answer = vi.fn(() => true), otherAnswer = vi.fn(() => true)
    const request = { tool: 'Bash', description: 'command=printf test', cwd: '/demo', createdAt: 0 }
    prompt('一号事项', { ...request, id: first, taskId: '112233aa' }, answer, () => Date.now() + 10_000)
    const card = ilink.pendingWechatPermissionCard(first)!.text
    for (const altered of [
      card.replace('printf test', 'printf safe'),
      card.replace(/\n〔请求 [a-f0-9]+〕/, ''),
      card.split('\n')[0]!,
      card.split('\n').slice(0, 2).join('\n'),
      'printf test',
    ]) {
      expect(ilink.probePermissionReply('y', 'owner', altered)).toBe(true)
      expect(ilink.handlePermissionReply('y', 'owner', altered)).toBe(true)
      expect(sent.at(-1)).toBe('引用的权限提示不完整或不匹配，请重新查阅后再回复。')
    }
    expect(ilink.probePermissionReply('y', 'stranger', card)).toBe(false)
    expect(ilink.handlePermissionReply('y', 'stranger', card)).toBe(false)
    prompt('二号事项', { ...request, id: second, taskId: 'aabbccdd' }, otherAnswer, () => Date.now() + 10_000)
    const otherCard = ilink.pendingWechatPermissionCard(second)!.text
    expect(ilink.handlePermissionReply('y', 'owner', card.replace('112233aa', 'aabbccdd'))).toBe(true)
    expect(ilink.handlePermissionReply(`y ${ilink.pendingPermissionCodeOf(first)}`, 'owner', otherCard)).toBe(true)
    expect(answer).not.toHaveBeenCalled()
    expect(otherAnswer).not.toHaveBeenCalled()
    expect(ilink.handlePermissionReply('n', 'owner', card)).toBe(true)
    expect(answer).toHaveBeenCalledExactlyOnceWith('deny')
    expect(ilink.listPendingPermissions().map(entry => entry.hash)).toEqual([second])
  })
})

it('blocks y and yt before the decision callback without changing the code, clock or pet access', async () => {
  await withRegistry((ilink, sent) => {
    const prompt = makeWorkbenchPermissionPrompt(ilink, () => 'owner')
    const id = randomUUID(), answer = vi.fn(() => true)
    const close = prompt('示例', { id, taskId: '112233aa', tool: 'Bash', description: 'command=printf unrelated', cwd: '/demo', createdAt: 0,
      display: { body: { kind: 'command', command: 'printf demo' }, truncated: true },
      canAllowTask: true, canDenyWithReason: true }, answer, () => null)
    const code = ilink.pendingPermissionCodeOf(id)
    const card = ilink.pendingWechatPermissionCard(id)!.text
    expect(close.replyLine).toBe(`这条在微信里看不全，到电脑或手机上看全再定；回「n ${code}」拒绝。`)
    for (const [text, quote] of [[`y ${code}`, undefined], [`yt ${code}`, undefined], ['y', undefined], ['y', card], ['yt', card]]) {
      expect(ilink.handlePermissionReply(text!, 'owner', quote)).toBe(true)
      expect(sent.at(-1)).toBe('内容在微信里看不全，请到电脑或手机上看全再定。')
    }
    expect(answer).not.toHaveBeenCalled()
    expect(ilink.pendingPermissionCodeOf(id)).toBe(code)
    expect(ilink.resolvePermission(id, 'allow')).toBe(true)
    expect(answer).toHaveBeenCalledExactlyOnceWith('allow')
  })
})

it.each([
  'Claude wants to run:\nprintf "〔请求 abc〕"\n回「y 01」允许',
  '自改等你确认 [approval:abc12]\n〔请求 abc〕\n回「y 01」允许',
])('matches a legacy approval quote containing request-marker lookalikes', async quoted => {
  await withRegistry(async (ilink) => {
    const decision = ilink.registerPendingPermission('abc12', 10_000, { chatId: 'owner', prompt: quoted })
    expect(ilink.probePermissionReply('y', 'owner', quoted)).toBe(true)
    expect(ilink.handlePermissionReply('y', 'owner', quoted)).toBe(true)
    await expect(decision).resolves.toBe('allow')
  })
})

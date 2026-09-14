import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeConversationStore } from '../core/conversation-store'
import { openTestDb } from '../lib/db'
import { makeMessagesStore } from '../lib/messages-store'
import { makeIlinkAdapter, type Account } from './ilink-glue'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

function fixture(accounts?: Account[]) {
  const db = openTestDb()
  const configured = accounts ?? [{ id: 'acct-original', botId: 'bot', userId: 'user', baseUrl: 'https://ilink.invalid', token: 'account-secret', syncBuf: '' }]
  const adapter = makeIlinkAdapter({
    stateDir: mkdtempSync(join(tmpdir(), 'wcc-workbench-')),
    accounts: configured,
    db,
    conversationStore: makeConversationStore(db),
  })
  return { adapter, db, messages: makeMessagesStore(db) }
}

const notice = {
  id: 'notice-1', taskId: 'task-1', runId: 'run-1', ownerChatId: 'chat-owner',
  accountId: 'acct-original', text: '任务完成。',
}

describe('IlinkAdapter workbench transport', () => {
  it('resolves a chat account only from a persisted route to an exact configured account', () => {
    const { adapter } = fixture()
    expect(adapter.chatAccountId!('chat-owner')).toBeNull()
    adapter.routeChatToAccount('chat-owner', 'acct-original')
    expect(adapter.chatAccountId!('chat-owner')).toBe('acct-original')
    adapter.routeChatToAccount('chat-owner', 'removed-account')
    expect(adapter.chatAccountId!('chat-owner')).toBeNull()
  })

  it('preflights binding before reading account credentials or reaching the wire', async () => {
    let tokenReads = 0
    const account = {
      id: 'acct-original', botId: 'bot', userId: 'user', baseUrl: 'https://ilink.invalid', syncBuf: '',
      get token() { tokenReads++; return 'must-not-be-read' },
    }
    const { adapter } = fixture([account])
    adapter.routeChatToAccount('chat-owner', 'acct-rebound')
    globalThis.fetch = vi.fn() as unknown as typeof fetch
    await expect(adapter.sendWorkbenchNotice!(notice)).resolves.toEqual({ status: 'blocked', reason: 'binding_changed' })
    expect(tokenReads).toBe(0)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('never falls back to another account when the original account disappeared', async () => {
    const { adapter } = fixture([{ id: 'acct-other', botId: 'bot', userId: 'user', baseUrl: 'https://other.invalid', token: 'other-secret', syncBuf: '' }])
    adapter.routeChatToAccount('chat-owner', 'acct-original')
    adapter.captureContextToken('chat-owner', 'context')
    globalThis.fetch = vi.fn() as unknown as typeof fetch
    await expect(adapter.sendWorkbenchNotice!(notice)).resolves.toEqual({ status: 'blocked', reason: 'account_unavailable' })
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('defers before dispatch when the original chat context is missing', async () => {
    const { adapter } = fixture()
    adapter.routeChatToAccount('chat-owner', 'acct-original')
    globalThis.fetch = vi.fn() as unknown as typeof fetch
    await expect(adapter.sendWorkbenchNotice!(notice)).resolves.toEqual({ status: 'deferred', reason: 'missing_context' })
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it.each(['', 'x'.repeat(4001)])('blocks invalid text without dispatch', async text => {
    const { adapter } = fixture()
    adapter.routeChatToAccount('chat-owner', 'acct-original')
    adapter.captureContextToken('chat-owner', 'context')
    globalThis.fetch = vi.fn() as unknown as typeof fetch
    await expect(adapter.sendWorkbenchNotice!({ ...notice, text })).resolves.toEqual({ status: 'blocked', reason: 'invalid_text' })
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('uses the notice id once on the wire and audits accepted text as workbench memory', async () => {
    const { adapter, messages } = fixture()
    adapter.routeChatToAccount('chat-owner', 'acct-original')
    adapter.captureContextToken('chat-owner', 'context')
    globalThis.fetch = vi.fn(async () => new Response('{"errcode":0}')) as unknown as typeof fetch
    await expect(adapter.sendWorkbenchNotice!(notice)).resolves.toEqual({ status: 'accepted' })
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
    const body = JSON.parse(String((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1].body))
    expect(body.msg.client_id).toBe('notice-1')
    await expect(messages.listRange('chat-owner', { limit: 10 })).resolves.toEqual([
      expect.objectContaining({ chatId: 'chat-owner', direction: 'out', kind: 'text', text: '任务完成。', source: 'workbench' }),
    ])
  })

  it('keeps a known server acceptance accepted when audit storage fails', async () => {
    const { adapter, db } = fixture()
    adapter.routeChatToAccount('chat-owner', 'acct-original')
    adapter.captureContextToken('chat-owner', 'context')
    db.close()
    globalThis.fetch = vi.fn(async () => new Response('{"ret":0}')) as unknown as typeof fetch
    await expect(adapter.sendWorkbenchNotice!(notice)).resolves.toEqual({ status: 'accepted' })
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  })

  it('uploads artifact bytes only through the exact persisted owner/account context',async()=>{
    const {adapter}=fixture();adapter.routeChatToAccount('chat-owner','acct-original');adapter.captureContextToken('chat-owner','context')
    globalThis.fetch=vi.fn(async url=>String(url).includes('getuploadurl')?new Response(JSON.stringify({upload_full_url:'https://cdn.invalid/upload'})):new Response('',{headers:{'x-encrypted-param':'download'}})) as unknown as typeof fetch
    const result=await adapter.uploadWorkbenchArtifact!({id:'delivery-1',ownerChatId:'chat-owner',accountId:'acct-original',bytes:Buffer.from('pdf'),name:'report.pdf',mime:'application/pdf'})
    expect(result).toMatchObject({status:'uploaded',item:{type:4,file_item:{file_name:'report.pdf',len:'3'}}});expect(globalThis.fetch).toHaveBeenCalledTimes(2)
  })

  it('blocks artifact upload before credentials or network when binding changed',async()=>{
    let reads=0;const account={id:'acct-original',botId:'bot',userId:'user',baseUrl:'https://ilink.invalid',syncBuf:'',get token(){reads++;return 'secret'}}
    const {adapter}=fixture([account]);adapter.routeChatToAccount('chat-owner','other');globalThis.fetch=vi.fn() as unknown as typeof fetch
    await expect(adapter.uploadWorkbenchArtifact!({id:'delivery-1',ownerChatId:'chat-owner',accountId:'acct-original',bytes:Buffer.from('x'),name:'x.bin',mime:'application/octet-stream'})).resolves.toEqual({status:'blocked',reason:'binding_changed'})
    expect(reads).toBe(0);expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('discards a completed CDN preparation when the owner binding changes during upload',async()=>{
    const {adapter}=fixture();adapter.routeChatToAccount('chat-owner','acct-original');adapter.captureContextToken('chat-owner','context');let finish!:(value:Response)=>void
    globalThis.fetch=vi.fn(async url=>String(url).includes('getuploadurl')?new Response(JSON.stringify({upload_full_url:'https://cdn.invalid/upload'})):new Promise<Response>(resolve=>finish=resolve)) as unknown as typeof fetch
    const pending=adapter.uploadWorkbenchArtifact!({id:'delivery-1',ownerChatId:'chat-owner',accountId:'acct-original',bytes:Buffer.from('x'),name:'x.bin',mime:'application/octet-stream'})
    await vi.waitFor(()=>expect(globalThis.fetch).toHaveBeenCalledTimes(2));adapter.routeChatToAccount('chat-owner','other');finish(new Response('',{headers:{'x-encrypted-param':'download'}}))
    await expect(pending).resolves.toEqual({status:'blocked',reason:'binding_changed'})
  })

  it('strictly sends one uploaded item and awaits a source=workbench file audit',async()=>{
    const {adapter,messages}=fixture();adapter.routeChatToAccount('chat-owner','acct-original');adapter.captureContextToken('chat-owner','context')
    const item={type:4 as const,file_item:{media:{encrypt_query_param:'download',aes_key:'YWVz',encrypt_type:1 as const},file_name:'result.pdf',len:'3'}}
    globalThis.fetch=vi.fn(async()=>new Response('{"errcode":0}')) as unknown as typeof fetch
    await expect(adapter.sendWorkbenchArtifact!({id:'delivery-1',taskId:'task-1',artifactId:'artifact-1',artifactSha256:'a'.repeat(64),ownerChatId:'chat-owner',accountId:'acct-original',name:'result.pdf'},item)).resolves.toEqual({status:'accepted'})
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);expect(JSON.parse(String((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1].body)).msg.client_id).toBe('delivery-1')
    await expect(messages.listRange('chat-owner',{limit:10})).resolves.toEqual([expect.objectContaining({kind:'file',text:'result.pdf',source:'workbench'})])
  })

  it('does not send an uploaded item after its persisted account binding changes',async()=>{
    const {adapter}=fixture();adapter.routeChatToAccount('chat-owner','other');adapter.captureContextToken('chat-owner','context');globalThis.fetch=vi.fn() as unknown as typeof fetch
    const item={type:4 as const,file_item:{media:{encrypt_query_param:'download',aes_key:'YWVz',encrypt_type:1 as const},file_name:'result.pdf',len:'3'}}
    await expect(adapter.sendWorkbenchArtifact!({id:'delivery-1',taskId:'task-1',artifactId:'artifact-1',artifactSha256:'a'.repeat(64),ownerChatId:'chat-owner',accountId:'acct-original',name:'result.pdf'},item)).resolves.toEqual({status:'blocked',reason:'binding_changed'})
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('does not downgrade explicit artifact acceptance when audit storage fails',async()=>{
    const {adapter,db}=fixture();adapter.routeChatToAccount('chat-owner','acct-original');adapter.captureContextToken('chat-owner','context');db.close()
    globalThis.fetch=vi.fn(async()=>new Response('{"ret":0}')) as unknown as typeof fetch
    const item={type:4 as const,file_item:{media:{encrypt_query_param:'download',aes_key:'YWVz',encrypt_type:1 as const},file_name:'result.pdf',len:'3'}}
    await expect(adapter.sendWorkbenchArtifact!({id:'delivery-1',taskId:'task-1',artifactId:'artifact-1',artifactSha256:'a'.repeat(64),ownerChatId:'chat-owner',accountId:'acct-original',name:'result.pdf'},item)).resolves.toEqual({status:'accepted'})
  })

  it('does not append a late artifact audit after caller cancellation',async()=>{
    const {adapter,messages}=fixture();adapter.routeChatToAccount('chat-owner','acct-original');adapter.captureContextToken('chat-owner','context');let finish!:(value:Response)=>void
    globalThis.fetch=vi.fn(()=>new Promise<Response>(resolve=>finish=resolve)) as unknown as typeof fetch
    const ctrl=new AbortController(),item={type:4 as const,file_item:{media:{encrypt_query_param:'download',aes_key:'YWVz',encrypt_type:1 as const},file_name:'result.pdf',len:'3'}}
    const pending=adapter.sendWorkbenchArtifact!({id:'delivery-late',taskId:'task-1',artifactId:'artifact-1',artifactSha256:'a'.repeat(64),ownerChatId:'chat-owner',accountId:'acct-original',name:'result.pdf'},item,ctrl.signal)
    await vi.waitFor(()=>expect(globalThis.fetch).toHaveBeenCalledOnce());ctrl.abort();finish(new Response('{"ret":0}'));await expect(pending).resolves.toEqual({status:'accepted'})
    await expect(messages.listRange('chat-owner',{limit:10})).resolves.toEqual([])
  })

  it('does not append a late text audit after caller cancellation',async()=>{
    const {adapter,messages}=fixture();adapter.routeChatToAccount('chat-owner','acct-original');adapter.captureContextToken('chat-owner','context');let finish!:(value:Response)=>void
    globalThis.fetch=vi.fn(()=>new Promise<Response>(resolve=>finish=resolve)) as unknown as typeof fetch
    const ctrl=new AbortController(),pending=adapter.sendWorkbenchNotice!(notice,ctrl.signal)
    await vi.waitFor(()=>expect(globalThis.fetch).toHaveBeenCalledOnce());ctrl.abort();finish(new Response('{"ret":0}'));await expect(pending).resolves.toEqual({status:'accepted'})
    await expect(messages.listRange('chat-owner',{limit:10})).resolves.toEqual([])
  })
})

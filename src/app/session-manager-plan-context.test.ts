import {expect,it} from 'vitest'
import {SessionManager} from './session-manager'
import {createProviderRegistry} from './provider-registry'
import {AsyncQueue} from '../lib/async-queue'
import type {AgentEvent} from '../ports/agent-provider'
import {TIER_PROFILES} from '../domain/user-tier'

it('binds scope/path to the actual live dispatch and rejects missing or ambiguous turns',async()=>{
 const registry=createProviderRegistry(),queues:AsyncQueue<AgentEvent>[]=[]
 registry.register('openai',{async spawn(){return {dispatch(){const q=new AsyncQueue<AgentEvent>();queues.push(q);return q.iterable()},async close(){}}}},{displayName:'OpenAI',canResume:()=>false})
 const manager=new SessionManager({registry,maxConcurrent:6,idleEvictMs:60_000}),key={providerId:'openai',alias:'lab',chatId:'owner/with/slash'} as const
 const h=await manager.acquire({...key,path:'/offline/actual',tierProfile:TIER_PROFILES.admin,permissionMode:'strict'})
 const caller={sessionKey:'openai/lab/owner/with/slash',chatId:key.chatId}
 expect(manager.activeConversation(caller)).toBeNull()
 const a=h.dispatch('安排')[Symbol.asyncIterator](),p=a.next()
 try{
  await expect.poll(()=>queues.length).toBe(1)
  const first=manager.activeConversation(caller)!
  expect(first).toMatchObject({path:'/offline/actual',scope:expect.any(String)})
  expect(manager.activeConversation({chatId:key.chatId,provider:'openai'})).toEqual(first)
  expect(manager.activeConversation({...caller,chatId:'other'})).toBeNull()
  queues[0]!.end();await p
  expect(manager.activeConversation(caller)).toBeNull()
  const b=h.dispatch('再安排')[Symbol.asyncIterator](),p2=b.next();await expect.poll(()=>queues.length).toBe(2)
  expect(manager.activeConversation(caller)?.scope).not.toBe(first.scope)
  const c=h.dispatch('并发')[Symbol.asyncIterator](),p3=c.next();await expect.poll(()=>queues.length).toBe(3)
  expect(manager.activeConversation(caller)).toBeNull()
  queues[1]!.end();queues[2]!.end();await Promise.all([p2,p3])
 }finally{for(const q of queues)q.end();await a.return?.();await manager.shutdown()}
})

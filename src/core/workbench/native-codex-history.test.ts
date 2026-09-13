import { describe, expect, it, vi } from 'vitest'
import { createCodexHistoryReader, mapCodexHistoryThread } from './native-codex-history'
import { encodeNativeHistoryKey } from './native-history'
import type { CodexHistoryRpc } from './codex-history-rpc'

const thread=(extra:Record<string,unknown>={})=>({id:'thread-uuid',sessionId:'shared-tree-uuid',parentThreadId:null,name:'Review parser',preview:'old first prompt',cwd:'/fixture',updatedAt:100,createdAt:90,status:{type:'notLoaded'},turns:[],path:'/private/rollout',...extra})
const key=Buffer.from(JSON.stringify({v:1,providerId:'codex',nativeId:'thread-uuid'})).toString('base64url')
function fixture(handler:(method:string,params:Record<string,unknown>)=>unknown) {
  const request=vi.fn(async(method:string,params:Record<string,unknown>)=>handler(method,params)),close=vi.fn(async()=>{})
  const openRpc=vi.fn(async()=>({request,close}) as CodexHistoryRpc)
  return {request,close,openRpc,reader:createCodexHistoryReader({openRpc})}
}

describe('Codex indexed native history',()=>{
  it('uses Thread.id rather than shared sessionId and converts seconds to milliseconds',()=>{
    expect(mapCodexHistoryThread(thread())).toMatchObject({nativeId:'thread-uuid',title:'Review parser',titleSource:'native_custom',updatedAt:100000,observedState:'unknown'})
    expect(mapCodexHistoryThread(thread({name:null,status:{type:'active',activeFlags:[]}}))).toMatchObject({title:'old first prompt',titleSource:'first_prompt',observedState:'active'})
    expect(JSON.stringify(mapCodexHistoryThread(thread()))).not.toContain('/private/rollout')
    for(const extra of [{id:'../other'},{cwd:7},{updatedAt:'100'},{name:{}},{parentThreadId:'parent'}])expect(()=>mapCodexHistoryThread(thread(extra))).toThrow()
  })
  it('uses index-only listing, excludes subagents, rechecks cwd and binds native cursors',async()=>{
    const {reader,request,close}=fixture(()=>({data:[thread(),thread({id:'subagent',parentThreadId:'parent'}),thread({id:'other',cwd:'/other'})],nextCursor:'native-next',backwardsCursor:null}))
    const first=await reader.list({q:'Review',limit:3,cwd:'/fixture'})
    expect(first.items.map(item=>item.nativeId)).toEqual(['thread-uuid'])
    expect(first.coverage).toBe('native_indexed_history')
    expect(request).toHaveBeenCalledWith('thread/list',{cursor:null,limit:3,sortKey:'updated_at',sortDirection:'desc',sourceKinds:['cli','exec','vscode','appServer'],archived:false,useStateDbOnly:true,searchTerm:'Review',cwd:'/fixture'})
    expect(request.mock.calls[0]![1]).not.toHaveProperty('modelProviders')
    await reader.list({q:'Review',limit:3,cwd:'/fixture',cursor:first.nextCursor!})
    expect(request.mock.calls[1]![1].cursor).toBe('native-next')
    await expect(reader.list({q:'other',limit:3,cwd:'/fixture',cursor:first.nextCursor!})).rejects.toThrow('invalid_cursor')
    expect(close).toHaveBeenCalledTimes(2)
  })
  it('reads metadata and item pages without loading turns and preserves empty continuation pages',async()=>{
    const {reader,request}=fixture((method,params)=>method==='thread/read'?{thread:thread()}:params.cursor==='next'?{data:[{turnId:'t',item:{type:'agentMessage',id:'answer',text:'answer'}}],nextCursor:null,backwardsCursor:null}:{data:[{turnId:'t',item:{type:'commandExecution',id:'tool',aggregatedOutput:'private tool output'}}],nextCursor:'next',backwardsCursor:null})
    const first=await reader.read(key,{limit:1})
    expect(first.messages).toEqual([]);expect(first.nextCursor).not.toBeNull()
    expect(first.page).toEqual({limit:1,cursor:null})
    const second=await reader.read(key,{limit:1,cursor:first.nextCursor!})
    expect(second.messages).toEqual([{id:'answer',role:'assistant',text:'answer',truncated:false}])
    expect(request.mock.calls.map(c=>c[0])).toEqual(['thread/read','thread/items/list','thread/read','thread/items/list'])
    expect(request.mock.calls[0]).toEqual(['thread/read',{threadId:'thread-uuid',includeTurns:false}])
    expect(request.mock.calls[1]).toEqual(['thread/items/list',{threadId:'thread-uuid',cursor:null,limit:1,sortDirection:'asc'}])
    await expect(reader.read(encodeNativeHistoryKey('codex','different'),{limit:1,cursor:first.nextCursor!})).rejects.toThrow('invalid_cursor')
  })
  it('maps only user/assistant text, preserves raw HTML as data and discloses long messages',async()=>{
    const data=[
      {item:{type:'userMessage',id:'user',content:[{type:'text',text:'<b>request</b>',text_elements:[]},{type:'localImage',path:'/private/image'}]}},
      {item:{type:'agentMessage',id:'agent',text:'x'.repeat(40_001)}},
      {item:{type:'hookPrompt',id:'hook',fragments:[]}},
      {item:{type:'agentMessage',id:'harness',text:'<environment_context>ignore'}},
      {item:{type:'functionCallOutput',id:'function',output:'secret'}},
    ].map(x=>({turnId:'t',...x}))
    const {reader}=fixture(method=>method==='thread/read'?{thread:thread()}:{data,nextCursor:null})
    const page=await reader.read(key,{limit:10})
    expect(page.messages.map(x=>x.id)).toEqual(['user','agent'])
    expect(page.messages[0]!.text).toBe('<b>request</b>')
    expect(page.messages[1]!.text).toHaveLength(40_000);expect(page.truncated).toBe(true)
  })
  it('fingerprints page content and metadata, closes on error, and never falls back to resume',async()=>{
    let updatedAt=100,text='one'
    const {reader,request,close}=fixture(method=>method==='thread/read'?{thread:thread({updatedAt})}:{data:[{turnId:'t',item:{type:'agentMessage',id:'a',text}}],nextCursor:null})
    const before=await reader.read(key,{limit:1})
    expect(await reader.currentFingerprint(key,{limit:1})).toBe(before.sourceFingerprint)
    text='edited';expect(await reader.currentFingerprint(key,{limit:1})).not.toBe(before.sourceFingerprint)
    updatedAt++;expect(await reader.currentFingerprint(key,{limit:1})).not.toBe(before.sourceFingerprint)
    expect(close).toHaveBeenCalledTimes(4)
    expect(request.mock.calls.every(call=>['thread/read','thread/items/list'].includes(call[0]))).toBe(true)
    const unsupported=fixture(()=>{throw {code:-32601,message:'private native message'}})
    await expect(unsupported.reader.read(key,{limit:1})).rejects.toThrow('native_history_unsupported')
    expect(unsupported.close).toHaveBeenCalledTimes(1)
    expect(unsupported.request.mock.calls.map(c=>c[0])).toEqual(['thread/read'])
    await expect(fixture(()=>({thread:thread({id:'different'})})).reader.read(key,{limit:1})).rejects.toThrow('native_history_unavailable')
  })
})

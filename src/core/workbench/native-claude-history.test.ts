import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createClaudeHistoryReader, type ClaudeHistorySdk } from './native-claude-history'
import { encodeNativeHistoryKey } from './native-history'

const key=Buffer.from(JSON.stringify({v:1,providerId:'claude',nativeId:'claude-1'})).toString('base64url')
const info=(extra:Record<string,unknown>={})=>({sessionId:'claude-1',summary:'Summary',customTitle:'My title',firstPrompt:'first',cwd:'/fixture',lastModified:100,fileSize:200,...extra})
const msg=(i:number,text=`message ${i}`,extra:Record<string,unknown>={})=>({type:i%2?'assistant':'user',uuid:`msg-${i}`,session_id:'claude-1',parent_tool_use_id:null,message:{content:[{type:'text',text}]},...extra})
function fixture(extra:Partial<ClaudeHistorySdk>={}) {
  const sdk:ClaudeHistorySdk={listSessions:vi.fn(async()=>[info()]),getSessionInfo:vi.fn(async()=>info()),getSessionMessages:vi.fn(async()=>[msg(0)]),...extra}
  return {sdk,reader:createClaudeHistoryReader({sdk})}
}

describe('Claude supported history reader',()=>{
  it('maps SDK metadata and applies exact directory scope without including worktrees',async()=>{
    const {sdk,reader}=fixture({listSessions:vi.fn(async()=>[info(),info({sessionId:'other',cwd:'/other'}),info({sessionId:'missing',cwd:undefined})])})
    const page=await reader.list({q:'',limit:20,cwd:'/fixture'})
    expect(page.coverage).toBe('native_supported_history')
    expect(page.items).toHaveLength(1)
    expect(page.items[0]).toMatchObject({providerId:'claude',nativeId:'claude-1',title:'My title',titleSource:'native_custom',cwd:'/fixture',updatedAt:100,observedState:'unknown',remote:false})
    expect(sdk.listSessions).toHaveBeenCalledWith({dir:'/fixture',includeWorktrees:false,offset:0,limit:100})
  })
  it('returns an empty continuation batch and finds a match beyond the 500th row',async()=>{
    const rows=Array.from({length:501},(_,i)=>info({sessionId:`session-${i}`,customTitle:i===500?'needle':'unrelated'}))
    const sdk={listSessions:vi.fn(async({offset=0,limit=100}={})=>rows.slice(offset,offset+limit)),getSessionInfo:async()=>info(),getSessionMessages:async()=>[]}
    const reader=createClaudeHistoryReader({sdk})
    const first=await reader.list({q:'needle',limit:1})
    expect(first.items).toEqual([]);expect(first.nextCursor).not.toBeNull()
    expect(sdk.listSessions).toHaveBeenCalledTimes(5)
    const second=await reader.list({q:'needle',limit:1,cursor:first.nextCursor!})
    expect(second.items.map(item=>item.nativeId)).toEqual(['session-500'])
    await expect(reader.list({q:'changed',limit:1,cursor:first.nextCursor!})).rejects.toThrow('invalid_cursor')
  })
  it('does not lose rows when a page fills inside one native batch',async()=>{
    const rows=Array.from({length:4},(_,i)=>info({sessionId:`id-${i}`}))
    const {reader}=fixture({listSessions:async({offset=0,limit=100}={})=>rows.slice(offset,offset+limit)})
    const one=await reader.list({q:'',limit:2}),two=await reader.list({q:'',limit:2,cursor:one.nextCursor!})
    expect([...one.items,...two.items].map(x=>x.nativeId)).toEqual(['id-0','id-1','id-2','id-3'])
    expect(two.nextCursor).toBeNull()
  })
  it('reads the SDK message chain in bounded pages, excluding tools and harness and reporting clipping',async()=>{
    const rows=[msg(0,'<script>data</script>'),msg(1,'x'.repeat(40_001)),msg(2,'<task-notification>harness'),msg(3,'',{message:{content:[{type:'tool_result',content:'secret tool'}]}}),msg(4)]
    const {sdk,reader}=fixture({getSessionMessages:vi.fn(async(_id,{offset=0,limit=100}={})=>rows.slice(offset,offset+limit))})
    const first=await reader.read(key,{limit:2})
    expect(first.messages.map(x=>x.id)).toEqual(['msg-0','msg-1'])
    expect(first.messages[0]!.text).toBe('<script>data</script>')
    expect(first.messages[1]).toMatchObject({truncated:true,text:'x'.repeat(40_000)})
    expect(first).toMatchObject({truncated:true,page:{limit:2,cursor:null}})
    const middle=await reader.read(key,{limit:2,cursor:first.nextCursor!})
    expect(middle.messages).toEqual([]);expect(middle.nextCursor).not.toBeNull()
    const last=await reader.read(key,{limit:2,cursor:middle.nextCursor!})
    expect(last.messages.map(x=>x.id)).toEqual(['msg-4']);expect(last.nextCursor).toBeNull()
    expect(sdk.getSessionMessages).toHaveBeenCalledWith('claude-1',{limit:2,offset:0,includeSystemMessages:false})
    await expect(reader.read(encodeNativeHistoryKey('codex','claude-1'),{limit:2})).rejects.toThrow('invalid_native_history_key')
  })
  it('fingerprints explicit pages without cross-client preview state and detects metadata or message changes',async()=>{
    let version=1,text='one'
    const rows=()=>[msg(0,text),msg(1,'two')]
    const {reader}=fixture({getSessionInfo:async()=>info({fileSize:version}),getSessionMessages:async(_id,{offset=0,limit=100}={})=>rows().slice(offset,offset+limit)})
    const one=await reader.read(key,{limit:1}),two=await reader.read(key,{limit:1,cursor:one.nextCursor!})
    expect(await reader.currentFingerprint(key,{limit:1})).toBe(one.sourceFingerprint)
    expect(await reader.currentFingerprint(key,{limit:1,cursor:one.nextCursor!})).toBe(two.sourceFingerprint)
    text='edited'
    expect(await reader.currentFingerprint(key,{limit:1})).not.toBe(one.sourceFingerprint)
    version++
    expect(await reader.currentFingerprint(key,{limit:1,cursor:one.nextCursor!})).not.toBe(two.sourceFingerprint)
  })
  it('treats absent/sidechain metadata as unsupported and bounds failed SDK calls',async()=>{
    await expect(fixture({getSessionInfo:async()=>undefined}).reader.read(key,{limit:1})).rejects.toThrow('native_history_unsupported')
    await expect(fixture({getSessionInfo:async()=>info({sessionId:'wrong'})}).reader.read(key,{limit:1})).rejects.toThrow('native_history_unavailable')
    await expect(fixture({getSessionMessages:async()=>[msg(0,'x'.repeat(2*1024*1024))]}).reader.read(key,{limit:1})).rejects.toThrow('native_history_unavailable')
    const slow=createClaudeHistoryReader({sdk:fixture({getSessionInfo:()=>new Promise(()=>{})}).sdk,timeoutMs:5})
    await expect(slow.read(key,{limit:1})).rejects.toThrow('native_history_unavailable')
  })
})

it('bounds the entire Claude scan instead of resetting the timeout per batch',async()=>{
 vi.useFakeTimers()
 try {
  const sdk:ClaudeHistorySdk={listSessions:vi.fn(async()=>{await new Promise(r=>setTimeout(r,6));return Array.from({length:100},(_,i)=>info({sessionId:`id-${i}`,customTitle:'other'}))}),getSessionInfo:async()=>info(),getSessionMessages:async()=>[]}
  const result=createClaudeHistoryReader({sdk,timeoutMs:10}).list({q:'missing',limit:1}).catch(e=>e.message)
  await vi.advanceTimersByTimeAsync(11)
  expect(await result).toBe('native_history_unavailable')
  expect(sdk.listSessions).toHaveBeenCalledTimes(2)
 } finally {vi.useRealTimers()}
})

it('exercises defaultSdk against an owned empty project without listing personal histories',async()=>{
 const cwd=mkdtempSync(join(tmpdir(),'cc-claude-empty-history-'))
 try{expect(await createClaudeHistoryReader().list({cwd,q:'',limit:10})).toEqual({items:[],nextCursor:null,coverage:'native_supported_history'})}finally{rmSync(cwd,{recursive:true,force:true})}
})

import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest'
import {mkdtempSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {openDb,type Db} from '../../lib/db'
import {createProviderRegistry} from '../provider-registry'
import {makeWorkbenchStore} from './store'
import {makeWorkbenchService,type WorkbenchService} from './service'
import {encodeNativeHistoryKey,historyPreview,type NativeHistoryItem,type NativeHistoryMessage,type NativeHistoryReader,type NativeHistoryReadInput} from './native-history'
import {NATIVE_RECENT_HISTORY_MS,NATIVE_RECENT_MAX_READS} from './service/native'
import {MANAGED_NATIVE_CAPABILITIES} from './executor-capabilities'
import {removeTempDir} from '../../lib/test-temp'

let root:string,db:Db,service:WorkbenchService|undefined
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),'cc-native-recent-'));db=openDb({path:join(root,'test.db')});service=undefined})
afterEach(async()=>{vi.useRealTimers();await service?.shutdown();db.close();removeTempDir(root)})
const message=(n:number):NativeHistoryMessage=>({id:'m'+n,role:n%2?'assistant':'user',text:'message '+n,truncated:false})
function fixture(total:number,options:{seek?:boolean;read?:NativeHistoryReader['read'];tailCursor?:NativeHistoryReader['tailCursor']}={}){
  const key=encodeNativeHistoryKey('claude','native-id'),store=makeWorkbenchStore(db),registry=createProviderRegistry()
  const spawn=vi.fn(async()=>{throw new Error('must not execute')}),mint=vi.fn(()=> 'unused')
  registry.register('claude',{spawn},{displayName:'Claude',canResume:()=>true,workbench:MANAGED_NATIVE_CAPABILITIES})
  const item:NativeHistoryItem={key,providerId:'claude',nativeId:'native-id',cwd:root,title:'Recent',titleSource:'native_custom',updatedAt:1,remote:false,observedState:'active'}
  const read=vi.fn(options.read??(async(_key:string,input:NativeHistoryReadInput)=>{
    const start=input.cursor?Number(input.cursor.slice(1)):0,end=Math.min(start+input.limit,total)
    return historyPreview(item,'revision',Array.from({length:end-start},(_,i)=>message(start+i)),end<total?'c'+end:null,input)
  }))
  const tailCursor=vi.fn(options.tailCursor??(async(_key:string,rows:number)=>total>rows?'c'+(total-rows):null))
  const reader:NativeHistoryReader={list:async()=>({items:[item],nextCursor:null,coverage:'native_supported_history'}),read,currentFingerprint:async()=> 'unused',...(options.seek?{tailCursor}:{})}
  service=makeWorkbenchService({store,registry,stateDir:root,ownerChatId:()=>null,mintSessionToken:mint,nativeHistory:{claude:reader}})
  return{key,item,store,spawn,mint,read,tailCursor}
}

describe('readRecentNativeHistory: bounded, read-only tail windows',()=>{
  it('seeks directly to a long active session tail without scanning its head or taking ownership',async()=>{
    const h=fixture(50_000,{seek:true}),result=await service!.readRecentNativeHistory(h.key,{limit:20})
    expect(h.tailCursor).toHaveBeenCalledWith(h.key,20)
    expect(h.read).toHaveBeenCalledExactlyOnceWith(h.key,{limit:100,cursor:'c49980'})
    expect(result.messages.map(m=>m.id)).toEqual(Array.from({length:20},(_,i)=>'m'+(49980+i)))
    expect(result.nextCursor).toBeNull();expect(result.session.observedState).toBe('active')
    expect(service!.list().tasks).toEqual([]);expect(h.spawn).not.toHaveBeenCalled();expect(h.mint).not.toHaveBeenCalled()
  })
  it('handles a short seekable session from its head and preserves managedTaskId',async()=>{
    const h=fixture(5,{seek:true}),task=h.store.create({title:'Managed',path:root,providerId:'claude',ownerChatId:null})
    h.store.session(task.id,'native-id')
    const result=await service!.readRecentNativeHistory(h.key,{limit:20})
    expect(h.read).toHaveBeenCalledWith(h.key,{limit:100})
    expect(result.messages).toHaveLength(5);expect(result.managedTaskId).toBe(task.id)
    expect(h.spawn).not.toHaveBeenCalled()
  })
  it('walks 100-row pages and retains only the last distinct messages in occurrence order',async()=>{
    const h=fixture(220)
    const original=h.read.getMockImplementation()!
    h.read.mockImplementation(async(key,input)=>{
      const page=await original(key,input)
      if(input.cursor==='c200')page.messages.unshift({...message(199),text:'updated echo'})
      return page
    })
    const result=await service!.readRecentNativeHistory(h.key,{limit:25})
    expect(h.read.mock.calls.map(([,input])=>input)).toEqual([{limit:100},{limit:100,cursor:'c100'},{limit:100,cursor:'c200'}])
    expect(result.messages.map(m=>m.id)).toEqual(Array.from({length:25},(_,i)=>'m'+(195+i)))
    expect(result.messages.find(m=>m.id==='m199')?.text).toBe('updated echo')
    expect(new Set(result.messages.map(m=>m.id)).size).toBe(25)
  })
  it('allows a terminal 80th page but refuses an 81st instead of returning a misleading partial window',async()=>{
    const h=fixture(NATIVE_RECENT_MAX_READS*100)
    expect((await service!.readRecentNativeHistory(h.key,{limit:20})).messages.at(-1)?.id).toBe('m7999')
    expect(h.read).toHaveBeenCalledTimes(NATIVE_RECENT_MAX_READS)
    h.read.mockClear()
    h.read.mockImplementation(async(_key,input)=>historyPreview(h.item,'revision',[message(1)],'c'+(Number(input.cursor?.slice(1)??0)+100),input))
    await expect(service!.readRecentNativeHistory(h.key,{limit:20})).rejects.toThrow('native_history_unavailable')
    expect(h.read).toHaveBeenCalledTimes(NATIVE_RECENT_MAX_READS)
  })
  it('shares the 8-second deadline between seek and a blocked read',async()=>{
    vi.useFakeTimers()
    const h=fixture(100,{seek:true,tailCursor:async()=>{await new Promise(resolve=>setTimeout(resolve,6000));return 'tail'},read:async()=>new Promise(()=>{})})
    const rejected=expect(service!.readRecentNativeHistory(h.key,{limit:20})).rejects.toThrow('native_history_unavailable')
    await vi.advanceTimersByTimeAsync(6000);expect(h.read).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(NATIVE_RECENT_HISTORY_MS-6000)
    await rejected;expect(h.read).toHaveBeenCalledTimes(1)
  })
  it('checks the remaining deadline after every page, including the terminal page',async()=>{
    vi.useFakeTimers();const h=fixture(300),original=h.read.getMockImplementation()!
    h.read.mockImplementation(async(key,input)=>{vi.setSystemTime(Date.now()+3000);return original(key,input)})
    await expect(service!.readRecentNativeHistory(h.key,{limit:20})).rejects.toThrow('native_history_unavailable')
    expect(h.read).toHaveBeenCalledTimes(3)
  })
  it('rejects a looping cursor or changed session identity without touching execution',async()=>{
    const h=fixture(300)
    h.read.mockImplementation(async(_key,input)=>historyPreview(h.item,'revision',[message(1)],'repeat',input))
    await expect(service!.readRecentNativeHistory(h.key,{limit:20})).rejects.toThrow('native_history_unavailable')
    expect(h.read).toHaveBeenCalledTimes(2)
    h.read.mockImplementation(async(_key,input)=>historyPreview({...h.item,key:'different'},'revision',[],null,input))
    await expect(service!.readRecentNativeHistory(h.key,{limit:20})).rejects.toThrow('native_history_changed')
    expect(h.spawn).not.toHaveBeenCalled()
  })
  it('validates the key, supported reader and limit before reading',async()=>{
    const h=fixture(10)
    await expect(service!.readRecentNativeHistory('bad',{limit:20})).rejects.toThrow('invalid_native_history_key')
    await expect(service!.readRecentNativeHistory(encodeNativeHistoryKey('codex','native-id'),{limit:20})).rejects.toThrow('native_history_unsupported')
    for(const limit of [0,101,1.5])await expect(service!.readRecentNativeHistory(h.key,{limit})).rejects.toThrow('invalid_request')
    expect(h.read).not.toHaveBeenCalled()
  })
})

import { openCodexHistoryRpc, type CodexHistoryRpc, type CodexHistoryRpcOptions } from './codex-history-rpc'
import { assertHistoryResponse, decodeNativeHistoryKey, encodeNativeHistoryKey, historyCursor, historyCwd, historyMessage, historyObject, historyPreview, historyText, nativeHistoryFailure, normalizeHistoryList, normalizeHistoryRead, readHistoryCursor, type NativeHistoryItem, type NativeHistoryMessage, type NativeHistoryReader } from './native-history'

export interface CodexHistoryOptions {
  codexPathOverride?:string;cwd?:string;timeoutMs?:number;closeTimeoutMs?:number
  openRpc?:()=>Promise<CodexHistoryRpc>
}
/** Identity is Thread.id. sessionId is shared by an entire native thread tree. */
export function mapCodexHistoryThread(value:unknown):NativeHistoryItem {
  if(!historyObject(value)||typeof value.id!=='string'||typeof value.preview!=='string'||(value.name!==null&&typeof value.name!=='string')||!Number.isSafeInteger(value.updatedAt)||Number(value.updatedAt)<0||!Number.isSafeInteger(Number(value.updatedAt)*1000)||!historyObject(value.status)||typeof value.status.type!=='string')throw new Error('native_history_unavailable')
  if(value.parentThreadId!==null)throw new Error('native_history_unsupported')
  const cwd=historyCwd(value.cwd)
  if(!cwd)throw new Error('native_history_unavailable')
  const name=typeof value.name==='string'?value.name.trim():'',preview=value.preview.trim()
  return {key:encodeNativeHistoryKey('codex',value.id),providerId:'codex',nativeId:value.id,title:(name||preview||'Codex session').slice(0,40_000),titleSource:name?'native_custom':preview?'first_prompt':'fallback',cwd,updatedAt:Number(value.updatedAt)*1000,remote:false,observedState:value.status.type==='active'?'active':value.status.type==='idle'?'observed':'unknown'}
}
function nativeCursor(cursor:string|undefined,scope:Record<string,unknown>):string|null {
  if(cursor===undefined)return null
  const value=readHistoryCursor(cursor,scope)
  if(typeof value!=='string')throw new Error('invalid_cursor')
  return value
}
function pageData(value:unknown,limit:number):{data:unknown[];nextCursor:string|null} {
  assertHistoryResponse(value)
  if(!historyObject(value)||!Array.isArray(value.data)||value.data.length>limit||(value.nextCursor!==null&&(typeof value.nextCursor!=='string'||!value.nextCursor)))throw new Error('native_history_unavailable')
  return {data:value.data,nextCursor:value.nextCursor as string|null}
}
export function createCodexHistoryReader(options:CodexHistoryOptions={}):NativeHistoryReader {
  const open=options.openRpc??(()=>openCodexHistoryRpc({codexPathOverride:options.codexPathOverride??'codex',cwd:options.cwd,timeoutMs:options.timeoutMs,closeTimeoutMs:options.closeTimeoutMs} as CodexHistoryRpcOptions))
  async function usingRpc<T>(run:(rpc:CodexHistoryRpc)=>Promise<T>):Promise<T>{
    let rpc:CodexHistoryRpc|undefined
    try{rpc=await open();return await run(rpc)}catch(error){throw nativeHistoryFailure(error)}finally{if(rpc)await rpc.close()}
  }
  const reader:NativeHistoryReader={
    async list(input){
      const query=normalizeHistoryList(input),scope={providerId:'codex',kind:'list',q:query.q,cwd:query.cwd??null},cursor=nativeCursor(query.cursor,scope)
      return usingRpc(async rpc=>{
        const page=pageData(await rpc.request('thread/list',{cursor,limit:query.limit,sortKey:'updated_at',sortDirection:'desc',sourceKinds:['cli','exec','vscode','appServer'],archived:false,useStateDbOnly:true,searchTerm:query.q,...(query.cwd?{cwd:query.cwd}:{})}),query.limit)
        const items:NativeHistoryItem[]=[]
        for(const value of page.data){
          let item:NativeHistoryItem
          try{item=mapCodexHistoryThread(value)}catch{continue}
          if((query.cwd&&item.cwd!==query.cwd)||!item.title.toLowerCase().includes(query.q.toLowerCase()))continue
          items.push(item)
        }
        return {items,nextCursor:page.nextCursor===null?null:historyCursor(scope,page.nextCursor),coverage:'native_indexed_history'}
      })
    },
    async read(key,input){
      const {nativeId}=decodeNativeHistoryKey(key,'codex'),inputPage=normalizeHistoryRead(input),scope={providerId:'codex',kind:'read',nativeId},cursor=nativeCursor(inputPage.cursor,scope)
      return usingRpc(async rpc=>{
        const metadata=await rpc.request('thread/read',{threadId:nativeId,includeTurns:false});assertHistoryResponse(metadata)
        if(!historyObject(metadata))throw new Error('native_history_unavailable')
        const session=mapCodexHistoryThread(metadata.thread)
        if(session.nativeId!==nativeId)throw new Error('native_history_unavailable')
        const page=pageData(await rpc.request('thread/items/list',{threadId:nativeId,cursor,limit:inputPage.limit,sortDirection:'asc'}),inputPage.limit)
        const messages:NativeHistoryMessage[]=[]
        for(const entry of page.data){
          if(!historyObject(entry)||typeof entry.turnId!=='string'||!historyObject(entry.item))continue
          const item=entry.item
          if(typeof item.id!=='string'||!item.id||item.id.length>200)continue
          const role=item.type==='userMessage'?'user':item.type==='agentMessage'?'assistant':null
          if(!role)continue
          const text=role==='user'?historyText(item.content):typeof item.text==='string'?item.text:''
          const message=historyMessage(item.id,role,text);if(message)messages.push(message)
        }
        const native=metadata.thread as Record<string,unknown>
        const revision={id:native.id,cwd:native.cwd,updatedAt:native.updatedAt,createdAt:native.createdAt,name:native.name,preview:native.preview,cliVersion:native.cliVersion,historyMode:native.historyMode}
        return historyPreview(session,revision,messages,page.nextCursor===null?null:historyCursor(scope,page.nextCursor),inputPage)
      })
    },
    async currentFingerprint(key,input={limit:100}){return (await reader.read(key,input)).sourceFingerprint},
  }
  return reader
}

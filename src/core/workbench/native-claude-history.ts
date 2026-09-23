import type { GetSessionInfoOptions, GetSessionMessagesOptions, ListSessionsOptions } from '@anthropic-ai/claude-agent-sdk'
import { historyDeadline, decodeNativeHistoryKey, encodeNativeHistoryKey, historyCursor, historyCwd, historyMessage, historyObject, historyPreview, historyText, normalizeHistoryList, normalizeHistoryRead, readHistoryCursor, type NativeHistoryItem, type NativeHistoryMessage, type NativeHistoryReader } from './native-history'

export interface ClaudeHistorySdk {
  listSessions(options?:Pick<ListSessionsOptions,'dir'|'limit'|'offset'|'includeWorktrees'>):Promise<unknown>
  getSessionInfo(id:string,options?:Pick<GetSessionInfoOptions,'dir'>):Promise<unknown>
  getSessionMessages(id:string,options?:Pick<GetSessionMessagesOptions,'dir'|'limit'|'offset'|'includeSystemMessages'>):Promise<unknown>
}
export interface ClaudeHistoryOptions {sdk?:ClaudeHistorySdk;timeoutMs?:number}
const defaultSdk:ClaudeHistorySdk={
  listSessions:async options=>(await import('@anthropic-ai/claude-agent-sdk')).listSessions(options),
  getSessionInfo:async(id,options)=>(await import('@anthropic-ai/claude-agent-sdk')).getSessionInfo(id,options),
  getSessionMessages:async(id,options)=>(await import('@anthropic-ai/claude-agent-sdk')).getSessionMessages(id,options),
}
function mapInfo(value:unknown):NativeHistoryItem {
  if(!historyObject(value)||typeof value.sessionId!=='string'||typeof value.summary!=='string'||!Number.isSafeInteger(value.lastModified)||Number(value.lastModified)<0)throw new Error('native_history_unavailable')
  for(const key of ['customTitle','firstPrompt'])if(value[key]!==undefined&&typeof value[key]!=='string')throw new Error('native_history_unavailable')
  for(const key of ['fileSize','createdAt'])if(value[key]!==undefined&&(!Number.isSafeInteger(value[key])||Number(value[key])<0))throw new Error('native_history_unavailable')
  const custom=typeof value.customTitle==='string'?value.customTitle.trim():'',summary=value.summary.trim(),first=typeof value.firstPrompt==='string'?value.firstPrompt.trim():''
  return {key:encodeNativeHistoryKey('claude',value.sessionId),providerId:'claude',nativeId:value.sessionId,title:(custom||summary||first||'Claude session').slice(0,40_000),titleSource:custom?'native_custom':summary?'native_summary':first?'first_prompt':'fallback',cwd:historyCwd(value.cwd),updatedAt:Number(value.lastModified),remote:false,observedState:'unknown'}
}
function offset(cursor:string|undefined,scope:Record<string,unknown>):number {
  if(cursor===undefined)return 0
  const value=readHistoryCursor(cursor,scope)
  if(typeof value!=='number')throw new Error('invalid_cursor')
  return value
}
export function createClaudeHistoryReader(options:ClaudeHistoryOptions={}):NativeHistoryReader {
  const sdk=options.sdk??defaultSdk
  const reader:NativeHistoryReader={
    async list(input){
      const call=historyDeadline(options.timeoutMs)
      const query=normalizeHistoryList(input),scope={providerId:'claude',kind:'list',q:query.q,cwd:query.cwd??null}
      let nativeOffset=offset(query.cursor,scope),scanned=0
      const items:NativeHistoryItem[]=[]
      while(scanned<500){
        const size=Math.min(100,500-scanned)
        const rows=await call(()=>sdk.listSessions({...(query.cwd?{dir:query.cwd}:{}),includeWorktrees:false,offset:nativeOffset,limit:size}))
        if(!Array.isArray(rows)||rows.length>size)throw new Error('native_history_unavailable')
        for(let index=0;index<rows.length;index++){
          nativeOffset++;scanned++
          let item:NativeHistoryItem
          try{item=mapInfo(rows[index])}catch{continue}
          if((query.cwd&&item.cwd!==query.cwd)||!item.title.toLowerCase().includes(query.q.toLowerCase()))continue
          items.push(item)
          if(items.length===query.limit){
            const exhausted=index===rows.length-1&&rows.length<size
            return {items,nextCursor:exhausted?null:historyCursor(scope,nativeOffset),coverage:'native_supported_history'}
          }
        }
        if(rows.length<size)return {items,nextCursor:null,coverage:'native_supported_history'}
      }
      return {items,nextCursor:historyCursor(scope,nativeOffset),coverage:'native_supported_history'}
    },
    async read(key,input){
      const call=historyDeadline(options.timeoutMs)
      const {nativeId}=decodeNativeHistoryKey(key,'claude'),page=normalizeHistoryRead(input),scope={providerId:'claude',kind:'read',nativeId}
      const nativeOffset=offset(page.cursor,scope)
      const info=await call(()=>sdk.getSessionInfo(nativeId))
      if(info===undefined)throw new Error('native_history_unsupported')
      const session=mapInfo(info)
      if(session.nativeId!==nativeId)throw new Error('native_history_unavailable')
      const rows=await call(()=>sdk.getSessionMessages(nativeId,{limit:page.limit,offset:nativeOffset,includeSystemMessages:false}))
      if(!Array.isArray(rows)||rows.length>page.limit)throw new Error('native_history_unavailable')
      const messages:NativeHistoryMessage[]=[]
      for(const row of rows){
        if(!historyObject(row))continue
        if(row.session_id!==nativeId)throw new Error('native_history_unavailable')
        if((row.type!=='user'&&row.type!=='assistant')||typeof row.uuid!=='string'||!row.uuid||row.uuid.length>200||row.isMeta===true||row.parent_tool_use_id!=null||!historyObject(row.message))continue
        const message=historyMessage(row.uuid,row.type,historyText(row.message.content));if(message)messages.push(message)
      }
      return historyPreview(session,info,messages,rows.length===page.limit?historyCursor(scope,nativeOffset+rows.length):null,page)
    },
    async currentFingerprint(key,input={limit:100}){return (await reader.read(key,input)).sourceFingerprint},
  }
  return reader
}

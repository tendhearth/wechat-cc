import {createHash,randomBytes} from 'node:crypto'
import {decodeNativeHistoryKey,normalizeHistoryRead,historyDeadline,type NativeHistoryMessage,type NativeHistoryPreview,type NativeHistoryReadInput,type NativeHistoryReader,type NativeHistoryProvider} from './native-history'
export interface ImportPage {limit:number;cursor:string|null;sourceFingerprint:string}
export interface NativeImportInput {key:string;pages:ImportPage[];messageIds:string[]}
export interface NativeSource {
 id:string;taskId:string;providerId:NativeHistoryProvider;nativeId:string;cwd:string;importedAt:number;firstDispatchedAt:number|null
 snapshotSha256:string;observedFingerprint:string;selectedMessageCount:number;truncated:boolean
}
export interface StoredNativeSource extends NativeSource {snapshotJson:string;pagesJson:string}
export const publicSource=({snapshotJson:_snapshot,pagesJson:_pages,...source}:StoredNativeSource):NativeSource=>source
export const snapshotHash=(text:string)=>createHash('sha256').update(text).digest('hex')
export function nativeImportInput(value:NativeImportInput):NativeImportInput {
 if(!value||!Array.isArray(value.pages)||value.pages.length<1||value.pages.length>5||!Array.isArray(value.messageIds)||value.messageIds.length<1||value.messageIds.length>200)throw new Error('invalid_request')
 decodeNativeHistoryKey(value.key)
 const pages=value.pages.map(p=>{if(!p||typeof p.sourceFingerprint!=='string'||! /^[a-f0-9]{64}$/.test(p.sourceFingerprint))throw new Error('invalid_request');const n=normalizeHistoryRead({limit:p.limit,...(p.cursor===null?{}:{cursor:p.cursor})});return{...n,cursor:n.cursor??null,sourceFingerprint:p.sourceFingerprint}})
 if(value.messageIds.some(id=>typeof id!=='string'||!id||id.length>200)||new Set(value.messageIds).size!==value.messageIds.length||new Set(pages.map(p=>p.cursor)).size!==pages.length)throw new Error('invalid_request')
 return{key:value.key,pages,messageIds:[...value.messageIds]}
}
/** Capture exactly selected, displayed text. Never silently truncate an import. */
export async function readNativeImport(reader:NativeHistoryReader,raw:NativeImportInput){
 const input=nativeImportInput(raw),pages:NativeHistoryPreview[]=[],call=historyDeadline()
 for(const page of input.pages){
  const current=await call(()=>reader.read(input.key,{limit:page.limit,...(page.cursor===null?{}:{cursor:page.cursor})}))
  if(current.sourceFingerprint!==page.sourceFingerprint)throw new Error('native_history_changed')
  pages.push(current)
 }
 const session=pages[0]!.session,{providerId,nativeId}=decodeNativeHistoryKey(input.key)
 if(pages.some(p=>p.session.key!==input.key||p.session.cwd!==session.cwd)||session.providerId!==providerId||session.nativeId!==nativeId)throw new Error('native_history_changed')
 const available=new Map(pages.flatMap(p=>p.messages).map(m=>[m.id,m])),messages:NativeHistoryMessage[]=[]
 // Keep native order even when the client submits IDs out of order.
 const selected=new Set(input.messageIds)
 if(input.messageIds.some(id=>!available.has(id)))throw new Error('invalid_request')
 for(const message of available.values())if(selected.has(message.id))messages.push(message)
 if(messages.reduce((n,m)=>n+m.text.length,0)>24_000)throw new Error('native_import_too_large')
 const truncated=pages.some(p=>p.truncated)||pages.at(-1)!.nextCursor!==null||pages[0]!.page.cursor!==null||messages.length!==available.size
 const snapshotJson=JSON.stringify({v:1,key:input.key,messages}),snapshotSha256=snapshotHash(snapshotJson)
 return{session,messages,snapshotJson,snapshotSha256,pagesJson:JSON.stringify(input.pages),observedFingerprint:snapshotHash(JSON.stringify(input.pages)),truncated}
}
export interface NativeResumeDecision {
 token:string;taskId:string;sourceId:string;providerId:NativeHistoryProvider;nativeId:string;path:string
 mode:'native_resume'|'fresh_context';expiresAt:number;context:string;truncated:boolean;changedSinceImport:boolean
 execution?:import('../agent-provider').AgentExecutionChoice
}
export interface AcceptedNativeResume extends NativeResumeDecision {pages:ImportPage[];taskVersion:string;directoryIdentity:string;restartToken?:string;execution:import('../agent-provider').AgentExecutionChoice}
/** An opaque approval is kept server-side, bound to the displayed decision and short lived. */
export const nativeResumeToken=()=>randomBytes(32).toString('hex')
export const pageInput=(p:ImportPage):NativeHistoryReadInput=>({limit:p.limit,...(p.cursor===null?{}:{cursor:p.cursor})})

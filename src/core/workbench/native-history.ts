import { createHash } from 'node:crypto'
import { isAbsolute, normalize } from 'node:path'

export type NativeHistoryProvider='claude'|'codex'
export interface NativeHistoryItem {
  key:string;providerId:NativeHistoryProvider;nativeId:string
  title:string;titleSource:'native_custom'|'native_summary'|'first_prompt'|'fallback'
  cwd:string|null;updatedAt:number|null;remote:boolean;observedState:'active'|'observed'|'unknown'
}
export interface NativeHistoryMessage {id:string;role:'user'|'assistant';text:string;truncated:boolean}
export interface NativeHistoryPage {items:NativeHistoryItem[];nextCursor:string|null;coverage:'native_supported_history'|'native_indexed_history'}
export interface NativeHistoryListInput {q:string;limit:number;cursor?:string;cwd?:string}
export interface NativeHistoryReadInput {limit:number;cursor?:string}
export interface NativeHistoryPreview {
  session:NativeHistoryItem;messages:NativeHistoryMessage[];nextCursor:string|null;sourceFingerprint:string
  page:{limit:number;cursor:string|null};truncated:boolean
}
export interface NativeHistoryReader {
  list(input:NativeHistoryListInput):Promise<NativeHistoryPage>
  read(key:string,input:NativeHistoryReadInput):Promise<NativeHistoryPreview>
  currentFingerprint(key:string,input?:NativeHistoryReadInput):Promise<string>
}
export const NATIVE_HISTORY_MAX_BYTES=2*1024*1024
export const NATIVE_HISTORY_TIMEOUT_MS=15_000
const ID=/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
export const historyObject=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)
export const historyHash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
function decode(value:string,error:string):Record<string,unknown> {
  try {
    if(typeof value!=='string'||Buffer.byteLength(value)>2048||!/^[A-Za-z0-9_-]+$/.test(value))throw new Error()
    const bytes=Buffer.from(value,'base64url')
    if(bytes.toString('base64url')!==value)throw new Error()
    const parsed:unknown=JSON.parse(bytes.toString('utf8'))
    if(!historyObject(parsed))throw new Error()
    return parsed
  }catch{throw new Error(error)}
}
export function encodeNativeHistoryKey(providerId:NativeHistoryProvider,nativeId:string):string {
  if(!['claude','codex'].includes(providerId)||typeof nativeId!=='string'||!ID.test(nativeId))throw new Error('invalid_native_history_key')
  return Buffer.from(JSON.stringify({v:1,providerId,nativeId})).toString('base64url')
}
export function decodeNativeHistoryKey(key:string,expected?:NativeHistoryProvider):{providerId:NativeHistoryProvider;nativeId:string} {
  const value=decode(key,'invalid_native_history_key')
  if(value.v!==1||(value.providerId!=='claude'&&value.providerId!=='codex')||typeof value.nativeId!=='string'||!ID.test(value.nativeId)||(expected&&value.providerId!==expected))throw new Error('invalid_native_history_key')
  return {providerId:value.providerId,nativeId:value.nativeId}
}
export function historyCursor(scope:Record<string,unknown>,position:number|string):string {
  const cursor=Buffer.from(JSON.stringify({v:1,scope:historyHash(scope),position})).toString('base64url')
  if(Buffer.byteLength(cursor)>2048)throw new Error('native_history_unavailable')
  return cursor
}
export function readHistoryCursor(cursor:string,scope:Record<string,unknown>):number|string {
  const value=decode(cursor,'invalid_cursor'),position=value.position
  if(value.v!==1||value.scope!==historyHash(scope)||!(typeof position==='string'&&position.length>0||typeof position==='number'&&Number.isSafeInteger(position)&&position>=0))throw new Error('invalid_cursor')
  return position as number|string
}
export function normalizeHistoryRead(input:NativeHistoryReadInput):NativeHistoryReadInput {
  if(!input||!Number.isInteger(input.limit)||input.limit<1||input.limit>100)throw new Error('invalid_request')
  if(input.cursor!==undefined&&(typeof input.cursor!=='string'||!input.cursor||Buffer.byteLength(input.cursor)>2048))throw new Error('invalid_cursor')
  return {limit:input.limit,...(input.cursor!==undefined?{cursor:input.cursor}:{})}
}
export function normalizeHistoryList(input:NativeHistoryListInput):NativeHistoryListInput {
  const page=normalizeHistoryRead(input)
  if(typeof input.q!=='string'||input.q.trim().length>200)throw new Error('invalid_request')
  if(input.cwd!==undefined&&(typeof input.cwd!=='string'||input.cwd.length>4096||input.cwd.includes('\0')||!isAbsolute(input.cwd)))throw new Error('invalid_request')
  const cwd=input.cwd===undefined?undefined:normalize(input.cwd).replace(/\/$/,'')||'/'
  return {...page,q:input.q.trim(),...(cwd!==undefined?{cwd}:{})}
}
export function historyCwd(value:unknown):string|null {
  if(value===undefined||value===null)return null
  if(typeof value!=='string'||value.length>4096||value.includes('\0')||!isAbsolute(value))throw new Error('native_history_unavailable')
  return normalize(value).replace(/\/$/,'')||'/'
}
export function historyMessage(id:string,role:'user'|'assistant',value:string):NativeHistoryMessage|null {
  const text=value.trim()
  if(!text||/^<(?:system-reminder|task-notification|command-message|environment_context|permissions instructions|local-command)(?:\s|>)/.test(text))return null
  return {id,role,text:text.slice(0,40_000),truncated:text.length>40_000}
}
export function historyText(content:unknown):string {
  if(typeof content==='string')return content
  if(!Array.isArray(content))return ''
  return content.filter(historyObject).filter(item=>item.type==='text'&&typeof item.text==='string').map(item=>item.text).join('\n')
}
export function nativeHistoryFailure(error:unknown):Error {
  if(historyObject(error)&&(error.code===-32601||error.code===-32602))return new Error('native_history_unsupported')
  if(error instanceof Error&&['invalid_request','invalid_cursor','invalid_native_history_key','native_history_unsupported','native_history_unavailable'].includes(error.message))return error
  return new Error('native_history_unavailable')
}
export function assertHistoryResponse(value:unknown):void {
  try {if(Buffer.byteLength(JSON.stringify(value)??'')>NATIVE_HISTORY_MAX_BYTES)throw new Error()}
  catch{throw new Error('native_history_unavailable')}
}
export async function boundedHistoryCall<T>(run:()=>Promise<T>,timeoutMs=NATIVE_HISTORY_TIMEOUT_MS):Promise<T> {
  let timer:ReturnType<typeof setTimeout>|undefined
  try {
    const value=await Promise.race([Promise.resolve().then(run),new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('native_history_unavailable')),Math.max(1,Math.min(timeoutMs,NATIVE_HISTORY_TIMEOUT_MS)))})])
    assertHistoryResponse(value)
    return value
  }catch(error){throw nativeHistoryFailure(error)}finally{if(timer)clearTimeout(timer)}
}
/** One budget for a whole list/read, including all native pages. */
export function historyDeadline(timeoutMs=NATIVE_HISTORY_TIMEOUT_MS) {
  const deadline=Date.now()+Math.max(1,Math.min(timeoutMs,NATIVE_HISTORY_TIMEOUT_MS))
  return <T>(run:()=>Promise<T>):Promise<T>=>{
    const remaining=deadline-Date.now()
    if(remaining<=0)return Promise.reject(new Error('native_history_unavailable'))
    return boundedHistoryCall(run,remaining)
  }
}
export function historyPreview(session:NativeHistoryItem,revision:unknown,messages:NativeHistoryMessage[],nextCursor:string|null,input:NativeHistoryReadInput):NativeHistoryPreview {
  const page={limit:input.limit,cursor:input.cursor??null}
  return {session,messages,nextCursor,page,truncated:messages.some(message=>message.truncated),sourceFingerprint:historyHash({providerId:session.providerId,nativeId:session.nativeId,cwd:session.cwd,revision,page,messages})}
}

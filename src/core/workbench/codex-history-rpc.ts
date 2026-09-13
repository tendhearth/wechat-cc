import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { workbenchCodexArgs, workbenchCodexEnv, workbenchFeatureConfig } from './codex-config'
import { historyObject, nativeHistoryFailure, NATIVE_HISTORY_MAX_BYTES, NATIVE_HISTORY_TIMEOUT_MS } from './native-history'

export type CodexHistoryMethod='thread/list'|'thread/read'|'thread/items/list'
export interface CodexHistoryRpc {request(method:CodexHistoryMethod,params:Record<string,unknown>):Promise<unknown>;close():Promise<void>}
export type HistoryProcess=Pick<ChildProcessWithoutNullStreams,'stdin'|'stdout'|'stderr'|'on'|'once'|'kill'|'pid'>
export interface CodexHistoryRpcOptions {
  codexPathOverride:string;cwd?:string;timeoutMs?:number;closeTimeoutMs?:number
  spawnProcess?:(binary:string,args:string[],options:SpawnOptionsWithoutStdio)=>HistoryProcess
}
const METHODS=new Set(['initialize','thread/list','thread/read','thread/items/list'])
const validId=(value:unknown):value is string|number=>typeof value==='string'||typeof value==='number'&&Number.isSafeInteger(value)

/** A short-lived catalog process. It has no thread/turn execution or config-write methods. */
export async function openCodexHistoryRpc(options:CodexHistoryRpcOptions):Promise<CodexHistoryRpc> {
  if(process.platform==='win32')throw new Error('native_history_unsupported')
  let child:HistoryProcess
  try {
    child=(options.spawnProcess??spawn)(options.codexPathOverride,[...workbenchCodexArgs({...workbenchFeatureConfig,web_search:'disabled'}),'app-server','--listen','stdio://'],{
      ...(options.cwd?{cwd:options.cwd}:{}),env:workbenchCodexEnv(),stdio:'pipe',detached:true,windowsHide:true,
    }) as HistoryProcess
  }catch{throw new Error('native_history_unavailable')}
  const pending=new Map<string|number,{resolve:(value:unknown)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>()
  const decoder=new StringDecoder('utf8')
  let sequence=0,buffer='',closing=false,exited=false,broken:Error|undefined,closePromise:Promise<void>|undefined
  let lifetimeTimer:ReturnType<typeof setTimeout>|undefined
  const rejectPending=(error:Error)=>{for(const item of pending.values()){clearTimeout(item.timer);item.reject(error)}pending.clear()}
  const signal=(kind:NodeJS.Signals)=>{
    try{if(child.pid)process.kill(-child.pid,kind);else if(!exited)child.kill(kind)}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error}
  }
  const alive=()=>{
    if(!child.pid)return !exited
    try{process.kill(-child.pid,0);return true}catch(error){return (error as NodeJS.ErrnoException).code!=='ESRCH'}
  }
  const close=():Promise<void>=>{
    if(closePromise)return closePromise
    if(lifetimeTimer)clearTimeout(lifetimeTimer)
    closing=true;rejectPending(broken??new Error('native_history_unavailable'))
    closePromise=(async()=>{
      try{
        child.stdin.end();signal('SIGTERM')
        const duration=Math.max(10,Math.min(options.closeTimeoutMs??2000,2500)),deadline=Date.now()+duration
        let killed=false
        while(!exited||alive()){
          if(!killed&&Date.now()>=deadline-duration/2){signal('SIGKILL');killed=true}
          if(Date.now()>=deadline)throw new Error('native_history_unavailable')
          await new Promise<void>(resolve=>setTimeout(resolve,5))
        }
      }catch{throw new Error('native_history_unavailable')}
    })()
    return closePromise
  }
  const fatal=(error:Error=new Error('native_history_unavailable'))=>{
    if(broken||closing)return
    broken=error;rejectPending(error);void close().catch(()=>{})
  }
  const send=(message:Record<string,unknown>)=>{
    if(exited||child.stdin.destroyed||child.stdin.writableEnded){fatal();return}
    try{child.stdin.write(JSON.stringify(message)+'\n',error=>{if(error)fatal()})}catch{fatal()}
  }
  const request=(method:string,params:Record<string,unknown>):Promise<unknown>=>{
    if(!METHODS.has(method))return Promise.reject(new Error('native_history_unsupported'))
    if(closing||exited||broken)return Promise.reject(broken??new Error('native_history_unavailable'))
    const id=`history-${++sequence}`
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>fatal(),Math.max(1,Math.min(options.timeoutMs??NATIVE_HISTORY_TIMEOUT_MS,NATIVE_HISTORY_TIMEOUT_MS)))
      pending.set(id,{resolve,reject,timer});send({id,method,params})
    })
  }
  child.stderr.resume() // Drain without exposing diagnostics or native credentials.
  child.on('error',()=>{exited=true;fatal()})
  child.on('close',()=>{exited=true;if(!closing)fatal()})
  child.stdout.on('data',(chunk:Buffer|string)=>{
    if(closing)return
    buffer+=typeof chunk==='string'?chunk:decoder.write(chunk)
    // Bound each JSONL frame, including an unterminated response.
    for(;;){
      const end=buffer.indexOf('\n')
      if(end<0){if(Buffer.byteLength(buffer)>NATIVE_HISTORY_MAX_BYTES)fatal();return}
      const line=buffer.slice(0,end);buffer=buffer.slice(end+1)
      if(Buffer.byteLength(line)>NATIVE_HISTORY_MAX_BYTES){fatal();return}
      let value:unknown
      try{value=JSON.parse(line)}catch{fatal();return}
      if(!historyObject(value)){fatal();return}
      if(typeof value.method==='string'){
        if(validId(value.id)){
          send({id:value.id,error:{code:-32601,message:'Read-only history client refuses server requests'}})
          fatal();return
        }
        // Notifications are observations only; no execution handler is installed.
        continue
      }
      if(!validId(value.id)||!pending.has(value.id)){fatal();return}
      const item=pending.get(value.id)!;pending.delete(value.id);clearTimeout(item.timer)
      if(value.error!==undefined){item.reject(nativeHistoryFailure(value.error));continue}
      if(!Object.hasOwn(value,'result')){item.reject(new Error('native_history_unavailable'));fatal();return}
      item.resolve(value.result)
    }
  })
  lifetimeTimer=setTimeout(()=>fatal(),Math.max(1,Math.min(options.timeoutMs??NATIVE_HISTORY_TIMEOUT_MS,NATIVE_HISTORY_TIMEOUT_MS)))
  try{
    await request('initialize',{clientInfo:{name:'cc_workbench_history',title:'CC Workbench History',version:'0.6.4'},capabilities:{experimentalApi:false,requestAttestation:false}})
    send({method:'initialized'})
    return {request:(method,params)=>request(method,params),close}
  }catch(error){await close().catch(()=>{});throw nativeHistoryFailure(error)}
}

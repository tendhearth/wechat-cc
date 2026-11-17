import {isNetworkUnprotectedError} from '../../../lib/network-gate'
import {isOfflineErrorCode} from '../../../lib/net-errors'
import {openaiErrorCode,openaiErrorStatus} from './openai-error-code'

export interface OpenaiRetryOptions{
  /** 测试注入;生产等待会随请求的 AbortSignal 取消。 */
  retrySleep?:(ms:number,signal:AbortSignal)=>Promise<void>
  retryRandom?:()=>number
  /** 等待结束后再核一次守护;拒绝直接传出去,不进入下一次尝试。 */
  beforeRetry?:(signal:AbortSignal)=>Promise<void>
  log?:(tag:string,line:string)=>void
}

export function retrySleep(ms:number,signal:AbortSignal):Promise<void>{
  signal.throwIfAborted()
  return new Promise((resolve,reject)=>{
    const abort=()=>{clearTimeout(timer);reject(signal.reason)}
    const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve()},ms)
    signal.addEventListener('abort',abort,{once:true})
  })
}

function retryable(error:unknown):boolean{
  // 守护拒绝和明确离线不是偶发网关失败。SDK 可能把系统错误包在 cause 中。
  let cause=error
  const seen=new Set<unknown>()
  while(cause&&typeof cause==='object'&&!seen.has(cause)){
    seen.add(cause)
    if(isNetworkUnprotectedError(cause))return false
    const e=cause as {code?:unknown;name?:unknown;cause?:unknown}
    if(e.name==='AbortError'||isOfflineErrorCode(e.code))return false
    cause=e.cause
  }
  const status=openaiErrorStatus(error)
  if(status!==undefined)return[401,404,408,409,410,429].includes(status)||(status>=500&&status<600)
  return openaiErrorCode(error)==='network'
}

/** 单请求内最多两次,不建后台重发任务,外层冷却只看到最终结果。SDK 的重试必须关掉。 */
export function makeOpenaiRetry(model:string,options:OpenaiRetryOptions){
  return async(error:unknown,retries:number,outputStarted:boolean,signal:AbortSignal,limit:number):Promise<boolean>=>{
    signal.throwIfAborted()
    if(outputStarted||retries>=limit||!retryable(error))return false
    const ms=2000*2**retries+Math.floor((options.retryRandom??Math.random)()*200)
    await(options.retrySleep??retrySleep)(ms,signal)
    signal.throwIfAborted()
    await options.beforeRetry?.(signal)
    signal.throwIfAborted()
    options.log?.('OPENAI_RETRY',`attempt=${retries+2} status=${openaiErrorStatus(error)??'network'} model=${model.replace(/\s/g,'_')}`)
    return true
  }
}

import type {AgentEvent} from '../agent-provider'
import type {TaskEvent} from './store'
import {executionFailureMessage} from './execution-settings'

/** One observed native error shape, on the error channel only. Never scan assistant prose. */
export function codexExecutionErrorCode(message:string):'execution_model_unsupported'|undefined {
  if(message.length>40_000)return
  try {
    const value=JSON.parse(message)
    if(value?.type==='error'&&value.status===400&&value.error?.type==='invalid_request_error'&&
      typeof value.error.message==='string'&&/^The '[^'\r\n]{1,200}' model is not supported when using Codex with a ChatGPT account\.$/.test(value.error.message))return 'execution_model_unsupported'
  } catch { /* Unknown native errors retain their original meaning. */ }
}
export const codexErrorEvent=(message:string):Extract<AgentEvent,{kind:'error'}>=>{
  const code=codexExecutionErrorCode(message)
  return {kind:'error',message,...(code?{code}:{})}
}
export class CodexExecutionError extends Error {
  readonly code='execution_model_unsupported'
}
export const codexRpcError=(message:string):Error=>codexExecutionErrorCode(message)?new CodexExecutionError(message):new Error(message)

/** Persist native bytes as before; translate only the public reading projection. */
export function readableExecutionEvent(event:TaskEvent):TaskEvent {
  if(event.kind!=='error')return event
  const code=codexExecutionErrorCode(event.text)
  return code?{...event,text:executionFailureMessage(code).replace('当前模型不可用。','当前账号不支持所用模型。'),errorCode:code,diagnostic:event.text}:event
}

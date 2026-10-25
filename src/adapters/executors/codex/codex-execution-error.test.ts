import {expect,it} from 'vitest'
import {codexErrorEvent,codexExecutionErrorCode,codexRpcError,CodexExecutionError,readableExecutionEvent} from './codex-execution-error'

const raw=JSON.stringify({type:'error',status:400,error:{type:'invalid_request_error',message:"The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account."}})
it('recognizes the harvested Codex model rejection and retains native bytes',()=>{
  expect(codexErrorEvent(raw)).toEqual({kind:'error',message:raw,code:'execution_model_unsupported'})
  expect(codexRpcError(raw)).toBeInstanceOf(CodexExecutionError)
  expect(codexRpcError(raw).message).toBe(raw)
})
it('does not infer account/model failures from arbitrary prose, auth or another HTTP shape',()=>{
  for(const message of ["The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.",'401 auth failed','model not found',JSON.stringify({type:'error',status:401,error:{type:'invalid_request_error',message:"The 'x' model is not supported when using Codex with a ChatGPT account."}}),JSON.stringify({type:'error',status:400,error:{type:'authentication_error',message:"The 'x' model is not supported when using Codex with a ChatGPT account."}}),JSON.stringify({type:'error',status:400,error:{type:'invalid_request_error',message:"Quoted: The 'x' model is not supported when using Codex with a ChatGPT account."}})]){
    expect(codexExecutionErrorCode(message)).toBeUndefined()
    expect(codexRpcError(message)).not.toBeInstanceOf(CodexExecutionError)
  }
})
it('translates only an error reading projection without rewriting history or assistant quotations',()=>{
  const event={id:1,taskId:'deadbeef',kind:'error' as const,text:raw,createdAt:1}
  expect(readableExecutionEvent(event)).toMatchObject({errorCode:'execution_model_unsupported',diagnostic:raw,text:expect.stringContaining('当前账号不支持')})
  expect(event.text).toBe(raw)
  expect(readableExecutionEvent({...event,kind:'text'})).toEqual({...event,kind:'text'})
})

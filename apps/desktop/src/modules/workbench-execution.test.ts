import {expect,it,vi} from 'vitest'
import {createExecutionCatalogs,executionSignature,parseExecutionChoice,renderExecutionControls,renderExecutionObservation} from './workbench-execution.js'
const automatic={defaults:'native' as const,model:null,reasoningEffort:null}
const catalog={source:'native' as const,models:[{id:'native-model',displayName:'Native model',reasoningEfforts:['low','deep']}],defaultModel:'native-model'}
it('keeps automatic inheritance distinct from explicit choices and rejects malformed draft fields',()=>{
 expect(parseExecutionChoice(automatic)).toEqual(automatic)
 expect(parseExecutionChoice({...automatic,model:'m',token:'not saved'})).toEqual({...automatic,model:'m'})
 expect(parseExecutionChoice({...automatic,reasoningEffort:42})).toBeNull()
 expect(executionSignature(automatic)).not.toBe(executionSignature({...automatic,model:'m'}))
})
it('loads only on request and isolates late catalogs by provider and exact project',async()=>{
 const pending=new Map<string,(value:unknown)=>void>(),changed=vi.fn(),invoke=vi.fn(async(_m,_p)=>new Promise(resolve=>pending.set(_p,resolve)))
 const values=createExecutionCatalogs({invokeWorkbenchApi:invoke,changed})
 expect(values.get('claude','/A').status).toBe('idle');expect(invoke).not.toHaveBeenCalled()
 const a=values.load('claude','/A'),b=values.load('codex','/B')
 expect(invoke.mock.calls[0]?.[1]).toBe('/v1/workbench/models?providerId=claude&path=%2FA')
 pending.get(invoke.mock.calls[1]![1])!({catalog});await b
 expect(values.get('claude','/A').status).toBe('loading');expect(values.get('codex','/B').catalog).toEqual(catalog)
 pending.get(invoke.mock.calls[0]![1])!({catalog:{...catalog,models:[]}});await a
 await values.load('codex','/B');expect(invoke).toHaveBeenCalledTimes(2)
 expect(values.get('claude','/B').status).toBe('idle')
})
it('reports discovery failures without inventing models and permits an explicit retry',async()=>{
 const invoke=vi.fn().mockRejectedValueOnce(Error('unsupported')).mockResolvedValueOnce({catalog})
 const values=createExecutionCatalogs({invokeWorkbenchApi:invoke})
 await values.load('claude','/A');expect(values.get('claude','/A').status).toBe('error')
 expect(renderExecutionControls(automatic,values.get('claude','/A'))).toContain('暂时无法读取模型')
 await values.load('claude','/A',true);expect(values.get('claude','/A').status).toBe('ready')
})
it('renders native efforts, keeps unavailable saved choices, and disables edits during an active run',()=>{
 const ready={status:'ready' as const,catalog,error:''}
 const html=renderExecutionControls({...automatic,model:'native-model',reasoningEffort:'deep'},ready)
 expect(html).toContain('value="deep" selected');expect(html).not.toContain('value="xhigh"')
 expect(html).toContain('自动（沿用当前设置）')
 expect(renderExecutionControls({...automatic,model:'removed'},ready)).toContain('removed（当前不可用）')
 expect(renderExecutionControls(automatic,ready,true).match(/<select[^>]* disabled/g)).toHaveLength(2)
 expect(renderExecutionControls(automatic,ready)).toContain('<option value="" selected>')
})
it('shows only native-confirmed observations and keeps unreported effort unknown',()=>{
 expect(renderExecutionObservation(null)).toContain('执行者尚未报告实际模型')
 const html=renderExecutionObservation({effective:{model:'observed-model',source:'native_response'},choice:{...automatic,model:'requested-model'}} as any)
 expect(html).toContain('observed-model');expect(html).not.toContain('requested-model');expect(html).toContain('思考强度未报告')
})
it('keeps recovery previews scoped to task, retained version and selected execution, including failed retries',async()=>{
 const {createContinuationPreviews}=await import('./workbench-execution.js')
 const calls:any[]=[],pending=new Map<string,{resolve:(value:any)=>void,reject:(error:any)=>void}>()
 const previews=createContinuationPreviews({invokeWorkbenchApi:async(_m,_p,body)=>{calls.push(body);return await new Promise((resolve,reject)=>pending.set((body!.execution as {model:string}).model,{resolve,reject}))}})
 const a={taskId:'deadbeef',version:'version-A',execution:{...automatic,model:'A'}},b={...a,execution:{...automatic,model:'B'}}
 const first=previews.load(a),second=previews.load(b)
 pending.get('B')!.reject(Error('lost_response'));await second
 expect(previews.get(b).status).toBe('error');expect(previews.get(a).status).toBe('loading')
 const retry=previews.load(b,true),continuation={mode:'restart_required',restart:{token:'b'.repeat(64),context:'B recovery',eventCount:1,includedEventCount:1,truncated:false}}
 pending.get('B')!.resolve({continuation});await retry
 pending.get('A')!.resolve({continuation:{...continuation,restart:{...continuation.restart,token:'a'.repeat(64)}}});await first
 expect(previews.get(b).continuation).toEqual(continuation)
 expect(previews.get({...b,taskId:'cafefeed'}).status).toBe('idle')
 expect(previews.get({...b,version:'updated'}).status).toBe('idle')
 expect(calls[1]).toEqual({id:'deadbeef',execution:b.execution})
})
it('explains execution choice failures without exposing machine codes or changing unrelated errors',async()=>{
 const {executionErrorMessage}=await import('./workbench-execution.js')
 expect(executionErrorMessage('execution_model_unsupported')).toContain('重新选择模型')
 expect(executionErrorMessage('execution_effort_unsupported')).toContain('思考强度')
 expect(executionErrorMessage('execution_model_unknown')).toContain('明确选择')
 expect(executionErrorMessage('execution_image_unsupported')).toContain('不接收图片')
 expect(executionErrorMessage('model_catalog_invalid')).toContain('重新读取')
 expect(executionErrorMessage('model_catalog_unavailable')).toContain('重新读取')
 expect(executionErrorMessage('workbench_attachments_unsupported')).toContain('移除附件')
 expect(executionErrorMessage('workbench_execution_unsupported')).toContain('自动')
 expect(executionErrorMessage('workbench_resume_unsupported')).toContain('桌面')
 expect(executionErrorMessage('provider_quota_exhausted')).toContain('额度')
 expect(executionErrorMessage('provider_rate_limited')).toContain('稍后')
 expect(executionErrorMessage('workbench_busy')).toContain('文件夹')
 expect(executionErrorMessage('unavailable_provider')).toContain('连接或管理')
 expect(executionErrorMessage('unavailable_provider')).not.toContain('安装')
 expect(executionErrorMessage('api_task_attachment_unsupported')).toContain('PDF')
 expect(executionErrorMessage('api_task_incomplete')).toContain('未完整结束')
 expect(executionErrorMessage('api_task_private_scope')).toContain('项目文件夹')
 expect(executionErrorMessage('api_task_request_failed')).toContain('端点')
 expect(executionErrorMessage('existing_other_error')).toBeNull()
})

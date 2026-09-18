// @ts-check
/** @typedef {{defaults:'provider'|'native',model:string|null,reasoningEffort:string|null}} ExecutionChoice */
/** @typedef {{id:string,displayName:string,reasoningEfforts:string[],description?:string,defaultReasoningEffort?:string,inputModalities?:string[]}} ExecutionModel */
/** @typedef {{models:ExecutionModel[],defaultModel?:string,source:'native'}} ModelCatalog */
/** @typedef {{status:'idle'|'loading'|'ready'|'error',catalog:ModelCatalog|null,error:string}} CatalogState */
/** @typedef {{taskId:string,runId:string,choice:ExecutionChoice,effective:{model:string,reasoningEffort?:string,source:string}|null}} RunExecution */
const esc=(/** @type {unknown} */ value)=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]??c)
const identifier=(/** @type {unknown} */ value)=>typeof value==='string'&&value.length>0&&value.length<=200&&!/[\u0000-\u001f\u007f]/.test(value)
/** @param {unknown} value @returns {ExecutionChoice|null} */
export function parseExecutionChoice(value){
 if(!value||typeof value!=='object'||Array.isArray(value))return null
 const v=/** @type {ExecutionChoice} */(value)
 if(!['provider','native'].includes(v.defaults)||(v.model!==null&&!identifier(v.model))||(v.reasoningEffort!==null&&!identifier(v.reasoningEffort)))return null
 return{defaults:v.defaults,model:v.model,reasoningEffort:v.reasoningEffort}
}
/** @param {ExecutionChoice|undefined|null} value */
export const executionSignature=value=>JSON.stringify(value?[value.defaults,value.model,value.reasoningEffort]:null)
/** Keep diagnostic codes in task records; present only these execution failures as actions.
 * @param {unknown} error @returns {string|null} */
export function executionErrorMessage(error){
 const code=error instanceof Error?error.message:String(error)
 const messages=/** @type {Record<string,string>} */({
  execution_model_unsupported:'当前模型不可用，请重新选择模型，或使用自动。',
  execution_effort_unsupported:'这个模型不支持所选思考强度，请重新选择，或使用自动。',
  execution_model_unknown:'暂时无法确认当前模型，请明确选择一个模型后重试。',
  execution_image_unsupported:'所选模型不接收图片，请更换支持图片的模型，或移除图片。',
  model_catalog_invalid:'暂时无法读取模型，请重新读取后再选择；也可以使用自动。',
  model_catalog_unavailable:'暂时无法读取模型，请重新读取后再选择；也可以使用自动。',
  workbench_attachments_unsupported:'这个执行者暂不支持工作任务附件。请移除附件，或改用支持附件的执行者。',
  workbench_execution_unsupported:'这个执行者暂不支持所选执行设置。请改用自动设置，或选择其他执行者。',
  workbench_resume_unsupported:'这个执行者无法安全恢复原会话。请在桌面查看恢复说明，并决定是否带记录重新开始。',
  unavailable_provider:'暂时没有可用的工作执行者。请连接或管理一个支持工作任务的执行者。',
  unattended_ack_required:'这是免审执行者，需要先在工作台确认一次；任务没有开始。',
  api_task_attachment_unsupported:'这个 API 执行者暂不支持 PDF 或其他二进制附件。请改用文字、CSV、JSON 或图片。',
  api_task_attachment_invalid:'附件内容已变化或无法安全读取，请重新添加后再试。',
  api_task_input_invalid:'任务内容或附件超出 API 执行者的处理范围，请缩短内容或减少附件。',
  api_task_incomplete:'API 响应未完整结束，任务没有被标记为完成。请检查服务状态后重试。',
  api_task_response_invalid:'API 返回了无法安全继续的响应，任务已停止。请检查模型兼容性。',
  api_task_scope_changed:'任务文件夹已变化，为避免读写错误，API 执行者已停止。请重新打开任务。',
  api_task_private_scope:'所选文件夹与任务服务的私有状态目录重叠。请选择具体的项目文件夹。',
  api_task_request_failed:'API 请求失败。请检查端点和网络后重试。',
  api_task_close_unconfirmed:'API 请求尚未确认结束。请等待或重启服务后查看中断状态，不要重复提交。',
  api_task_step_limit:'API 任务达到步骤上限。请缩小任务范围后继续。',
  api_task_tool_failed:'API 执行者未能完成文件操作。请查看任务记录后重试。',
  api_task_cancelled:'API 任务已停止，没有继续执行后续操作。',
  provider_quota_exhausted:'这个执行者的额度已用完。可以交给另一位执行者继续，或等额度恢复后再试。',
  provider_rate_limited:'这个执行者暂时被限流，请稍后再试；也可以交给另一位执行者继续。',
  workbench_busy:'这个文件夹正有另一个任务在写，等它答复后再续接。',
  review_file_unmarkable:'这个文件没有展开差异，不能标记。',
  invalid_review_reference:'改动记录已经变了，请刷新后再试。',
 })
 const ACP_SESSION='Cursor 的 ACP 会话无法建立或中断，请确认 cursor-agent 是支持 acp 子命令的版本后重试。'
 const acp=/** @type {Array<[string,string]>} */([
  ['acp_auth_required','Cursor 登录态失效，请在电脑上跑一次 cursor-agent login 后再试。'],
  ['acp_resume_unsupported','这个版本的 Cursor 不支持接着原会话，请带记录重新开始。'],
  ['acp_protocol_version_unsupported',ACP_SESSION],['acp_session_failed',ACP_SESSION],['acp_process_exited',ACP_SESSION],
  ['acp_process_start_failed',ACP_SESSION],['acp_invalid_protocol_message',ACP_SESSION],['acp_line_too_long',ACP_SESSION],['acp_protocol_write_failed',ACP_SESSION],
  ['acp_session_closed',ACP_SESSION],
  ['acp_stop_max_tokens','Cursor 因输出长度上限停了下来，请缩小要求或分步进行。'],
  ['acp_stop_max_turn_requests','Cursor 因单轮请求次数上限停了下来，请缩小要求或分步进行。'],
  ['acp_stop_refusal','Cursor 拒绝了这项要求，没有继续。'],
  ['acp_resume_session_mismatch','Cursor 接上的不是原会话，已停止；请带记录重新开始。'],
  ['acp_rpc_timeout','Cursor 长时间没有响应，任务已停止；请检查 cursor-agent 是否正常后重试。'],
  ['acp_turn_already_running','Cursor 正在处理上一轮，请等它答复后再发。'],
  ['acp_attachments_unsupported','Cursor 执行者暂不支持附件，请移除附件后再试。'],
 ])
 for(const [prefix,text] of acp) if(code===prefix||code.startsWith(`${prefix}:`)) return text
 return messages[code]??null
}
/** @param {{invokeWorkbenchApi:(method:'GET'|'POST',path:string,body?:Record<string,unknown>)=>Promise<unknown>,changed?:(providerId:string,path:string)=>void}} deps */
export function createExecutionCatalogs(deps){
 /** @type {Map<string,CatalogState>} */const values=new Map()
 let alive=true
 const key=(/** @type {string} */providerId,/** @type {string} */path)=>JSON.stringify([providerId,path])
 return{
  /** @param {string} providerId @param {string} path @returns {CatalogState} */
  get(providerId,path){return structuredClone(values.get(key(providerId,path))??{status:'idle',catalog:null,error:''})},
  /** @param {string} providerId @param {string} path @param {boolean} [retry] */
  async load(providerId,path,retry=false){
   if(!alive||!providerId||!path)return
   const id=key(providerId,path),previous=values.get(id)
   if(previous?.status==='loading'||(previous&&!retry))return
   values.set(id,{status:'loading',catalog:null,error:''});deps.changed?.(providerId,path)
   try{
    const response=/** @type {{catalog:ModelCatalog}} */(await deps.invokeWorkbenchApi('GET','/v1/workbench/models?'+new URLSearchParams({providerId,path})))
    const c=response?.catalog
    if(c?.source!=='native'||!Array.isArray(c.models)||c.models.length>500||c.models.some(m=>!identifier(m.id)||!identifier(m.displayName)||!Array.isArray(m.reasoningEfforts)||m.reasoningEfforts.length>30||m.reasoningEfforts.some(e=>!identifier(e))))throw Error('invalid_catalog')
    if(!alive)return
    values.set(id,{status:'ready',catalog:structuredClone(c),error:''})
   }catch{if(!alive)return;values.set(id,{status:'error',catalog:null,error:'暂时无法读取模型；自动模式仍可继续。'})}
   if(alive)deps.changed?.(providerId,path)
  },
  destroy(){alive=false},
 }
}
/** @param {ExecutionChoice} choice @param {CatalogState} [state] @param {boolean} [disabled] */
export function renderExecutionControls(choice,state={status:'idle',catalog:null,error:''},disabled=false){
 const models=state.catalog?.models??[],model=models.find(m=>m.id===choice.model),efforts=model?.reasoningEfforts??[]
 const missing=choice.model&&!model?`<option value="${esc(choice.model)}" selected>${esc(choice.model)}${state.status==='ready'?'（当前不可用）':'（尚未确认）'}</option>`:''
 const unavailable=choice.reasoningEffort&&!efforts.includes(choice.reasoningEffort)?`<option value="${esc(choice.reasoningEffort)}" selected>${esc(choice.reasoningEffort)}（尚未确认）</option>`:''
 const auto='<option value=""'+(choice.model===null?' selected':'')+'>自动（沿用当前设置）</option>'
 return `<div class="wb-execution-controls"><label for="wb-model">模型<select id="wb-model" data-execution-defaults="${choice.defaults}"${disabled?' disabled':''}>${auto}${missing}${models.map(m=>`<option value="${esc(m.id)}"${choice.model===m.id?' selected':''}>${esc(m.displayName)}</option>`).join('')}</select></label><label for="wb-reasoning-effort">思考强度<select id="wb-reasoning-effort"${disabled||(!choice.model&&!choice.reasoningEffort)?' disabled':''}><option value=""${choice.reasoningEffort===null?' selected':''}>自动（沿用当前设置）</option>${unavailable}${efforts.map(e=>`<option value="${esc(e)}"${choice.reasoningEffort===e?' selected':''}>${esc(e)}</option>`).join('')}</select></label>${state.status==='loading'?'<small role="status">正在读取执行者提供的模型…</small>':state.status==='error'?`<small role="status">${esc(state.error)} <button class="wb-new" type="button" data-action="retry-execution-models">重新读取</button></small>`:state.status==='idle'?'<small>选择文件夹后，展开设置即可读取可用模型。</small>':''}${disabled?'<small>本轮结束后可调整；设置用于下一轮。</small>':'<small>选择只在下次开始或继续任务时使用。</small>'}</div>`
}
/** @param {RunExecution|null|undefined} value */
export function renderExecutionObservation(value){
 return `<p class="wb-execution-observation">${value?.effective?`上次执行者报告：${esc(value.effective.model)} · ${value.effective.reasoningEffort?esc(value.effective.reasoningEffort):'思考强度未报告'}`:'执行者尚未报告实际模型。'}</p>`
}

/** @typedef {{taskId:string,version:string,execution:ExecutionChoice}} ContinuationContext */
/** @typedef {{mode:string,restart?:{token:string,context:string,eventCount:number,includedEventCount:number,truncated:boolean}}} Continuation */
/** @typedef {{status:'idle'|'loading'|'ready'|'error',continuation:Continuation|null,error:string}} ContinuationPreviewState */
/** @param {ContinuationContext} context */
export const continuationPreviewKey=context=>JSON.stringify([context.taskId,context.version,executionSignature(context.execution)])
/** Tokens remain in page memory, scoped to the retained task version and draft choice.
 * @param {{invokeWorkbenchApi:(method:'GET'|'POST',path:string,body?:Record<string,unknown>)=>Promise<unknown>,changed?:(context:ContinuationContext)=>void}} deps */
export function createContinuationPreviews(deps){
 /** @type {Map<string,ContinuationPreviewState>} */const values=new Map()
 let alive=true
 return{
  /** @param {ContinuationContext} context @returns {ContinuationPreviewState} */
  get(context){return structuredClone(values.get(continuationPreviewKey(context))??{status:'idle',continuation:null,error:''})},
  /** @param {ContinuationContext} context @param {boolean} [retry] */
  async load(context,retry=false){
   const key=continuationPreviewKey(context),previous=values.get(key)
   if(!alive||previous?.status==='loading'||(previous&&!retry))return
   values.set(key,{status:'loading',continuation:null,error:''});deps.changed?.(context)
   try{
    const result=/** @type {{continuation:Continuation}} */(await deps.invokeWorkbenchApi('POST','/v1/workbench/prepare-continuation',{id:context.taskId,execution:structuredClone(context.execution)}))
    const c=result?.continuation
    if(!c||!['new','resume','restart_required'].includes(c.mode)||(c.mode==='restart_required'&&(!/^[a-f0-9]{64}$/.test(c.restart?.token??'')||typeof c.restart?.context!=='string')))throw Error('invalid_preview')
    if(!alive)return
    values.set(key,{status:'ready',continuation:structuredClone(c),error:''})
   }catch{if(!alive)return;values.set(key,{status:'error',continuation:null,error:'暂时无法读取恢复说明；请重新读取后再继续。'})}
   if(alive)deps.changed?.(context)
  },
  destroy(){alive=false},
 }
}

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
 })
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

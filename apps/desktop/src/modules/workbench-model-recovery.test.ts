// @vitest-environment happy-dom
import {afterEach,expect,it,vi} from 'vitest'
import {initWorkbenchPage,stopWorkbenchPolling,renderWorkbench,renderMessageFor,workbenchMessageContext} from './workbench.js'
const task={id:'deadbeef',title:'一件事',path:'/project',providerId:'codex',status:'failed',createdAt:1,updatedAt:1,error:'execution_model_unsupported'}
const raw='{"error":"<script>bad()</script> **原始错误**"}'
const event={id:'1',taskId:task.id,kind:'error' as const,text:'当前账号不支持所用模型。',createdAt:1,errorCode:'execution_model_unsupported' as const,diagnostic:raw}
const detail={task,version:1,events:[event],permissions:[],artifacts:[],execution:{defaults:'native' as const,model:null,reasoningEffort:null}}
const state={tasks:[task],providers:[{id:'codex',displayName:'Codex'}],defaultProvider:'codex',canWechat:false,selectedId:task.id,detail,selectedArtifactId:null,error:'',preview:null}
let cleanup=()=>{}
afterEach(()=>{cleanup();cleanup=()=>{};document.body.innerHTML='';sessionStorage.clear();vi.restoreAllMocks()})
it('offers task-scoped model recovery and keeps exact diagnostics collapsed and inert',()=>{
  document.body.innerHTML=renderWorkbench(state)
  const source=document.querySelector<HTMLDetailsElement>('.wb-error-diagnostic')!
  expect(source.open).toBe(false);expect(source.querySelector('code')!.textContent).toBe(raw)
  expect(source.querySelector('script,strong,a')).toBeNull()
  expect(document.querySelector('[data-action="choose-task-model"]')?.textContent).toBe('为这件事选择模型')
  expect(document.querySelector('.wb-error')?.textContent).toBe('为这件事选择模型')
  expect(renderMessageFor(workbenchMessageContext(state))({...event,kind:'text'})).not.toContain('wb-error-diagnostic')
})
it('opens real model controls and only reads the native catalog, without resending or changing defaults',async()=>{
  document.body.innerHTML='<div id="workbench-root"></div>'
  const invoke=vi.fn(async(method:string,path:string)=>{
    if(path.startsWith('/v1/matters?'))return{matters:[]}
    if(path.startsWith('/v1/workbench/task?'))return detail
    if(path.startsWith('/v1/workbench/review?'))return{reviews:[]}
    if(path.startsWith('/v1/workbench/models?'))return{catalog:{source:'native',models:[{id:'available-model',displayName:'Available model',reasoningEfforts:['low']}]}}
    if(path==='/v1/workbench/projects')return{projects:[]}
    if(path.startsWith('/v1/workbench'))return{...state,projects:[]}
    throw Error(path)
  })
  initWorkbenchPage({invokeWorkbenchApi:invoke,pollMs:60000})
  cleanup=()=>stopWorkbenchPolling()
  await expect.poll(()=>document.querySelector('[data-action="choose-task-model"]')).not.toBeNull()
  const draft=document.querySelector<HTMLTextAreaElement>('#wb-followup-text')!
  draft.value='保留新草稿';draft.dispatchEvent(new Event('input',{bubbles:true}))
  document.querySelector<HTMLButtonElement>('[data-action="choose-task-model"]')!.click()
  await expect.poll(()=>document.querySelector('#wb-model option[value="available-model"]')).not.toBeNull()
  expect(document.querySelector<HTMLDetailsElement>('#wb-task-info')!.open).toBe(true)
  expect(document.querySelector<HTMLTextAreaElement>('#wb-followup-text')!.value).toBe('保留新草稿')
  expect(invoke.mock.calls.every(([method])=>method==='GET')).toBe(true)
})

// @vitest-environment happy-dom
import {afterEach,describe,expect,it,vi} from 'vitest'
import {renderWorkbench} from './workbench.js'
const task={id:'A',title:'准备交付',path:'/work/project',providerId:'codex',status:'running',createdAt:1,updatedAt:2,error:null}
const artifact={id:'saved',taskId:'A',name:'report.json',mime:'application/json',size:20,sha256:'a',createdAt:1,approvedAt:null}
const review={artifactId:'snapshot',name:'changes.json',sha256:'b',createdAt:1,status:'complete',headBefore:null,headAfter:null,preexistingPaths:[],notes:[],files:[]}
const page=(extra={},detail={},reviews=[])=>({tasks:[],providers:[],selectedId:'A',selectedArtifactId:'saved',preview:null,error:'',canWechat:true,detail:{task:{...task,...extra},events:[{id:1,taskId:'A',kind:'text',text:'真实的答复',createdAt:1}],artifacts:[artifact],...detail},reviews})
const render=state=>{document.body.innerHTML=renderWorkbench(state);return document.body}
afterEach(()=>{document.body.innerHTML=''})
describe('task detail follows authoritative current state',()=>{
 it.each([
  ['running',{}, {},'progress',false],
  ['idle is not answered',{}, {runtime:{retained:true,foreground:'idle',backgroundCount:0}},'progress',false],
  ['answered',{phase:'replied'}, {},'outcome',true],
  ['completed',{status:'completed'}, {},'outcome',true],
  ['paused',{phase:'replied',networkSuspended:{since:1}}, {},'progress',false],
  ['failed',{status:'failed'}, {},'progress',false],
  ['stopped',{status:'cancelled'}, {},'progress',false],
  ['interrupted',{status:'interrupted'}, {},'progress',false],
  ['imported',{status:'completed',importedOnly:true}, {},'progress',false],
  ['queued',{status:'queued'}, {},'progress',false],
  ['unknown',{status:'mystery'}, {},'progress',false],
 ])('%s does not infer completion from old files',(_name,extra,detail,focus,open)=>{
  const root=render(page(extra,detail))
  expect(root.querySelector('.wb-content-inner').dataset.taskFocus).toBe(focus)
  expect(root.querySelector('#wb-artifacts').open).toBe(open)
  expect(root.querySelectorAll('iframe,.cc-pdf-reader')).toHaveLength(0)
 })
 it('keeps only current-task requests ahead of the composer, even with saved outcomes',()=>{
  const permission={id:'p',taskId:'A',tool:'Bash',description:'rm output\ncwd: /work/project\nonly this request',createdAt:1}
  const question={id:'q',taskId:'A',createdAt:1,questions:[{id:'choice',header:'选择',question:'保留哪一份？',options:[]}]}
  const root=render(page({phase:'replied'},{permissions:[permission,{...permission,id:'foreign',taskId:'B'}],questions:[question,{...question,id:'foreign-q',taskId:'B'}]}))
  expect(root.querySelector('.wb-content-inner').dataset.taskFocus).toBe('decision')
  expect(root.querySelector('#wb-artifacts').open).toBe(false)
  expect(root.querySelectorAll('[data-request-id="foreign"]')).toHaveLength(0)
  expect(root.querySelector('.wb-permission p').textContent).toBe(permission.description)
  expect(root.querySelector('.wb-controls-inner').firstElementChild.className).toBe('wb-permissions')
  expect(root.querySelectorAll('.wb-question-form')).toHaveLength(1)
 })
 it('promotes saved JSON output but keeps known review-only artifacts review-first',()=>{
  expect(render(page({status:'completed'})).querySelector('#wb-artifacts').classList.contains('is-outcome')).toBe(true)
  const root=render(page({status:'completed'},{artifacts:[{...artifact,id:'snapshot'}]},[review]))
  expect(root.querySelector('#wb-artifacts').classList.contains('is-outcome')).toBe(false)
  expect(root.querySelector('#wb-artifacts').open).toBe(false)
  const mixed=render(page({status:'completed'},{artifacts:[{...artifact,id:'snapshot'},artifact]},[review]))
  expect(mixed.querySelector('#wb-artifacts .wb-artifact').dataset.artifactId).toBe('saved')
 })
 it('keeps a file-free answer as the content and archived tasks read-only',()=>{
  const root=render(page({status:'completed',archivedAt:2},{artifacts:[]}))
  expect(root.querySelector('.wb-dialogue').textContent).toContain('真实的答复')
  expect(root.querySelector('#wb-artifacts')).toBeNull()
  expect(root.querySelector('.wb-followup')).toBeNull()
  expect(root.querySelector('.wb-archived-controls')).not.toBeNull()
 })
 it('moves execution identity and branch management into task info but keeps script facts visible',()=>{
  const scripts={configured:true,approved:false,hash:'hash',config:{setup:'setup',run:'serve',archive:null},setup:'failed',run:'idle',archiving:false}
  const root=render(page({agents:['codex'],origin:'desktop',worktree:{branch:'codex/task',projectPath:'/work/project',removed:false,scripts}}))
  expect(root.querySelector('.wb-task-agents').closest('#wb-task-info')).not.toBeNull()
  expect(root.querySelector('[data-action="worktree-commit"]').closest('#wb-task-info')).not.toBeNull()
  expect(root.querySelector('[data-scripts-status]').closest('#wb-task-info')).toBeNull()
  expect(root.querySelector('[data-scripts-status]').textContent).toContain('待确认')
  expect(root.querySelector('[data-scripts-status]').textContent).toContain('setup 没跑成功')
 })
 it.each(['steer','send','queue'])('offers optional delivery help for %s without changing ownership',inputMode=>{
  const root=render(page({}, {runId:'run-A',inputMode}))
  const form=root.querySelector('.wb-followup')
  expect(form.dataset.ownerTask).toBe('A');expect(form.dataset.runId).toBe('run-A')
  expect(root.querySelector('#wb-input-help').open).toBe(false)
  expect(root.querySelector('#wb-input-help').textContent).toContain(inputMode==='steer'?'当前一轮':inputMode==='send'?'同一会话':'本轮正常结束后')
 })
 it('keeps remaining background work explicit after the foreground has replied',()=>{
  const root=render(page({phase:'replied'},{runId:'run-A',inputMode:'send',runtime:{retained:true,foreground:'idle',backgroundCount:2}}))
  expect(root.querySelector('.wb-runtime-note').textContent).toContain('后台仍有 2 项工作')
  expect(root.querySelector('.wb-runtime-note').closest('details')).toBeNull()
 })
 it('retained queue keeps save-only and termination consequences outside optional help',()=>{
  const root=render(page({phase:'replied'},{runId:'run-A',inputMode:'queue',runtime:{retained:true,foreground:'idle',backgroundCount:0}}))
  const warning=root.querySelector('#wb-followup-timing')
  expect(warning.closest('details')).toBeNull()
  expect(warning.textContent).toContain('不会自动发送')
  expect(root.querySelector('.wb-runtime-note').textContent).toContain('结束会停止尚未结束的后台工作')
  expect(root.querySelector('.wb-followup [type="submit"]').textContent).toContain('保存补充')
 })
})

describe('review provenance arrives independently of task detail',()=>{
 it('does not promote snapshots before review IDs arrive or let a late A response classify B',async()=>{
  const {initWorkbenchPage,stopWorkbenchPolling}=await import('./workbench.js')
  document.body.innerHTML='<div id="workbench-root"></div>'
  const a={...task,status:'completed'},b={...a,id:'B',title:'另一项成果'}
  const releases={}
  const invokeWorkbenchApi=async(_method,path)=>{
   const id=new URL(path,'http://fixture.test').searchParams.get('id')
   if(path.startsWith('/v1/workbench/task?'))return{task:id==='A'?a:b,events:[],artifacts:[{...artifact,id:id==='A'?'snapshot':'saved'}]}
   if(path.startsWith('/v1/workbench/review?'))return new Promise(resolve=>{releases[id]=resolve})
   if(path.startsWith('/v1/matters?'))return{matters:[]}
   return{tasks:[a,b],providers:[],defaultProvider:'codex',canWechat:false}
  }
  const controller=initWorkbenchPage({invokeWorkbenchApi,pollMs:60000})
  try{
   await vi.waitFor(()=>expect(releases.A).toBeTypeOf('function'))
   expect(document.querySelector('#wb-artifacts').open).toBe(false)
   expect(controller.state.reviewsLoaded).toBe(false)
   await controller.selectTask('B')
   expect(controller.state.reviewsLoaded).toBe(false)
   releases.A({reviews:[review]})
   await Promise.resolve();await Promise.resolve()
   expect(controller.state.reviewsLoaded).toBe(false)
   expect(document.querySelector('#wb-artifacts').open).toBe(false)
   releases.B({reviews:[]})
   await vi.waitFor(()=>expect(controller.state.reviewsLoaded).toBe(true))
   expect(document.querySelector('#wb-artifacts').open).toBe(true)
   await controller.selectTask('A')
   expect(document.querySelector('#wb-artifacts').open).toBe(false)
   releases.A({reviews:[review]})
   await vi.waitFor(()=>expect(controller.state.reviewsLoaded).toBe(true))
   expect(document.querySelector('#wb-artifacts').open).toBe(false)
   expect(document.querySelector('#wb-review')).not.toBeNull()
  }finally{stopWorkbenchPolling();sessionStorage.clear()}
 })
})

describe('review discovery failures keep outcomes accessible without guessing provenance',()=>{
 it.each(['unavailable','unsupported'])('%s keeps the error and saved artifact path',async kind=>{
  const {initWorkbenchPage,stopWorkbenchPolling}=await import('./workbench.js')
  document.body.innerHTML='<div id="workbench-root"></div>'
  const finished={...task,status:'completed'}
  const controller=initWorkbenchPage({pollMs:60000,invokeWorkbenchApi:async(_method,path)=>{
   if(path.startsWith('/v1/workbench/task?'))return{task:finished,events:[],artifacts:[artifact]}
   if(path.startsWith('/v1/workbench/review?')){if(kind==='unavailable')throw Error('unavailable');return{}}
   if(path.startsWith('/v1/matters?'))return{matters:[]}
   return{tasks:[finished],providers:[],defaultProvider:'codex',canWechat:false}
  }})
  try{
   await vi.waitFor(()=>expect(controller.state.detail?.task.id).toBe('A'))
   if(kind==='unavailable')await vi.waitFor(()=>expect(controller.state.reviewsError).toBe(true))
   expect(controller.state.reviewsLoaded).toBe(false)
   expect(document.querySelector('#wb-artifacts').classList.contains('is-outcome')).toBe(false)
   expect(document.querySelector('[data-action="show-artifacts"]')).not.toBeNull()
   if(kind==='unavailable')expect(document.querySelector('#wb-review')).not.toBeNull()
  }finally{stopWorkbenchPolling();sessionStorage.clear()}
 })
})

describe('review provenance belongs to the current artifact generation',()=>{
 it('waits for matching review IDs when a later live turn adds a snapshot',async()=>{
  const {initWorkbenchPage,stopWorkbenchPolling}=await import('./workbench.js')
  document.body.innerHTML='<div id="workbench-root"></div>'
  const finished={...task,status:'completed'}
  let push,finishReviews,reviewCalls=0
  const initial={task:finished,version:1,events:[],artifacts:[{...artifact,id:'snapshot'}]}
  const controller=initWorkbenchPage({pollMs:60000,invokeWorkbenchApi:async(_method,path)=>{
   if(path.startsWith('/v1/workbench/task?'))return path.includes('since=')?new Promise(resolve=>{push=resolve}):initial
   if(path.startsWith('/v1/workbench/review?'))return ++reviewCalls===1?{reviews:[review]}:new Promise(resolve=>{finishReviews=resolve})
   if(path.startsWith('/v1/matters?'))return{matters:[]}
   return{tasks:[finished],providers:[],defaultProvider:'codex',canWechat:false}
  }})
  try{
   await vi.waitFor(()=>{expect(controller.state.reviewsLoaded).toBe(true);expect(push).toBeTypeOf('function')})
   push({...initial,version:2,artifacts:[...initial.artifacts,{...artifact,id:'next-snapshot'}]})
   await vi.waitFor(()=>expect(finishReviews).toBeTypeOf('function'))
   expect(controller.state.reviewsLoaded).toBe(false)
   expect(document.querySelector('#wb-artifacts').classList.contains('is-outcome')).toBe(false)
   expect(document.querySelector('#wb-artifacts').open).toBe(false)
   finishReviews({reviews:[review,{...review,artifactId:'next-snapshot'}]})
   await vi.waitFor(()=>expect(controller.state.reviewsLoaded).toBe(true))
   expect(document.querySelector('#wb-artifacts').classList.contains('is-outcome')).toBe(false)
  }finally{stopWorkbenchPolling();sessionStorage.clear()}
 })
})

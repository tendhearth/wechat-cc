// @vitest-environment happy-dom
import {afterEach,describe,expect,it,vi} from 'vitest'
import {renderWorkbench} from './workbench.js'
import {mergeEvents} from './workbench-live.js'
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
  expect(root.querySelector('.wb-task-progress .now-row-status').dataset.tone).toBe('accent')
  expect(root.querySelector('.wb-task-progress .wb-status').textContent).toBe('等你决定')
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
   if(path.startsWith('/v1/matter/changes?'))return new Promise(resolve=>{releases[id]=resolve})
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
   if(path.startsWith('/v1/matter/changes?')){if(kind==='unavailable')throw Error('unavailable');return{}}
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
   if(path.startsWith('/v1/matter/changes?'))return ++reviewCalls===1?{reviews:[review]}:new Promise(resolve=>{finishReviews=resolve})
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

describe('11-08 request and result hierarchy',()=>{
 it('puts the current concrete request before outcomes, with earlier answers behind a closed disclosure',()=>{
  const events=[{id:'old-user',taskId:'A',kind:'user',text:'旧请求',createdAt:1},{id:'old-answer',taskId:'A',kind:'text',text:'旧答复',createdAt:2},{id:'new-user',taskId:'A',kind:'user',text:'新请求',createdAt:3},{id:'new-answer',taskId:'A',kind:'text',text:'新答复',createdAt:4}]
  const root=render(page({status:'completed'},{events}))
  expect(root.querySelector('.wb-request').textContent).toContain('新请求')
  expect(root.querySelector('.wb-dialogue').textContent).toContain('新答复')
  expect(root.querySelector('.wb-dialogue').textContent).not.toContain('旧答复')
  expect(root.querySelector('#wb-earlier-dialogue').open).toBe(false)
  expect(root.querySelector('#wb-earlier-dialogue').textContent).toContain('旧答复')
  expect(root.querySelectorAll('[data-kind="user"]')).toHaveLength(2)
  const html=root.innerHTML
  expect(html.indexOf('class="wb-request"')).toBeLessThan(html.indexOf('id="wb-artifacts"'))
 })
 it.each([['failed','没做成'],['done','完成'],['completed','完成']])('uses shared words for phase %s even when the task status is running',(phase,word)=>{
  const root=render(page({phase},{artifacts:[]}))
  expect(root.querySelector('.wb-task-progress .wb-status').textContent).toBe(word)
 })
})

describe('steer acknowledgements preserve the active native answer',()=>{
 it.each([['running','working'],['running','replied'],['completed','completed']])('%s/%s keeps append → steer → same-item replace visible',(status,phase)=>{
  let events=[{id:1,taskId:'A',kind:'user',text:'原请求',runId:'r',turnId:'turn',createdAt:1}]
  events=mergeEvents(events,[{id:2,taskId:'A',kind:'text',text:'开始核对',runId:'r',turnId:'turn',createdAt:2}])
  expect(render(page({phase:'working'},{runId:'r',events})).querySelector('.wb-dialogue').textContent).toContain('开始核对')
  events=mergeEvents(events,[{id:3,taskId:'A',kind:'user',text:'补充：也检查附件',runId:'r',turnId:'turn',createdAt:3}])
  expect(render(page({phase:'working'},{runId:'r',events})).querySelector('.wb-dialogue').textContent).toContain('开始核对')
  events=mergeEvents(events,[{id:2,taskId:'A',kind:'text',text:'最终核对结果含附件',runId:'r',turnId:'turn',createdAt:2}])
  const root=render(page({status,phase},{runId:'r',events}))
  expect(root.querySelector('.wb-request').textContent).toContain('补充：也检查附件')
  expect(root.querySelector('.wb-dialogue').textContent).toContain('最终核对结果含附件')
  expect(root.querySelector('#wb-earlier-dialogue')?.textContent??'').not.toContain('最终核对结果含附件')
  expect(root.querySelector('.wb-dialogue').textContent).not.toContain('正在处理')
 })
 it('folds a previous turn even when a retained session uses the same run',()=>{
  const event=(id,kind,text,turnId)=>({id,kind,text,turnId,runId:'r',taskId:'A',createdAt:id})
  const root=render(page({phase:'working'},{runId:'r',events:[event(1,'user','旧请求','old'),event(2,'text','旧答复','old'),event(3,'user','新请求','new'),event(4,'text','新答复','new'),event(5,'user','同轮补充','new')]}))
  expect(root.querySelector('.wb-dialogue').textContent).toContain('新答复')
  expect(root.querySelector('.wb-dialogue').textContent).not.toContain('旧答复')
  expect(root.querySelector('#wb-earlier-dialogue').textContent).toContain('旧答复')
  expect(root.querySelector('#wb-earlier-dialogue').open).toBe(false)
 })
 it('keeps a same-run streaming answer visible for older payloads without turn ids',()=>{
  const events=[{id:1,taskId:'A',kind:'user',text:'原请求',runId:'r',createdAt:1},{id:2,taskId:'A',kind:'text',text:'仍在输出',runId:'r',createdAt:2},{id:3,taskId:'A',kind:'user',text:'中途补充',runId:'r',createdAt:3}]
  expect(render(page({phase:'replied'},{runId:'r',events})).querySelector('.wb-dialogue').textContent).toContain('仍在输出')
 })
 it('does not claim to be processing after replied with no reply event',()=>{
  const events=[{id:1,taskId:'A',kind:'user',text:'要求',createdAt:1}]
  expect(render(page({phase:'replied'},{events})).querySelector('.wb-dialogue').textContent).not.toContain('正在处理')
 })
})

it('a retained next-turn acknowledgement before text folds the old turn and later joins the new reply',()=>{
 const old=[{id:1,taskId:'A',kind:'user',text:'旧请求',runId:'r',turnId:'old',createdAt:1},{id:2,taskId:'A',kind:'text',text:'旧答复',runId:'r',turnId:'old',createdAt:2}]
 const request={id:3,taskId:'A',kind:'user',text:'新请求',runId:'r',createdAt:3}
 const pending=render(page({phase:'working'},{runId:'r',events:[...old,request]}))
 expect(pending.querySelector('.wb-dialogue').textContent).not.toContain('旧答复')
 const next={id:4,taskId:'A',kind:'text',text:'新答复',runId:'r',turnId:'new',createdAt:4}
 expect(render(page({phase:'replied'},{runId:'r',events:[...old,request,next]})).querySelector('.wb-dialogue').textContent).toContain('新答复')
})

it('task details show the recorded starting branch/SHA and escape the branch text',()=>{
  const root=render(page({worktree:{branch:'cc/task',base:'dev<script>',baseSha:'abcdef0123456789',projectPath:'/work/project',removed:false}}))
  expect(root.querySelector('#wb-task-info').textContent).toContain('从 dev<script> @ abcdef0 开始')
  expect(root.querySelector('#wb-task-info script')).toBeNull()
})

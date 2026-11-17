// @vitest-environment happy-dom
import {afterEach,expect,it,vi} from 'vitest'
import {createRosterDock} from './roster-dock.js'
let dock:ReturnType<typeof createRosterDock>|undefined
afterEach(()=>{dock?.destroy();vi.useRealTimers();document.body.innerHTML=''})
function setup(call:any=async()=>({matter:{id:'old',kind:'task'}}),wide=()=>true){
 document.body.innerHTML='<main><article id="overview"></article><section id="layer" hidden><form><textarea id="wb-followup-text"></textarea></form></section></main><aside><div id="roster-list"></div><div id="roster-dock" hidden></div></aside>'
 const layer=document.getElementById('layer')!,aside=document.querySelector('aside')!,openTask=vi.fn(async()=>{}),expand=vi.fn(async()=>{})
 dock=createRosterDock({aside,layer,call,openTask,wide,onExpand:expand})
 return {layer,aside,openTask,expand}
}
it('宽窗口打开名单之外的旧事时移动唯一层并保留左侧对话',async()=>{
 const {layer,aside,openTask}=setup()
 await dock!.open({kind:'matter',id:'old'})
 expect(layer.parentElement?.id).toBe('roster-dock');expect(layer.hidden).toBe(false)
 expect(document.getElementById('overview')?.hidden).toBe(false)
 expect(aside.dataset.docked).toBe('1');expect(openTask).toHaveBeenCalledWith('old')
 dock!.close();expect(layer.parentElement?.tagName).toBe('MAIN');expect(layer.hidden).toBe(true)
 expect(aside.dataset.docked).toBeUndefined()
})
it('宽变窄展开同一件事并保留补充框草稿',async()=>{
 let wide=true;const {expand}=setup(undefined,()=>wide)
 await dock!.open({kind:'matter',id:'old'})
 ;(document.getElementById('wb-followup-text') as HTMLTextAreaElement).value='草稿'
 wide=false;window.dispatchEvent(new Event('resize'));await Promise.resolve()
 expect(expand).toHaveBeenCalledWith({kind:'matter',id:'old'})
 expect((document.getElementById('wb-followup-text') as HTMLTextAreaElement).value).toBe('草稿')
 expect(dock!.current()).toBeNull()
})
it('归档后的 404 返回名单并说明原因',async()=>{
 vi.useFakeTimers();let missing=false
 setup(async()=>{if(missing)throw Error('404');return {matter:{id:'old',kind:'task'}}})
 await dock!.open({kind:'matter',id:'old'});missing=true
 await vi.advanceTimersByTimeAsync(3000)
 expect(dock!.current()).toBeNull();expect(document.body.textContent).toContain('这件事已经不在了')
})
it('窄窗口直接用原来的全屏入口',async()=>{
 const {expand,openTask}=setup(undefined,()=>false)
 await dock!.open({kind:'matter',id:'old'})
 expect(expand).toHaveBeenCalledWith({kind:'matter',id:'old'});expect(openTask).not.toHaveBeenCalled()
})
it('终端直通挂入容器，关闭后停止轮询',async()=>{
 vi.useFakeTimers()
 const call=vi.fn(async(_method:string,path:string)=>path.includes('/sessions')?{sessions:[{session_id:'s',status:'idle',last_summary:'原话'}]}:{items:[]})
 setup(call)
 await dock!.open({kind:'terminal',id:'s'})
 expect(document.querySelector('dialog')).toBeNull();expect(document.getElementById('roster-dock')?.textContent).toContain('原话')
 dock!.close();const count=call.mock.calls.length;await vi.advanceTimersByTimeAsync(6000);expect(call).toHaveBeenCalledTimes(count)
})
it('迟到的旧事详情不能盖住新事',async()=>{
 let release:any
 setup(async(_m:string,path:string)=>path.endsWith('old')?await new Promise(r=>{release=r}):{matter:{id:'new',kind:'task'}})
 const first=dock!.open({kind:'matter',id:'old'});await dock!.open({kind:'matter',id:'new'})
 release({matter:{id:'old',kind:'task'}});await first
 expect(dock!.current()).toBe('new')
})
it('两个输入框同屏时，CC 回车与直通 submit 各走自己的发送口',async()=>{
 vi.useFakeTimers()
 const wb=await import('./workbench.js'),cc=await import('./converse.js')
 const task={id:'deadbeef',title:'备份',path:'/tmp/project',providerId:'codex',status:'running',createdAt:1,updatedAt:2}
 const writes:any[]=[]
 const api=async(method:string,path:string,body?:any)=>{
  if(method==='POST'){writes.push([path,body]);return path.endsWith('/input')?{input:{...body,id:body.requestId,status:'pending',createdAt:3}}:{}}
  if(path.startsWith('/v1/matter?'))return {matter:{id:task.id,kind:'task'}}
  if(path.startsWith('/v1/workbench/task'))return {task,events:[],artifacts:[],runId:'run',inputMode:'steer'}
  return {tasks:[task],projects:[],providers:[{id:'codex',displayName:'Codex'}],defaultProvider:'codex'}
 }
 setup(api)
 const layer=document.getElementById('layer')!;layer.className='workbench-pane';layer.innerHTML='<div id="workbench-root"></div>'
 document.getElementById('overview')!.innerHTML='<div id="converse-root"></div>'
 const invoke=vi.fn(async(_cmd:string,_args?:any)=> 'CC 的回复')
 cc.initConversePage({invoke})
 wb.initWorkbenchPage({invokeWorkbenchApi:api,pollMs:60000})
 // Use the production workbench opener after the layer moves.
 dock!.destroy()
 dock=createRosterDock({aside:document.querySelector('aside')!,layer,call:api,wide:()=>true,openTask:wb.openWorkbenchTask})
 try{
  await dock.open({kind:'matter',id:task.id})
  const input=document.getElementById('converse-input') as HTMLTextAreaElement
  input.value='只给 CC';input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))
  for(let i=0;i<20;i++)await Promise.resolve()
  expect(invoke).toHaveBeenCalledWith('agent_converse',{text:'只给 CC'})
  expect(writes.filter(([path])=>path.endsWith('/input'))).toHaveLength(0)
  const followup=document.getElementById('wb-followup-text') as HTMLTextAreaElement
  followup.value='只给 Codex';followup.dispatchEvent(new Event('input',{bubbles:true}))
  followup.closest('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))
  for(let i=0;i<30;i++)await Promise.resolve()
  expect(writes.find(([path])=>path.endsWith('/input'))?.[1]).toMatchObject({id:task.id,text:'只给 Codex',runId:'run'})
  expect(invoke.mock.calls.filter(c=>c[0]==='agent_converse')).toHaveLength(1)
  document.dispatchEvent(new KeyboardEvent('keydown',{key:'1',metaKey:true,bubbles:true}));expect(document.activeElement?.id).toBe('converse-input')
  document.dispatchEvent(new KeyboardEvent('keydown',{key:'2',metaKey:true,bubbles:true}));expect(document.activeElement?.id).toBe('wb-followup-text')
 }finally{wb.stopWorkbenchPolling()}
})

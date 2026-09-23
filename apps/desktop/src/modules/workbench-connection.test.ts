import {expect,it,vi} from 'vitest'
import {createWorkbenchController,renderWorkbench} from './workbench.js'

it('keeps task reconnect status through healthy list refreshes and clears it on an unchanged detail response',async()=>{
 vi.useFakeTimers()
 const task={id:'deadbeef',title:'Project A',path:'/A',providerId:'codex',status:'running',createdAt:1,updatedAt:1,error:null}
 const detail={task,version:4,events:[{id:1,kind:'text',text:'Saved reply',createdAt:1}],permissions:[],artifacts:[]}
 let failed=true
 const render=vi.fn()
 const api=async(_method:string,path:string)=>{
  if(path.includes('/task?')){if(path.includes('since=')){if(failed)throw Error('offline');return {...detail,events:[]}}return detail}
  if(path.startsWith('/v1/workbench/review'))return {reviews:[]}
  return {tasks:[task],providers:[{id:'codex',displayName:'Codex'}],defaultProvider:'codex',canWechat:false}
 }
 const controller=createWorkbenchController({invokeWorkbenchApi:api,render})
 try{
  await controller.refresh();await vi.advanceTimersByTimeAsync(0)
  expect(renderWorkbench(controller.state)).toContain('正在重新连接')
  await controller.refresh()
  expect(renderWorkbench(controller.state)).toContain('正在重新连接')
  expect(controller.state.detail?.events[0]?.text).toBe('Saved reply')
  failed=false
  await vi.advanceTimersByTimeAsync(1000)
  expect(renderWorkbench(controller.state)).not.toContain('正在重新连接')
  expect(controller.state.detail?.events[0]?.text).toBe('Saved reply')
  expect(render).toHaveBeenCalled()
 }finally{controller.destroy();vi.useRealTimers()}
})

it('uses the replied phase in the task header as well as the task list',()=>{
 const task={id:'deadbeef',title:'A',path:'/A',providerId:'codex',status:'completed',phase:'replied',createdAt:1,updatedAt:1,error:null}
 const html=renderWorkbench({tasks:[task],providers:[{id:'codex',displayName:'Codex'}],defaultProvider:'codex',canWechat:false,selectedId:task.id,detail:{task,events:[],permissions:[],artifacts:[]},selectedArtifactId:null,error:'',preview:null})
 const header=html.slice(html.indexOf('<header class="wb-task-head">'),html.indexOf('<div class="wb-content">'))
 expect(header).toContain('已答复')
 expect(header).not.toContain('已完成')
})

import { expect, it, vi } from 'vitest'
import { Window } from 'happy-dom'
import { initWorkbenchPage, stopWorkbenchPolling } from './workbench.js'

it('preserves a capable card reason and caret through a real DOM redraw, then submits that exact rejection once',async()=>{
  const win=new Window({url:'http://localhost/'}),doc=win.document
  doc.body.innerHTML='<main id="workbench-root"></main>'
  for(const name of ['window','document','Element','HTMLElement','HTMLInputElement','HTMLTextAreaElement','HTMLSelectElement'] as const)vi.stubGlobal(name,name==='window'?win:name==='document'?doc:win[name])
  const task={id:'deadbeef',title:'Task',path:'/work',providerId:'codex',status:'running',createdAt:1,updatedAt:2,error:null}
  const permission={id:'request',taskId:task.id,tool:'Bash',description:'ssh other-host',createdAt:1,canDenyWithReason:true}
  const detail={task,events:[] as any[],artifacts:[],permissions:[permission]},posts:any[]=[]
  const api=async(method:string,path:string,body?:any)=>{
    if(method==='POST'&&path==='/v1/matter/permission'){posts.push(body);return {ok:true}}
    if(path.startsWith('/v1/workbench/task?'))return structuredClone(detail)
    if(path.startsWith('/v1/workbench/review?'))return {turns:[]}
    return {tasks:[task],providers:[],projects:[],defaultProvider:'codex',canWechat:false}
  }
  try{
    const controller=initWorkbenchPage({invokeWorkbenchApi:api,pollMs:60000})!
    await controller.refresh()
    controller.state.selectedId=task.id;controller.state.detail=structuredClone(detail);controller.paint(true)
    const field=doc.querySelector('[data-denial-reason]') as any
    expect(field).not.toBeNull()
    field.value='  只在本机验证，不要 SSH  ';field.focus();field.setSelectionRange(3,7)
    field.dispatchEvent(new win.Event('input',{bubbles:true}))
    controller.state.detail!.events.push({id:'progress',taskId:task.id,kind:'system',text:'progress',createdAt:2})
    controller.paint(true)
    const redrawn=doc.querySelector('[data-denial-reason]') as any
    expect(redrawn.value).toBe(field.value)
    expect(doc.activeElement).toBe(redrawn)
    expect([redrawn.selectionStart,redrawn.selectionEnd]).toEqual([3,7])
    ;(doc.querySelector('[data-action="deny-permission"]') as any).click()
    await expect.poll(()=>posts).toHaveLength(1)
    expect(posts[0]).toEqual({id:task.id,requestId:permission.id,decision:'deny',reason:'只在本机验证，不要 SSH'})
    controller.state.detail={...structuredClone(detail),permissions:[{...permission,canDenyWithReason:false}]}
    controller.paint(true)
    expect(doc.querySelector('[data-denial-reason]')).toBeNull()
  }finally{stopWorkbenchPolling();await win.happyDOM.abort();vi.unstubAllGlobals()}
})

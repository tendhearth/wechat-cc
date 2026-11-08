// @vitest-environment happy-dom
import {afterEach,expect,it,vi} from 'vitest'
import {openConversationWork} from './conversation-work-detail.js'
afterEach(()=>{for(const dialog of document.querySelectorAll('dialog'))dialog.dispatchEvent(new Event('close'));document.body.innerHTML=''})
it('terminal and act matter ids never enter task APIs; only task dispatches to the workbench',async()=>{
  const openTask=vi.fn(),call=vi.fn(async(_m:string,path:string)=>{
    if(path.startsWith('/v1/matter?'))return {matter:{id:'terminal-id',kind:'terminal',title:'Terminal'},bindings:[{surface:'cli',surfaceKey:'session-real'}]}
    if(path.startsWith('/v1/cli/sessions'))return {sessions:[{session_id:'session-real',status:'running',stale:false,run_id:'run-real',last_summary:'running'}]}
    if(path.startsWith('/v1/cli/activity'))return {items:[{text:'真实进展'}]}
    if(path.endsWith('/session-stop'))return {ok:true}
    throw Error(path)
  })
  await openConversationWork(call,'terminal-id',openTask)
  expect(openTask).not.toHaveBeenCalled();expect(document.querySelector('dialog')?.textContent).toContain('真实进展')
  const stop=[...document.querySelectorAll('button')].find(b=>b.textContent==='停止这一轮')!
  stop.click();expect(call.mock.calls.some(c=>c[1].endsWith('/session-stop'))).toBe(false)
  stop.click();await expect.poll(()=>call.mock.calls.some(c=>c[1].endsWith('/session-stop'))).toBe(true)
  expect(call.mock.calls.find(c=>c[1].endsWith('/session-stop'))).toEqual(['POST','/v1/cli/session-stop',{session_id:'session-real',run_id:'run-real',confirmed:true}])
  await openConversationWork(async()=>({matter:{id:'act-id',kind:'act',title:'Consultation'},actTurns:[{steps:[{payload:{text:'consulted'}}]}]}),'act-id',openTask)
  expect(openTask).not.toHaveBeenCalled();expect(document.body.textContent).toContain('consulted')
  await openConversationWork(async()=>({matter:{id:'task-id',kind:'task'}}),'task-id',openTask)
  expect(openTask).toHaveBeenCalledWith('task-id')
})

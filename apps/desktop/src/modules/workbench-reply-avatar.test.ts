// @vitest-environment happy-dom
import {afterEach,expect,it,vi} from 'vitest'
import {createWorkbenchController,renderMessageFor,workbenchMessageContext} from './workbench.js'
import {updateReplyAvatarNames} from './reply-avatar.js'
afterEach(()=>{document.body.innerHTML=''})
const event=(id:string,kind:import('./workbench.js').WorkbenchEvent['kind'],meta:Record<string,unknown>={})=>({id,taskId:'work',kind,text:id,createdAt:1,...meta})
function render(provider='codex'){
  const events=[event('first','text',{speaker:'agent',provider:'claude'}),event('second','text',{speaker:'agent',provider:'codex'}),event('gateway','text',{speaker:'agent',provider:'openai',model:'claude'}),event('unknown','text',{speaker:'agent',provider:'future'}),event('cc','text',{speaker:'cc',provider:'claude'}),event('notice','system',{speaker:'notice',provider:'codex'}),event('old','text'),event('me','user',{speaker:'agent',provider:'claude'})]
  const state={tasks:[],providers:[{id:'codex',displayName:'Codex'}],defaultProvider:'codex',canWechat:false,selectedId:'work',selectedArtifactId:null,error:'',preview:null,
    replyAgentNames:{claude:'Claude',codex:'Codex',openai:'我的网关'},detail:{task:{id:'work',providerId:provider,status:'running'},events,artifacts:[]}}
  const paint=renderMessageFor(workbenchMessageContext(state as any))
  document.body.innerHTML=events.map(e=>paint(e as any)).join('')
  return {state,paint}
}
it('uses per-event avatars and names in the shared full/incremental matter renderer',()=>{
  const {paint}=render()
  for(const [id,glyph,name] of [['first','claude','Claude'],['second','codex','Codex'],['gateway','service','我的网关'],['unknown','service','future']]){
    const message=[...document.querySelectorAll('article')].find(n=>n.querySelector('.wb-message-body')?.textContent?.trim()===id)!,avatar=message.querySelector('.th-agents')!
    expect(message.querySelectorAll('.th-agent')).toHaveLength(1);expect(avatar.getAttribute('aria-label')).toBe(name);expect(avatar.getAttribute('title')).toBe(name)
    expect(avatar.querySelector('.th-agent')?.getAttribute('data-agent')).toBe(glyph)
    expect(message.querySelector('.wb-provider-badge')).toBeNull()
  }
  for(const id of ['cc','notice','old','me']){
    const message=[...document.querySelectorAll('article')].find(n=>n.querySelector('.wb-message-body')?.textContent?.trim()===id)!
    expect(message.querySelector('.th-agent')).toBeNull()
    if(id==='cc')expect(message.querySelector('header')?.textContent).toContain('CC')
  }
  expect(document.querySelector('[data-reply-provider="openai"] .th-agent-mono')?.textContent).toBe('A')
  expect(paint(event('patch','text',{speaker:'agent',provider:'claude'}) as any)).toContain('data-agent="claude"')
  render('openai')
  expect(document.querySelector('article .th-agent')?.getAttribute('data-agent')).toBe('claude')
})

it('updates late matter reply names in place without causing a later poll to repaint the text',()=>{
  const {state}=render()
  const paint=vi.fn(()=>{document.body.innerHTML=state.detail.events.map(renderMessageFor(workbenchMessageContext(state as any))).join('')})
  const controller=createWorkbenchController({invokeWorkbenchApi:async()=>({}),render:paint})
  Object.assign(controller.state,state,{replyAgentNames:{}});controller.paint()
  const message=document.querySelector('article')!,body=message.querySelector('.wb-message-body')!
  const names={claude:'Claude <迟到>'};controller.state.replyAgentNames=names
  updateReplyAvatarNames(document.body,names)
  controller.paint()
  expect(paint).toHaveBeenCalledTimes(1)
  expect(document.querySelector('article')).toBe(message);expect(message.querySelector('.wb-message-body')).toBe(body)
  expect(message.querySelector('.th-agents')?.getAttribute('aria-label')).toBe('Claude <迟到>')
  expect(message.querySelector('迟到')).toBeNull()
  controller.destroy()
})

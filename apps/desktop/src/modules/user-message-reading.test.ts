import {expect,it} from 'vitest'
import {Window} from 'happy-dom'
import {renderWorkbenchUserText,captureUserSources,restoreUserSources} from './workbench-markdown.js'
import {renderMessageFor,workbenchMessageContext} from './workbench.js'

function documentFor(html:string){const document=new Window().document;document.body.innerHTML=html;return document}

it('renders formatted user text with an exact inert source and stable source identity',()=>{
 const text='\n\n**用户原文**\r\n\r\n  空格 & <script>bad()</script>\r\n\n- 第一项\n- 第二项\n\n[链接](javascript:alert(1))\n\n![图片](https://example.test/tracker.png)'
 const html=renderWorkbenchUserText(text,'unsafe" <key>')
 const document=documentFor(html),reading=document.querySelector('.cc-user-reading')!
 expect(reading.querySelector('.cc-readable-markdown strong')?.textContent).toBe('用户原文')
 expect(reading.querySelectorAll('.cc-readable-markdown li')).toHaveLength(2)
 expect(reading.querySelectorAll('script,img,a')).toHaveLength(0)
 const source=reading.querySelector('details')!
 expect(source.open).toBe(false);source.open=true
 expect(source.querySelector('pre code')?.textContent).toBe(text)
 expect(documentFor(renderWorkbenchUserText(text,'unsafe" <key>')).querySelector('details')?.id).toBe(source.id)
 expect(documentFor(renderWorkbenchUserText(text,'different')).querySelector('details')?.id).not.toBe(source.id)
})

it('adds no source control to ordinary prose and preserves its line breaks exactly',()=>{
 const text='\n\n普通用户消息\r\n\r\n两个字 & <example>'
 const document=documentFor(renderWorkbenchUserText(text,'plain'))
 expect(document.querySelector('details')).toBeNull()
 expect(document.querySelector('.cc-user-plain')?.textContent).toBe(text)
})

it('preserves only the matching source disclosures across a render',()=>{
 const document=documentFor(renderWorkbenchUserText('**原文**','same')+renderWorkbenchUserText('*另一段*','closed'))
 const source=document.querySelector('details')!;source.open=true
 const open=captureUserSources(document.body)
 document.body.innerHTML=renderWorkbenchUserText('**原文**','same')+renderWorkbenchUserText('*另一段*','closed')+renderWorkbenchUserText('**新消息**','new')
 restoreUserSources(document.body,open)
 expect(Array.from(document.querySelectorAll('details')).map(d=>d.open)).toEqual([true,false,false])
})

it('renders original task user messages and handoff requests, leaving stored events and system text unchanged',()=>{
 const text='\n\n**用户原文**\r\n\r\n- 第一项\n- 第二项'
 const event={id:'11',taskId:'task',kind:'user' as const,text,createdAt:1}
 const state={tasks:[],providers:[],defaultProvider:'codex',canWechat:false,selectedId:null,detail:null,selectedArtifactId:null,error:'',preview:null}
 const context=workbenchMessageContext(state)
 const request='\n**检查重点**\r\n原样换行'
 for(const handoff of [false,true]){
  const current=handoff?{...context,handoffs:[{id:'h',requestEventId:11,request} as any]}:context
  const document=documentFor(renderMessageFor(current)(event))
  expect(document.querySelector('.cc-readable-markdown strong')?.textContent).toBe(handoff?'检查重点':'用户原文')
  const source=document.querySelector('details')!;source.open=true
  expect(source.querySelector('pre code')?.textContent).toBe(handoff?request:text)
  expect(!!document.querySelector('[data-action="handoff-record"]')).toBe(handoff)
 }
 expect(event.text).toBe(text)
 const system=documentFor(renderMessageFor(context)({...event,kind:'system',text:'**状态原文**'}))
 expect(system.querySelector('strong')).toBeNull();expect(system.querySelector('details')).toBeNull()
 expect(system.querySelector('.wb-message-body')?.textContent).toBe('**状态原文**')
})

// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRequire } from 'node:module'
import { afterEach, expect, it } from 'vitest'
import type { Backend } from '../backend/types'
import { useConversationStream } from './useConversationStream'

const createRoot = createRequire(import.meta.url)('react-dom/client').createRoot
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let current: ReturnType<typeof useConversationStream>
const roots: { unmount():void }[]=[]
function Probe({backend,online}:{backend:Backend;online:boolean}){current=useConversationStream(backend,online);return null}
afterEach(async()=>{await act(()=>roots.splice(0).forEach(root=>root.unmount()));document.body.innerHTML=''})
it('clears old owner text immediately on an offline backend switch and drops late polls',async()=>{
  const event={id:'item:1',turnId:'old-turn',kind:'agent_message',text:'private old owner',createdAt:1,cursor:1}
  let complete!: (v:{running:{turnId:string;runId:null};events:typeof event[];cursor:number})=>void
  const old={conversationEvents:async()=>({running:{turnId:'old-turn',runId:null},events:[event],cursor:1})} as Backend
  const offline={conversationEvents:()=>new Promise(r=>{complete=r})} as Backend
  const div=document.createElement('div');document.body.appendChild(div)
  const root=createRoot(div);roots.push(root)
  await act(async()=>root.render(createElement(Probe,{backend:old,online:true})))
  expect(current?.events[0]?.text).toBe('private old owner')
  await act(async()=>root.render(createElement(Probe,{backend:offline,online:false})))
  expect(current).toBeUndefined()
  await act(async()=>root.render(createElement(Probe,{backend:offline,online:true})))
  await act(async()=>root.render(createElement(Probe,{backend:old,online:false})))
  await act(async()=>complete({running:{turnId:'old-turn',runId:null},events:[event],cursor:2}))
  expect(current).toBeUndefined()
})

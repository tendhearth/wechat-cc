// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountConversationTopics } from './conversation-topics.js'
const topic = (id:string) => ({id,title:`话题${id}`,description:'说明',summary:'现状',bubbleState:'closed'})
let current:ReturnType<typeof mountConversationTopics>|undefined
afterEach(() => { current?.destroy(); vi.restoreAllMocks() })
const settle = async () => { for(let i=0;i<12;i++) await Promise.resolve() }
function setup(call:any) {
  document.body.innerHTML='<div id="root"><textarea>未发送的草稿</textarea><div class="converse-compose"></div></div>'
  const openMatter=vi.fn(),locateMessage=vi.fn()
  current=mountConversationTopics({root:document.getElementById('root')!,call,openMatter,locateMessage,manage:vi.fn()})
  return {openMatter,locateMessage}
}
describe('T4 desktop topic bubbles', () => {
  it('reads six recent topics without opening; selection alone writes and preserves the draft',async () => {
    const call=vi.fn(async(method:string,path:string) => {
      if(path.startsWith('/v1/subscribe')) return new Promise(()=>{})
      if(path.startsWith('/v1/memory/topics/detail')) return {topic:topic('1'),entries:[{id:'e',line:'承诺',body:'原文',source:'来源',updatedTs:'2026-11-06',recalled:true,status:'live'}],matters:[{id:'m',title:'备份',state:'waiting'}],messages:[{id:'msg',speaker:'cc',ts:'2026-11-06',excerpt:'原消息',source:'recall'}],pages:{}}
      if(method==='POST') return {id:'1'}
      return {topics:Array.from({length:6},(_,i)=>topic(String(i))),revision:'1'}
    })
    const {openMatter,locateMessage}=setup(call); await settle()
    expect(call.mock.calls.some(([method])=>method==='POST')).toBe(false)
    expect(document.querySelectorAll('nav button')).toHaveLength(7)
    ;(document.querySelector('nav button') as HTMLButtonElement).click(); await settle()
    expect(call.mock.calls.filter(([method])=>method==='POST')).toHaveLength(1)
    expect(document.querySelector('textarea')!.value).toBe('未发送的草稿')
    expect(document.querySelector('.conversation-topic-panel')!.textContent).toContain('这次想起')
    const buttons=[...document.querySelectorAll('.conversation-topic-panel button')] as HTMLButtonElement[]
    buttons.find(b=>b.textContent?.includes('备份'))!.click(); expect(openMatter).toHaveBeenCalledWith('m')
    buttons.find(b=>b.textContent?.includes('原消息'))!.click(); expect(locateMessage).toHaveBeenCalledWith('msg','原消息')
    buttons[0]!.click(); expect((document.querySelector('.conversation-topic-panel') as HTMLElement).hidden).toBe(true)
    expect(call.mock.calls.filter(([method])=>method==='POST')).toHaveLength(1)
  })
  it('old daemon or denied data never creates an empty advertised entry', async()=>{
    setup(vi.fn(async()=>{throw Error('404')})); await settle()
    expect((document.querySelector('nav') as HTMLElement).hidden).toBe(true)
    expect(document.querySelector('textarea')!.value).toBe('未发送的草稿')
  })
  it('a late selection response cannot replace the newer topic',async()=>{
    let release:()=>void=()=>{}
    setup(async(method:string,path:string)=>{
      if(path.startsWith('/v1/subscribe')) return new Promise(()=>{})
      if(method==='POST'&&path.endsWith('/open')) return new Promise<void>(resolve=>{release=resolve})
      return {topics:[topic('a'),topic('b')],revision:'1'}
    }); await settle()
    ;(document.querySelector('nav button') as HTMLButtonElement).click()
    current!.close(); release(); await settle()
    expect((document.querySelector('.conversation-topic-panel') as HTMLElement).hidden).toBe(true)
  })
})

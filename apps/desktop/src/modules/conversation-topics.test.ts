// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountConversationTopics } from './conversation-topics.js'
import { formatRelativeTime } from '../view.js'
const topic = (id:string) => ({id,title:`话题${id}`,description:'说明',summary:'现状',bubbleState:'closed'})
let current:ReturnType<typeof mountConversationTopics>|undefined
afterEach(() => { current?.destroy(); vi.restoreAllMocks() })
const settle = async () => { for(let i=0;i<12;i++) await Promise.resolve() }
function setup(call:any) {
  document.body.innerHTML='<div id="root"><textarea>未发送的草稿</textarea><div class="converse-compose"></div></div>'
  const openMatter=vi.fn(),locateMessage=vi.fn()
  current=mountConversationTopics({root:document.getElementById('root')!,call:async(method:any,path:string,body?:any)=>{if(path==='/v1/protocol/capabilities'){await call(method,path,body);return {topics:'v1',routes:'v1'}}return call(method,path,body)},openMatter,locateMessage,manage:vi.fn()})
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

it('searches the remaining historical pages without opening any topic',async()=>{
  const calls:Array<[string,string]>=[]
  setup(async(method:string,path:string)=>{
    calls.push([method,path])
    if(path.startsWith('/v1/subscribe'))return new Promise(()=>{})
    if(path.includes('view=all'))return path.includes('cursor=next')?{topics:[topic('old-target')],nextCursor:null,revision:'1'}:{topics:[topic('first')],nextCursor:'next',revision:'1'}
    return{topics:[topic('recent')],nextCursor:null,revision:'1'}
  })
  await settle()
  ;([...document.querySelectorAll('nav button')].find(b=>b.textContent==='更多话题') as HTMLButtonElement).click()
  await settle()
  const field=document.querySelector('.conversation-topic-panel input') as HTMLInputElement
  field.value='old-target';field.dispatchEvent(new Event('input'));await settle()
  expect(document.querySelector('.conversation-topic-panel')!.textContent).toContain('话题old-target')
  expect(calls.some(([,path])=>path.includes('cursor=next'))).toBe(true)
  expect(calls.some(([method])=>method==='POST')).toBe(false)
})

it('retries an uncertain owner open with the same request ID',async()=>{
  const ids:string[]=[]
  setup(async(method:string,path:string,body:any)=>{
    if(path.startsWith('/v1/subscribe'))return new Promise(()=>{})
    if(method==='POST'){ids.push(body.requestId);if(ids.length===1)throw Error('network');return{id:body.id}}
    if(path.includes('/detail'))return{topic:topic('r'),entries:[],matters:[],messages:[],pages:{}}
    return{topics:[topic('r')],revision:'1',nextCursor:null}
  })
  await settle();(document.querySelector('nav button') as HTMLButtonElement).click();await settle()
  ;([...document.querySelectorAll('.conversation-topic-panel button')].find(b=>b.textContent==='重试') as HTMLButtonElement).click();await settle()
  expect(ids).toHaveLength(2);expect(ids[0]).toBe(ids[1])
})


it('refreshing an expanded topic preserves the entry disclosure and keyboard focus',async()=>{
  setup(async(method:string,path:string)=>{
    if(path.startsWith('/v1/subscribe'))return new Promise(()=>{})
    if(method==='POST')return{id:'a'}
    if(path.includes('/detail'))return{topic:topic('a'),entries:[{id:'entry',line:'决定',body:'原文',source:'主人',updatedTs:'2026-11-06',status:'live'}],matters:[],messages:[],pages:{}}
    return{topics:[topic('a')],revision:'1',nextCursor:null}
  })
  await settle();(document.querySelector('nav button') as HTMLButtonElement).click();await settle()
  const entry=document.querySelector('[data-entry-id="entry"]') as HTMLDetailsElement;entry.open=true;entry.querySelector('summary')!.focus()
  await current!.refresh()
  expect((document.querySelector('[data-entry-id="entry"]') as HTMLDetailsElement).open).toBe(true)
  expect((document.activeElement as HTMLElement).dataset.topicFocusKey).toBe('entry:entry')
})

it('requires topics:v1 from the operator capability contract, never infers it from routes or list success',async()=>{
  document.body.innerHTML='<div id="root"><div class="converse-compose"></div></div>'
  const call=vi.fn(async()=>({routes:'v1',topics:[topic('a')],revision:'1'}))
  current=mountConversationTopics({root:document.getElementById('root')!,call,openMatter:vi.fn(),locateMessage:vi.fn(),manage:vi.fn()})
  await settle()
  expect((document.querySelector('nav') as HTMLElement).hidden).toBe(true)
  expect(call.mock.calls).toHaveLength(1)
})

it('a selected merged topic follows the authorized surviving id',async()=>{
  let detailReads=0
  setup(async(method:string,path:string)=>{
    if(path.startsWith('/v1/subscribe'))return new Promise(()=>{})
    if(path.includes('/detail')){detailReads++;return {topic:{...topic('survivor'),mergedInto:detailReads===1?'survivor':null},entries:[],matters:[],messages:[],pages:{}}}
    if(method==='POST')return {id:'old'}
    return {topics:[topic('old')],revision:'1'}
  })
  await settle();(document.querySelector('nav button') as HTMLButtonElement).click();await settle()
  expect(detailReads).toBeGreaterThanOrEqual(2)
  expect(document.querySelector('h2')?.textContent).toBe('话题survivor')
})

it('shows one priority activity mark with full counts for readers and opens original project sessions',async()=>{
  const activity={waiting:1,running:2,unread:1,lastActiveAt:100}
  const session={id:'task',kind:'task',title:'检查文件',executor:'codex',activity:'waiting',latestStep:'需要读取文件',updatedAt:100,requestId:'permission'}
  const {openMatter}=setup(async(method:string,path:string)=>{
    if(path.startsWith('/v1/subscribe'))return new Promise(()=>{})
    if(method==='POST')return{id:'project'}
    if(path.includes('/detail'))return{topic:{...topic('project'),activity},entries:[],matters:[{id:'task',title:'检查文件',state:'waiting',session}],messages:[],pages:{}}
    return{topics:[{...topic('project'),title:'bx',activity},{...topic('quiet'),activity:{waiting:0,running:0,unread:0,lastActiveAt:null}},{...topic('done'),activity:{waiting:0,running:0,unread:1,lastActiveAt:50}}],revision:'1'}
  })
  await settle()
  const project=document.querySelector('[data-topic-id="project"]')!
  expect(project.getAttribute('aria-label')).toBe('bx，1 个等你，2 个在跑，1 个做完未看')
  expect(project.querySelector('[data-topic-activity]')?.getAttribute('data-topic-activity')).toBe('waiting')
  expect(project.querySelector('[data-topic-activity]')?.textContent).toContain('1')
  expect(document.querySelector('[data-topic-id="quiet"] [data-topic-activity]')).toBeNull()
  expect(document.querySelector('[data-topic-id="done"] [data-topic-activity]')?.getAttribute('data-topic-activity')).toBe('unread')
  ;(project as HTMLButtonElement).click();await settle()
  const panel=document.querySelector('.conversation-topic-panel')!
  expect(panel.textContent).toContain('这个项目的会话')
  expect(panel.textContent).toContain('需要读取文件')
  expect(panel.querySelector('[data-agent="codex"]')).not.toBeNull()
  ;(panel.querySelector('[data-project-session="task"]') as HTMLButtonElement).click()
  expect(openMatter).toHaveBeenCalledWith('task')
})

it('keeps expanded project sessions across activity revisions using fresh cursors and bounded pages',async()=>{
  let revision='r1'
  const reads:string[]=[]
  const rows=Array.from({length:26},(_,i)=>({id:`session-${i+1}`,title:`会话 ${i+1}`,state:'running',session:{id:`session-${i+1}`,kind:'task',title:`会话 ${i+1}`,executor:'codex',activity:'running',latestStep:'正在核对',updatedAt:100,requestId:null}}))
  setup(async(method:string,path:string)=>{
    if(path.startsWith('/v1/subscribe'))return new Promise(()=>{})
    if(method==='POST')return{id:'project'}
    if(path.includes('/detail')){
      reads.push(path)
      const p=new URL(path,'https://fixture.test').searchParams,offset=Number(p.get('cursor')?.split(':')[1]??0),size=p.has('section')?20:3
      if(p.has('cursor'))expect(p.get('cursor')!.startsWith(revision+':')).toBe(true)
      return{topic:topic('project'),revision,entries:[],messages:[],matters:rows.slice(offset,offset+size),pages:{matters:{total:26,nextCursor:offset+size<26?`${revision}:${offset+size}`:null}}}
    }
    return{topics:[topic('project')],revision}
  })
  await settle();(document.querySelector('nav button') as HTMLButtonElement).click();await settle()
  for(let i=0;i<2;i++){const more=[...document.querySelectorAll('.conversation-topic-panel button')].find(b=>b.textContent?.startsWith('更多这个项目的会话')) as HTMLButtonElement;more.click();await settle()}
  expect(document.querySelector('[data-project-session="session-26"]')).not.toBeNull()
  revision='r2';reads.length=0;await current!.refresh()
  expect(document.querySelector('[data-project-session="session-4"]')).not.toBeNull()
  expect(document.querySelector('[data-project-session="session-26"]')).not.toBeNull()
  expect(reads).toHaveLength(3)
  expect(reads.slice(1).every(path=>new URL(path,'https://fixture.test').searchParams.get('limit')==='20')).toBe(true)
})

it('polishes project sessions: waiting and response then running precede summary; localized dates and names reach readers',async()=>{
  const ts=Date.now()-7_200_000, iso=new Date(ts).toISOString()
  const sessions=['idle','running','waiting'].map(activity=>({id:activity,title:`会话${activity}`,state:activity,session:{id:activity,kind:'task',title:`会话${activity}`,executor:'codex',displayName:'Codex',activity,latestStep:'核对文件',updatedAt:ts,requestId:activity==='waiting'?'approval':null}}))
  const {openMatter}=setup(async(method:string,path:string)=>{
    if(path.startsWith('/v1/subscribe'))return new Promise(()=>{})
    if(method==='POST')return{id:'polish'}
    if(path.includes('/detail'))return{topic:topic('polish'),matters:sessions,entries:[],messages:[{id:'msg',speaker:'cc',ts:iso,excerpt:'最近的消息'}],pages:{}}
    return{topics:[topic('polish')],revision:'1'}
  })
  await settle();(document.querySelector('nav button') as HTMLButtonElement).click();await settle()
  const panel=document.querySelector('.conversation-topic-panel')!, text=panel.textContent!
  expect.soft([...panel.querySelectorAll('[data-project-session]')].map(el=>el.getAttribute('data-project-session'))).toEqual(['waiting','running','idle'])
  expect.soft(text.indexOf('会话waiting')).toBeLessThan(text.indexOf('说明'))
  expect.soft(text.indexOf('会话running')).toBeLessThan(text.indexOf('说明'))
  expect.soft(text.indexOf('说明')).toBeLessThan(text.indexOf('会话idle'))
  const respond=panel.querySelector('[data-project-respond="waiting"]') as HTMLButtonElement
  expect.soft(respond?.textContent).toBe('回应')
  expect.soft(text.indexOf('回应')).toBeLessThan(text.indexOf('会话running'))
  respond?.click();expect.soft(openMatter).toHaveBeenCalledWith('waiting')
  const row=panel.querySelector('[data-project-session="waiting"]')!
  expect.soft(row.textContent).toContain('Codex')
  expect.soft(row.getAttribute('aria-label')).toContain('Codex')
  expect.soft(row.textContent).toContain(formatRelativeTime(iso))
  expect.soft(text).not.toContain(iso)
  expect.soft(text).toContain(`CC · ${formatRelativeTime(iso)} · 最近的消息`)
  expect.soft(text.indexOf('管理话题')).toBeGreaterThan(text.indexOf('最近聊到'))
})

it('keeps topic summary first when no waiting or running session needs attention',async()=>{
  setup(async(method:string,path:string)=>{
    if(path.startsWith('/v1/subscribe'))return new Promise(()=>{})
    if(method==='POST')return{id:'quiet'}
    if(path.includes('/detail'))return{topic:topic('quiet'),matters:[{id:'done',session:{title:'已看会话',executor:'claude',displayName:'Claude',activity:'idle',updatedAt:100}}],entries:[],messages:[],pages:{}}
    return{topics:[topic('quiet')],revision:'1'}
  })
  await settle();(document.querySelector('nav button') as HTMLButtonElement).click();await settle()
  const text=document.querySelector('.conversation-topic-panel')!.textContent!
  expect.soft(text.indexOf('说明')).toBeLessThan(text.indexOf('这个项目的会话'))
})

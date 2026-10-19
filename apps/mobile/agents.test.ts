import {afterEach,describe,expect,it,vi} from 'vitest'
import {Window} from 'happy-dom'
import {assembleMobilePage} from './assemble'
import {readMobileSource} from './sources'

// 执行者头像(2026-10-19,同手机 app):「一起做」每件事行尾一组圆头像,详情标题下头像 + 名字。
// 图形与画法跟桌面共用 apps/desktop/src/shared/agent-avatars.{js,css},sources.ts 在 workbench.js 顶上内联。
const windows:Window[]=[]
afterEach(async()=>{await Promise.all(windows.splice(0).map(window=>window.happyDOM.abort()))})
const matter=(id:string,agents?:string[])=>({id,kind:'task',title:'事 '+id,projectPath:'/p/blog',status:'open',ownerChatId:null,originMatterId:null,originMessageId:null,createdAt:1,updatedAt:1,...(agents?{agents}:{})})
function load(matters:unknown[]){
  const window=new Window({url:'https://fixture.test/m'});windows.push(window)
  const document=window.document;document.body.innerHTML=assembleMobilePage(readMobileSource).phone
  const api=vi.fn(async(path:string)=>({ok:true,status:200,json:async()=>path.startsWith('/m/api/matters')?{ok:true,matters}:{ok:false,error:'not_found'}}))
  const env={document,window,api,fetch:api,tunnel:vi.fn(),q:(p:string)=>p,localStorage:window.localStorage,REMOTE:{id:'t'},AbortController,setTimeout,clearTimeout,crypto,URL:{revokeObjectURL:()=>{}},
    CCM:{renderMarkdown:(s:string)=>s,hasMarkdownFormatting:()=>false},ago:()=>'刚刚',
    esc:(text:unknown)=>String(text).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]!)}
  const fns=new Function(...Object.keys(env),'var preferTunnel=false;\n'+readMobileSource('workbench.js')+'\nreturn {loadMatters,renderMatter}')(...Object.values(env)) as {loadMatters:()=>void,renderMatter:(d:unknown)=>void}
  return {...fns,document}
}
const wait=()=>new Promise(resolve=>setTimeout(resolve,5))

describe('phone page: 执行者头像',()=>{
  it('列表:行尾一组头像,正在做的在前、压在最上;超过 4 个折成 +N;老 daemon 不带 agents 就不画;名字只在读屏标签里',async()=>{
    const h=load([matter('a',['codex','claude']),matter('b'),matter('c',['claude','codex','cursor','agy','kimi'])])
    h.loadMatters();await wait()
    const row=(id:string)=>h.document.querySelector(`[data-mid="${id}"]`)!
    const a=row('a').querySelector('.th-agents')!
    expect(a.getAttribute('role')).toBe('img')
    expect(a.getAttribute('aria-label')).toBe('Codex、Claude Code')
    expect([...a.querySelectorAll('.th-agent')].map(e=>[e.getAttribute('data-agent'),(e as any).style.zIndex])).toEqual([['codex','2'],['claude','1']])
    expect(a.querySelectorAll('svg path').length).toBeGreaterThan(0)
    expect(row('a').querySelector('.tx')!.textContent).not.toContain('Codex')
    expect(row('b').querySelector('.th-agents')).toBeNull()
    expect([...row('c').querySelectorAll('.th-agent')].map(e=>e.textContent||e.getAttribute('data-agent'))).toEqual(['claude','codex','cursor','+2'])
  })
  it('详情:标题下头像 + 名字,任务那一家在前;没有执行者就藏起来',()=>{
    const h=load([])
    const base={bindings:[],sessions:[],events:[],permissions:[],questions:[],artifacts:[],inputs:[]}
    h.renderMatter({...base,matter:matter('d',['claude','my-acp']),task:{providerId:'codex'}})
    const who=h.document.getElementById('m-agents') as unknown as HTMLElement
    expect(who.hidden).toBe(false)
    expect(who.querySelector('.th-agents')!.getAttribute('aria-label')).toBe('Codex、Claude Code、my-acp')
    expect(who.querySelector('.th-agent-mono')!.textContent).toBe('M')
    expect(who.querySelector(':scope > span:last-child')!.textContent).toBe('Codex、Claude Code、my-acp')
    h.renderMatter({...base,matter:{...matter('e'),kind:'chat'},task:null})
    expect(who.hidden).toBe(true)
    expect(who.innerHTML).toBe('')
  })
})

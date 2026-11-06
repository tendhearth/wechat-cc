import {afterEach,expect,it} from 'vitest'
import {Window} from 'happy-dom'
import {assembleMobilePage} from './assemble'
import {readMobileSource} from './sources'
const windows:Window[]=[]
afterEach(async()=>{await Promise.all(windows.splice(0).map(w=>w.happyDOM.abort()))})
function fixture(device=true){
 const w=new Window({url:'https://fixture.test/m'});windows.push(w);w.document.body.innerHTML=assembleMobilePage(readMobileSource).phone
 const calls:string[]=[],posts:any[]=[]
 let pageGate:Promise<any>|null=null
 const topic={id:'server',title:'服务器',description:'家里的备份',summary:'核对中',bubbleState:'closed'}
 const detail={topic,entries:[{id:'e',line:'每周核验',body:'原始内容',recalled:true,source:'主人',createdTs:'2026-11-06T00:00:00Z'}],matters:[],messages:[],pages:{entries:{total:1,nextCursor:null},matters:{total:0,nextCursor:null},messages:{total:0,nextCursor:null}}}
 const env={document:w.document,window:w,T:'dTEST',isDevice:device,REMOTE:null,preferTunnel:false,crypto:globalThis.crypto,setTimeout:()=>0,clearTimeout:()=>{},esc:(s:any)=>String(s).replace(/</g,'&lt;').replace(/"/g,'&quot;'),api:async(p:string)=>{calls.push(p);return {status:200,json:async()=>p.includes('/owner-chat/page')&&pageGate?await pageGate:p.includes('/detail')?detail:{topics:[topic],nextCursor:null,revision:'1'}}},mPostOnce:async(p:string,o:any)=>{posts.push({p,body:JSON.parse(o.body)});return {status:200}},onUnauthorized:()=>{},cPrivacyRevision:0,cMessages:new Map(),cReady:true,cRender:()=>{},cNotice:()=>{},openMatter:()=>{},tunnel:()=>({subscribe:()=>()=>{}})}
 const f=new Function(...Object.keys(env),readMobileSource('topics.js')+'\nreturn {tStart,tOpen,tClose,tClear,tList,cLocateMessage,revoke(){isDevice=false;cReady=false;cPrivacyRevision++;cMessages.clear();tClear()},messageCount(){return cMessages.size}}')(...Object.values(env))
 return {w,calls,posts,delayPage(){let release!:(b:any)=>void;pageGate=new Promise(r=>{release=r});return release},...f}
}
it('device row asks for six, opens one bubble without sending chat; closing preserves draft and never closes daemon state',async()=>{
 const h=fixture();(h.w.document.getElementById('chat-input') as unknown as HTMLTextAreaElement).value='草稿';h.tStart();await new Promise(r=>setTimeout(r,0));expect(h.calls[0]).toContain('view=recent&limit=6');await h.tOpen('server');expect(h.posts).toHaveLength(1);expect(h.posts[0]).toMatchObject({p:'/v1/memory/topics/open',body:{id:'server'}});expect(h.w.document.getElementById('topic-body')?.textContent).toContain('这次想起');h.tClose();expect(h.posts).toHaveLength(1);expect((h.w.document.getElementById('chat-input') as unknown as HTMLTextAreaElement).value).toBe('草稿');h.tClear();expect(h.w.document.getElementById('topic-body')?.textContent).toBe('')
})
it('link identity cannot fetch or open topics',async()=>{const h=fixture(false);h.tStart();await h.tList(false,false);await h.tOpen('server');expect(h.calls).toEqual([]);expect(h.posts).toEqual([])})

it('a delayed location response cannot repopulate private messages after revocation',async()=>{
 const h=fixture(),release=h.delayPage(),locating=h.cLocateMessage('secret','2026-11-06T00:00:00Z');h.revoke();release({ok:true,messages:[{id:'secret',text:'private body',at:1}]});await locating;expect(h.messageCount()).toBe(0);expect(h.w.document.getElementById('chat-messages')?.textContent).toBe('')
})

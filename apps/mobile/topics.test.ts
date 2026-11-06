import {afterEach,expect,it} from 'vitest'
import {Window} from 'happy-dom'
import {assembleMobilePage} from './assemble'
import {readMobileSource} from './sources'
const windows:Window[]=[]
afterEach(async()=>{await Promise.all(windows.splice(0).map(w=>w.happyDOM.abort()))})
function fixture(device=true){
 const w=new Window({url:'https://fixture.test/m'});windows.push(w);w.document.body.innerHTML=assembleMobilePage(readMobileSource).phone
 const calls:string[]=[],posts:any[]=[]
 let openFail=false,pageGate:Promise<any>|null=null,detailGate:Promise<any>|null=null
 const topic={id:'server',title:'服务器',description:'家里的备份',summary:'核对中',bubbleState:'closed'}
 const detail={topic,entries:[{id:'e',line:'每周核验',body:'原始内容',recalled:true,source:'主人',createdTs:'2026-11-06T00:00:00Z'}],matters:[],messages:[],pages:{entries:{total:1,nextCursor:null},matters:{total:0,nextCursor:null},messages:{total:0,nextCursor:null}}}
 const env={document:w.document,window:w,T:'dTEST',isDevice:device,REMOTE:null,preferTunnel:false,crypto:globalThis.crypto,setTimeout:()=>0,clearTimeout:()=>{},esc:(s:any)=>String(s).replace(/</g,'&lt;').replace(/"/g,'&quot;'),api:async(p:string)=>{calls.push(p);if(p.includes('/detail')&&detailGate){const pending=detailGate;detailGate=null;return await pending};return {status:200,json:async()=>p.includes('/owner-chat/page')&&pageGate?await pageGate:p.includes('/detail')?{...detail,topic:{...topic,id:new URL('https://fixture.test'+p).searchParams.get('id'),title:p.includes('id=other')?'另一个':'服务器'}}:{topics:[topic],nextCursor:null,revision:'1'}}},mPostOnce:async(p:string,o:any)=>{posts.push({p,body:JSON.parse(o.body)});if(openFail){openFail=false;throw Error('offline')};topic.bubbleState='open';return {status:200}},onUnauthorized:()=>{},cPrivacyRevision:0,cMessages:new Map(),cReady:true,cRender:()=>{},cNotice:()=>{},openMatter:()=>{},tunnel:()=>({subscribe:()=>()=>{}})}
 const f=new Function(...Object.keys(env),readMobileSource('topics.js')+'\nreturn {tStart,tOpen,tClose,tClear,tList,tRead,cLocateMessage,revoke(){isDevice=false;cReady=false;cPrivacyRevision++;cMessages.clear();tClear()},messageCount(){return cMessages.size},selected(){return tSelected}}')(...Object.values(env))
 return {w,calls,posts,failOpenOnce(){openFail=true},sleep(){topic.bubbleState='closed'},delayDetail(){let release!:(r:any)=>void;detailGate=new Promise(r=>{release=r});return release},delayPage(){let release!:(b:any)=>void;pageGate=new Promise(r=>{release=r});return release},...f}
}
it('device row asks for six, opens one bubble without sending chat; closing preserves draft and never closes daemon state',async()=>{
 const h=fixture();(h.w.document.getElementById('chat-input') as unknown as HTMLTextAreaElement).value='草稿';h.tStart();await new Promise(r=>setTimeout(r,0));expect(h.calls[0]).toContain('view=recent&limit=6');await h.tOpen('server');expect(h.posts).toHaveLength(1);expect(h.posts[0]).toMatchObject({p:'/v1/memory/topics/open',body:{id:'server'}});expect(h.w.document.getElementById('topic-body')?.textContent).toContain('这次想起');h.tClose();expect(h.posts).toHaveLength(1);expect((h.w.document.getElementById('chat-input') as unknown as HTMLTextAreaElement).value).toBe('草稿');h.tClear();expect(h.w.document.getElementById('topic-body')?.textContent).toBe('')
})
it('link identity cannot fetch or open topics',async()=>{const h=fixture(false);h.tStart();await h.tList(false,false);await h.tOpen('server');expect(h.calls).toEqual([]);expect(h.posts).toEqual([])})

it('a delayed location response cannot repopulate private messages after revocation',async()=>{
 const h=fixture(),release=h.delayPage(),locating=h.cLocateMessage('secret','2026-11-06T00:00:00Z');await Promise.resolve();h.revoke();release({ok:true,messages:[{id:'secret',text:'private body',at:1}]});await locating;expect(h.messageCount()).toBe(0);expect(h.w.document.getElementById('chat-messages')?.textContent).toBe('')
})

it('a successful sleep closes the selected panel without deleting its recent tag or sending a close write',async()=>{
 const h=fixture();h.tStart();await new Promise(r=>setTimeout(r,0));await h.tOpen('server');h.sleep();await h.tRead();expect((h.w.document.getElementById('topic-panel') as unknown as HTMLElement).hidden).toBe(true);expect(h.posts).toHaveLength(1);await h.tList(false,false);expect(h.w.document.getElementById('topic-row')?.textContent).toContain('服务器')
})

it('a late 404 for the previous topic cannot clear or close the newly selected topic',async()=>{
 const h=fixture();h.tStart();await new Promise(r=>setTimeout(r,0));await h.tOpen('server');const release=h.delayDetail(),old=h.tRead();await h.tOpen('other');expect(h.selected()).toBe('other');release({status:404});await old;expect(h.selected()).toBe('other');expect(h.w.document.getElementById('topic-body')?.textContent).toContain('另一个');expect((h.w.document.getElementById('topic-panel') as unknown as HTMLElement).hidden).toBe(false)
})

it('a failed explicit open exposes Retry and retries the open action rather than reading a still-closed bubble',async()=>{
 const h=fixture();h.tStart();await new Promise(r=>setTimeout(r,0));h.failOpenOnce();await h.tOpen('server');const retry=h.w.document.getElementById('topic-retry') as unknown as HTMLButtonElement;expect(retry.hidden).toBe(false);retry.click();await new Promise(r=>setTimeout(r,0));expect(h.w.document.getElementById('topic-body')?.textContent).toContain('每周核验');expect(retry.hidden).toBe(true);expect(h.posts).toHaveLength(2);expect(h.posts.every((p:any)=>p.p==='/v1/memory/topics/open')).toBe(true)
})

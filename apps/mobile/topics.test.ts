import {afterEach,expect,it} from 'vitest'
import {Window} from 'happy-dom'
import {assembleMobilePage} from './assemble'
import {readMobileSource} from './sources'
import {createAgentAvatars} from '../desktop/src/shared/agent-avatars.js'
const windows:Window[]=[]
afterEach(async()=>{await Promise.all(windows.splice(0).map(w=>w.happyDOM.abort()))})
function fixture(device=true,project=false,detailLoader?: (path:string)=>any){
 const w=new Window({url:'https://fixture.test/m'});windows.push(w);w.document.body.innerHTML=assembleMobilePage(readMobileSource).phone
 const calls:string[]=[],posts:any[]=[],opened:string[]=[]
 let openFail=false,pageGate:Promise<any>|null=null,detailGate:Promise<any>|null=null
 const topic={id:'server',title:'服务器',description:'家里的备份',summary:'核对中',bubbleState:'closed',...(project?{activity:{waiting:1,running:2,unread:1,lastActiveAt:100}}:{})}
 const detail={topic,entries:[{id:'e',status:'live',line:'每周核验',body:'原始内容',recalled:true,source:'主人',createdTs:'2026-11-06T00:00:00Z'}],matters:project?[{id:'task',title:'检查文件',state:'waiting',session:{id:'task',kind:'task',title:'检查文件',executor:'codex',activity:'waiting',latestStep:'需要读取文件',updatedAt:100,requestId:'permission'}}]:[],messages:[],pages:{entries:{total:1,nextCursor:null},matters:{total:0,nextCursor:null},messages:{total:0,nextCursor:null}}}
 const env={mAgents:createAgentAvatars(),document:w.document,window:w,T:'dTEST',isDevice:device,REMOTE:null,preferTunnel:false,crypto:globalThis.crypto,setTimeout:()=>0,clearTimeout:()=>{},esc:(s:any)=>String(s).replace(/</g,'&lt;').replace(/"/g,'&quot;'),api:async(p:string)=>{calls.push(p);if(p.includes('/detail')&&detailGate){const pending=detailGate;detailGate=null;return await pending};if(p.includes('/detail')&&detailLoader)return {status:200,json:async()=>detailLoader(p)};return {status:200,json:async()=>p.includes('/owner-chat/page')&&pageGate?await pageGate:p.includes('/detail')?{...detail,topic:{...topic,id:new URL('https://fixture.test'+p).searchParams.get('id'),title:p.includes('id=other')?'另一个':'服务器'}}:{topics:[topic],nextCursor:null,revision:'1'}}},mPostOnce:async(p:string,o:any)=>{posts.push({p,body:JSON.parse(o.body)});if(openFail){openFail=false;throw Error('offline')};topic.bubbleState='open';return {status:200}},onUnauthorized:()=>{},cPrivacyRevision:0,cMessages:new Map(),cReady:true,cRender:()=>{},cNotice:()=>{},openMatter:(id:string)=>opened.push(id),tunnel:()=>({subscribe:()=>()=>{}})}
 const f=new Function(...Object.keys(env),readMobileSource('topics.js')+'\nreturn {tStart,tOpen,tClose,tClear,tList,tRead,cLocateMessage,revoke(){isDevice=false;cReady=false;cPrivacyRevision++;cMessages.clear();tClear()},messageCount(){return cMessages.size},selected(){return tSelected}}')(...Object.values(env))
 return {w,calls,posts,opened,failOpenOnce(){openFail=true},sleep(){topic.bubbleState='closed'},delayDetail(){let release!:(r:any)=>void;detailGate=new Promise(r=>{release=r});return release},delayPage(){let release!:(b:any)=>void;pageGate=new Promise(r=>{release=r});return release},...f}
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


it('device edits stay in the bubble and link identities cannot submit edits',async()=>{
 const h=fixture();h.tStart();await new Promise(r=>setTimeout(r,0));await h.tOpen('server')
 const body=h.w.document.getElementById('topic-body')!
 expect(body.textContent).toContain('管理话题')
 const name=h.w.document.getElementById('topic-name') as unknown as HTMLInputElement;name.value='家中备份'
 ;(body.querySelector('[data-topic-edit="rename"]') as unknown as HTMLButtonElement).click()
 await new Promise(r=>setTimeout(r,0))
 expect(h.posts.at(-1)).toEqual({p:'/v1/memory/topics/rename',body:{id:'server',title:'家中备份'}})
 ;(body.querySelector('[data-topic-wrong="e"]') as unknown as HTMLButtonElement).click()
 await new Promise(r=>setTimeout(r,0))
 expect(h.posts.at(-1)).toEqual({p:'/v1/memory/topics/entry/wrong',body:{id:'e'}})
 const before=h.posts.length;h.revoke()
 expect(h.posts).toHaveLength(before)
 expect(h.w.document.getElementById('topic-body')?.textContent).toBe('')
})


it('合并后的旧话题引用跟随 v109 别名，不额外打开泡泡',async()=>{
 const h=fixture();h.tStart();await new Promise(r=>setTimeout(r,0));await h.tOpen('server')
 const release=h.delayDetail(),pending=h.tRead()
 release({status:200,json:async()=>({topic:{id:'survivor',mergedInto:'survivor',bubbleState:'open'}})})
 await pending
 expect(h.selected()).toBe('survivor')
 expect(h.calls.some((p:string)=>p.includes('/detail?id=survivor'))).toBe(true)
 expect(h.posts).toHaveLength(1)
 expect(h.w.document.getElementById('topic-notice')?.textContent).toBe('')
})

it('device topics read daemon activity and project session data without a new write path',async()=>{
 const h=fixture(true,true);h.tStart();await new Promise(r=>setTimeout(r,0))
 const tag=h.w.document.querySelector('[data-topic="server"]')!
 expect(tag.getAttribute('aria-label')).toBe('服务器，1 个等你，2 个在跑，1 个做完未看')
 expect(tag.querySelector('[data-topic-activity="waiting"]')?.textContent).toBe('1')
 await h.tOpen('server')
 const row=h.w.document.querySelector('[data-project-session="task"]')!
 expect(row.textContent).toContain('需要读取文件')
 expect(row.querySelector('[data-agent="codex"]')).not.toBeNull()
 ;(row as unknown as HTMLButtonElement).click()
 expect(h.opened).toEqual(['task'])
 expect(h.posts.map((p:any)=>p.p)).toEqual(['/v1/memory/topics/open'])
})

it('keeps expanded project sessions after activity refresh and follows only new revision cursors',async()=>{
 let revision='r1';const reads:string[]=[]
 const rows=Array.from({length:26},(_,i)=>({id:`session-${i+1}`,title:`会话 ${i+1}`,state:'running',session:{id:`session-${i+1}`,kind:'task',title:`会话 ${i+1}`,executor:'codex',activity:'running',latestStep:'正在核对',updatedAt:100,requestId:null}}))
 const h=fixture(true,true,path=>{
   reads.push(path);const p=new URL(path,'https://fixture.test').searchParams,offset=Number(p.get('cursor')?.split(':')[1]??0),size=p.has('section')?20:3
   if(p.has('cursor'))expect(p.get('cursor')!.startsWith(revision+':')).toBe(true)
   return{topic:{id:'server',title:'服务器',bubbleState:'open'},revision,entries:[],messages:[],matters:rows.slice(offset,offset+size),pages:{entries:{total:0,nextCursor:null},messages:{total:0,nextCursor:null},matters:{total:26,nextCursor:offset+size<26?`${revision}:${offset+size}`:null}}}
 })
 h.tStart();await new Promise(r=>setTimeout(r,0));await h.tOpen('server')
 await h.tRead('matters','r1:3');await h.tRead('matters','r1:23')
 expect(h.w.document.querySelector('[data-project-session="session-26"]')).not.toBeNull()
 revision='r2';reads.length=0;await h.tRead()
 expect(h.w.document.querySelector('[data-project-session="session-4"]')).not.toBeNull()
 expect(h.w.document.querySelector('[data-project-session="session-26"]')).not.toBeNull()
 expect(reads).toHaveLength(3)
 expect(reads.slice(1).every(path=>new URL(path,'https://fixture.test').searchParams.get('limit')==='20')).toBe(true)
})

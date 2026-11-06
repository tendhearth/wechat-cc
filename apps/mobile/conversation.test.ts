import { afterEach, describe, expect, it } from 'vitest'
import { Window } from 'happy-dom'
import { readMobileSource } from './sources'
import { assembleMobilePage } from './assemble'
const windows: Window[]=[]
afterEach(async()=>{await Promise.all(windows.splice(0).map(w=>w.happyDOM.abort()))})
function fixture(device=true){
 const w=new Window({url:'https://fixture.test/m'});windows.push(w)
 w.document.body.innerHTML=assembleMobilePage(readMobileSource).phone
 const reads:string[]=[],writes:unknown[]=[]
 let sendGate:Promise<void>|null=null
 const matters: any[]=[]
 const response={ok:true,conversation:'v1',messages:[{id:'a',role:'me',text:'<script>private</script>',at:1}],hasMore:false,pending:null}
 const env={document:w.document,window:w,isDevice:device,T:'dTEST',REMOTE:null,location:w.location,sessionStorage:w.sessionStorage,crypto:globalThis.crypto,mCurrent:null,mMatters:matters,mStatusKey:(m:any)=>m.state||'working',mNameOf:()=>((id:string)=>id),CCP:{STATUS_WORDS:{working:'在做',waiting:'等你决定',done:'完成'}},ccPlain:(s:string)=>s,openMatter:()=>{},setInterval:()=>0,esc:(s:string)=>s.replace(/</g,'&lt;'),api:async(p:string)=>{reads.push(p);return {status:200,json:async()=>p.startsWith('/v1/matters')?{matters:matters.filter(m=>m.state==='waiting'),nextCursor:null}:response}},mPostOnce:async(p:string,o:unknown)=>{writes.push({p,o});if(sendGate)await sendGate;return {status:200,json:async()=>({ok:true})}},onUnauthorized:()=>{}}
 const f=new Function(...Object.keys(env),readMobileSource('conversation.js')+'\n'+readMobileSource('delegation.js')+'\nreturn {cRead,cSend,cMatterUpdates}')(...Object.values(env))
 return {w,reads,writes,response,matters,deferSend(){let release!:()=>void;sendGate=new Promise<void>(r=>{release=r});return release},...f}
}
describe('device conversation',()=>{
 it('link identity never requests the private transcript or sends',async()=>{const h=fixture(false);await h.cRead();await h.cSend({preventDefault(){}});expect(h.reads).toEqual([]);expect(h.writes).toEqual([])})
 it('renders safe original messages and sends only to owner chat',async()=>{const h=fixture();await new Promise(r=>setTimeout(r,0));expect(h.w.document.querySelector('#chat-messages script')).toBeNull();expect(h.w.document.querySelector('#chat-messages')?.textContent).toContain('<script>private</script>');(h.w.document.getElementById('chat-input') as unknown as HTMLTextAreaElement).value='hello';await h.cSend({preventDefault(){}});expect(h.writes).toHaveLength(1);expect(h.writes[0]).toMatchObject({p:'/v1/matter/owner-chat/say'});expect(h.w.document.body.classList.contains('conversation-ready')).toBe(true)})
})

it('delegation references update once; old unlinked work is revealed only through waiting/search',async()=>{
 const h=fixture();await new Promise(r=>setTimeout(r,0))
 h.matters.push({id:'old',kind:'task',title:'以前的事',createdAt:1,updatedAt:2,state:'waiting'},{id:'linked',kind:'task',title:'查备份',originMessageId:'a',createdAt:1,updatedAt:2,state:'working'})
 h.cMatterUpdates();await new Promise(r=>setTimeout(r,0));expect(h.w.document.querySelectorAll('[data-reference]')).toHaveLength(1);expect(h.w.document.getElementById('chat-waiting')?.textContent).toBe('1 件事等你')
 h.matters[1].state='done';h.cMatterUpdates();await new Promise(r=>setTimeout(r,0));expect(h.w.document.querySelectorAll('[data-reference]')).toHaveLength(1);expect(h.w.document.getElementById('reference-linked')?.textContent).toContain('完成');expect(h.writes).toEqual([])
})

it('a successful send preserves the next draft typed while its receipt is in flight',async()=>{
 const h=fixture();await new Promise(r=>setTimeout(r,0));const input=h.w.document.getElementById('chat-input') as unknown as HTMLTextAreaElement;input.value='first';const release=h.deferSend(),sending=h.cSend({preventDefault(){}});input.value='next draft';release();await sending;expect(input.value).toBe('next draft')
})

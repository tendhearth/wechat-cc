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
 const response={ok:true,conversation:'v1',messages:[{id:'a',role:'me',text:'<script>private</script>',at:1}],hasMore:false,pending:null}
 const env={document:w.document,window:w,isDevice:device,T:'dTEST',REMOTE:null,location:w.location,sessionStorage:w.sessionStorage,crypto:globalThis.crypto,mCurrent:null,setInterval:()=>0,esc:(s:string)=>s.replace(/</g,'&lt;'),api:async(p:string)=>{reads.push(p);return {status:200,json:async()=>response}},mPostOnce:async(p:string,o:unknown)=>{writes.push({p,o});return {status:200,json:async()=>({ok:true})}},onUnauthorized:()=>{}}
 const f=new Function(...Object.keys(env),readMobileSource('conversation.js')+'\nreturn {cRead,cSend}')(...Object.values(env))
 return {w,reads,writes,response,...f}
}
describe('device conversation',()=>{
 it('link identity never requests the private transcript or sends',async()=>{const h=fixture(false);await h.cRead();await h.cSend({preventDefault(){}});expect(h.reads).toEqual([]);expect(h.writes).toEqual([])})
 it('renders safe original messages and sends only to owner chat',async()=>{const h=fixture();await new Promise(r=>setTimeout(r,0));expect(h.w.document.querySelector('#chat-messages script')).toBeNull();expect(h.w.document.querySelector('#chat-messages')?.textContent).toContain('<script>private</script>');(h.w.document.getElementById('chat-input') as unknown as HTMLTextAreaElement).value='hello';await h.cSend({preventDefault(){}});expect(h.writes).toHaveLength(1);expect(h.writes[0]).toMatchObject({p:'/v1/matter/owner-chat/say'});expect(h.w.document.body.classList.contains('conversation-ready')).toBe(true)})
})

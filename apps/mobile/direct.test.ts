import { afterEach,expect,it } from 'vitest'
import { Window } from 'happy-dom'
import { readMobileSource } from './sources'
import { assembleMobilePage } from './assemble'
import { createAgentAvatars } from '../desktop/src/shared/agent-avatars.js'
const windows:Window[]=[]
afterEach(async()=>{await Promise.all(windows.splice(0).map(w=>w.happyDOM.abort()))})
function fixture(device=true){const w=new Window();windows.push(w);w.document.body.innerHTML=assembleMobilePage(readMobileSource).phone;let fail=false;const writes:any[]=[],reads:string[]=[];const env={document:w.document,window:w,isDevice:device,T:'d',mCurrent:'abcd1234',mAgents:createAgentAvatars(),mNameOf:()=>((id:string)=>id),ccPlain:(s:string)=>s,esc:(s:string)=>String(s),crypto:globalThis.crypto,onUnauthorized:()=>{},mPostOnce:async(p:string,o:any)=>{writes.push({p,body:JSON.parse(o.body)});if(fail)throw Error('offline');return {status:200,json:async()=>({ok:true})}},api:async(p:string)=>{reads.push(p);const requestId=new URL('https://test'+p).searchParams.get('requestId');return {status:200,json:async()=>({ok:true,input:{id:requestId,status:'delivered'}})}}};const code=readMobileSource('workbench.js').split('var mRosterTarget=')[1];const f=new Function(...Object.keys(env),'var mRosterTarget='+code+';return {mDirectMount,mDirectSend,mDirectCheck,mSaveDirect,mDirectRender,setId(id){mSaveDirect();mCurrent=id;mDirectMount()},terminal(){mRosterTarget={terminal:{sessionId:"session"}}}}')(...Object.values(env));f.mDirectMount();return {w,writes,reads,...f,fail(){fail=true},input:()=>w.document.getElementById('m-say-text') as unknown as HTMLTextAreaElement}}
const event={preventDefault(){}}
it('device form sends task original text and requestId independently of owner composer',async()=>{const h=fixture();(h.w.document.getElementById('chat-input') as unknown as HTMLTextAreaElement).value='给 CC';h.input().value=' 给 Codex ';await h.mDirectSend(event);expect(h.writes).toEqual([{p:'/v1/matter/say',body:{id:'abcd1234',text:' 给 Codex ',requestId:expect.any(String)}}]);expect((h.w.document.getElementById('chat-input') as unknown as HTMLTextAreaElement).value).toBe('给 CC');expect(h.input().value).toBe('')})
it('uncertain delivery preserves draft and reconciles by requestId without resend',async()=>{const h=fixture();h.fail();h.input().value='原文';await h.mDirectSend(event);expect(h.input().value).toBe('原文');expect(h.w.document.getElementById('m-say-notice')?.textContent).toBe('结果待核对');await h.mDirectCheck();expect(h.reads[0]).toContain(h.writes[0].body.requestId);expect(h.writes).toHaveLength(1);expect(h.input().value).toBe('')})
it('switching away and returning keeps each matter draft',()=>{const h=fixture();h.input().value='第一件';h.setId('other');h.input().value='第二件';h.setId('abcd1234');expect(h.input().value).toBe('第一件')})
it('terminal sends only to the terminal session',async()=>{const h=fixture();h.terminal();h.input().value='继续';await h.mDirectSend(event);expect(h.writes).toEqual([{p:'/v1/cli/session-say',body:{session_id:'session',text:'继续'}}])})
it('link identity has no form or writes',async()=>{const h=fixture(false);expect(h.input()).toBeNull();await h.mDirectSend(event);expect(h.writes).toEqual([])})
it('popstate closes detail before restoring conversation and saves direct draft',()=>{
 const h=fixture();h.input().value='返回保留';let current:any='abcd1234',saved=false;const doc=h.w.document
 doc.getElementById('m-back')!.addEventListener('click',()=>{h.mSaveDirect();saved=true;current=null;(doc.getElementById('m-detail') as unknown as HTMLElement).hidden=true})
 const env={document:doc,window:h.w,history:h.w.history,isDevice:true,cReady:true,tClose:()=>{},tList:()=>{},tRead:()=>{},openMatter:()=>{},mCurrent:current}
 new Function(...Object.keys(env),readMobileSource('layers.js'))(...Object.values(env))
 h.w.dispatchEvent(new h.w.PopStateEvent('popstate',{state:null}));expect(saved).toBe(true);expect((doc.getElementById('m-detail') as unknown as HTMLElement).hidden).toBe(true);h.setId('abcd1234');expect(h.input().value).toBe('返回保留')
})

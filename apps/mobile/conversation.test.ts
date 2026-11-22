import { afterEach, describe, expect, it } from 'vitest'
import { Window } from 'happy-dom'
import { readMobileSource } from './sources'
import { assembleMobilePage } from './assemble'
import { createAgentAvatars } from '../desktop/src/shared/agent-avatars.js'
const windows: Window[]=[]
afterEach(async()=>{await Promise.all(windows.splice(0).map(w=>w.happyDOM.abort()))})
function fixture(device=true,references=true){
 const w=new Window({url:'https://fixture.test/m'});windows.push(w)
 w.document.body.innerHTML=assembleMobilePage(readMobileSource).phone
 const reads:string[]=[],writes:unknown[]=[]
 let sendGate:Promise<void>|null=null
 let modelGate:Promise<void>|null=null
 const modelResponse={ok:true,providers:[{id:'claude',name:'Claude'},{id:'codex',name:'Codex'},{id:'cursor',name:'Cursor'},{id:'openai',name:'自定义 AI 服务'},{id:'gateway',name:'编造 "服务" <b>'}],provider:'cursor',model:'current-model'}
 const matters: any[]=[]
 const response={ok:true,matterId:'owner-chat',conversation:'v1',messages:[{id:'a',role:'me',text:'<script>private</script>',at:1}],hasMore:false,pending:null}
 const env={document:w.document,window:w,isDevice:device,T:'dTEST',REMOTE:null,location:w.location,sessionStorage:w.sessionStorage,crypto:globalThis.crypto,mCurrent:null,mMatters:matters,mAgents:createAgentAvatars(),mStatusKey:(m:any)=>m.state||'working',mNameOf:()=>((id:string)=>id),CCP:{STATUS_WORDS:{working:'在做',waiting:'等你决定',done:'完成'}},ccPlain:(s:string)=>s,openMatter:()=>{},setInterval:()=>0,esc:(s:string)=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]!),api:async(p:string)=>{reads.push(p);if(p==='/v1/matter/owner-chat/model'){if(modelGate)await modelGate;return {status:200,json:async()=>modelResponse}};return {status:200,json:async()=>p.startsWith('/v1/matters')?{matters:matters.filter(m=>m.state==='waiting'),nextCursor:null}:response}},mPostOnce:async(p:string,o:unknown)=>{writes.push({p,o});if(sendGate)await sendGate;return {status:200,json:async()=>({ok:true})}},onUnauthorized:()=>{}}
 const f=new Function(...Object.keys(env),readMobileSource('time.js')+'\n'+readMobileSource('conversation.js')+'\n'+(references?readMobileSource('delegation.js'):'')+'\nreturn {cRead,cSend,cMatterUpdates:typeof cMatterUpdates==="function"?cMatterUpdates:null,cClearPrivate}')(...Object.values(env))
 return {w,reads,writes,response,matters,modelResponse,deferNames(){let release!:()=>void;modelGate=new Promise<void>(r=>{release=r});return release},deferSend(){let release!:()=>void;sendGate=new Promise<void>(r=>{release=r});return release},...f}
}
describe('device conversation',()=>{
 it('link identity never requests the private transcript or sends',async()=>{const h=fixture(false);await h.cRead();await h.cSend({preventDefault(){}});expect(h.reads).toEqual([]);expect(h.writes).toEqual([])})
 it('renders safe original messages and sends only to owner chat',async()=>{const h=fixture();await new Promise(r=>setTimeout(r,0));expect(h.w.document.querySelector('#chat-messages script')).toBeNull();expect(h.w.document.querySelector('#chat-messages')?.textContent).toContain('<script>private</script>');(h.w.document.getElementById('chat-input') as unknown as HTMLTextAreaElement).value='hello';await h.cSend({preventDefault(){}});expect(h.writes).toHaveLength(1);expect(h.writes[0]).toMatchObject({p:'/v1/matter/owner-chat/say'});expect(h.w.document.body.classList.contains('conversation-ready')).toBe(true)})
})

describe('reply attribution avatars',()=>{
 const settle=()=>new Promise(r=>setTimeout(r,0))
 const reply=(id:string,metadata:object={})=>({id,role:'cc',text:'原始回复',at:2,...metadata})
 const message=(h:ReturnType<typeof fixture>,id:string)=>h.w.document.getElementById('message-'+id)!

 it.each([true,false])('renders one shared monochrome provider avatar with an accessible name (references=%s)',async references=>{
  const h=fixture(true,references)
  h.response.messages=[reply('claude',{speaker:'agent',provider:'claude'}),reply('codex',{speaker:'agent',provider:'codex'})]
  h.matters.push({id:'linked',kind:'task',title:'有关的事',originMessageId:'claude',createdAt:1,updatedAt:2,state:'working',agents:['cursor','codex']})
  await settle()
  for(const [id,name] of [['claude','Claude'],['codex','Codex']] as const){
   const row=message(h,id),mark=row.querySelector('.th-agents')!
   expect(row.querySelectorAll('.th-agent')).toHaveLength(1)
   expect(mark.getAttribute('role')).toBe('img')
   expect(mark.getAttribute('aria-label')).toBe(name)
   expect(mark.getAttribute('title')).toBe(name)
   expect(mark.querySelector('.th-agent')?.getAttribute('data-agent')).toBe(id)
   expect(mark.querySelector('svg')?.getAttribute('fill')).toBe('currentColor')
   expect(mark.querySelector('svg path')).not.toBeNull()
   expect(row.textContent).not.toContain(name)
   expect(row.querySelector('small')?.textContent).not.toContain('CC')
   expect(row.textContent).toContain('原始回复')
  }
  expect(h.reads.filter((p:string)=>p==='/v1/matter/owner-chat/model')).toHaveLength(1)
 })

 it('keeps CC, notice, unattributed records and owner messages free of executor avatars',async()=>{
  const h=fixture()
  h.response.messages=[reply('cc',{speaker:'cc',provider:'claude'}),reply('notice',{speaker:'notice',provider:'codex'}),reply('legacy',{provider:'claude',model:'Claude'}),reply('old'),{...reply('owner',{speaker:'agent',provider:'codex'}),role:'me'}]
  h.matters.push({id:'participants',agents:['codex'],agentNames:{codex:'Codex'}})
  await settle()
  for(const id of ['cc','notice','legacy','old','owner'])expect(message(h,id).querySelector('.th-agents')).toBeNull()
  expect(message(h,'cc').querySelector('small')?.textContent).toContain('CC')
 })

 it('keeps incomplete agent attribution in the existing presentation instead of inventing a provider',async()=>{
  const h=fixture()
  h.response.messages=[reply('missing',{speaker:'agent'}),reply('empty',{speaker:'agent',provider:''}),reply('blank',{speaker:'agent',provider:'  '}),reply('invalid',{speaker:'agent',provider:123})]
  await settle()
  for(const id of ['missing','empty','blank','invalid']){
   expect(message(h,id).querySelector('.th-agents')).toBeNull()
   expect(message(h,id).querySelector('small')?.textContent).toContain('CC')
  }
 })

 it('uses a stable generic service mark for unknown providers and openai gateways, without inferring a brand from model',async()=>{
  const h=fixture()
  h.response.messages=[reply('unknown',{speaker:'agent',provider:'gateway',model:'claude'}),reply('openai',{speaker:'agent',provider:'openai',model:'kimi'}),reply('future',{speaker:'agent',provider:'future',model:'codex'})]
  await settle()
  for(const id of ['unknown','openai','future']){
   const row=message(h,id)
   expect(row.querySelectorAll('.th-agent')).toHaveLength(1)
   expect(row.querySelector('.th-agent')?.getAttribute('data-agent')).toBe('service')
   expect(row.querySelector('.th-agent-mono')?.textContent).toBe('A')
   expect(row.querySelector('svg')).toBeNull()
   expect(row.querySelector('b')).toBeNull()
  }
  expect(message(h,'unknown').querySelector('.th-agents')?.getAttribute('aria-label')).toBe('编造 "服务" <b>')
  expect(message(h,'openai').querySelector('.th-agents')?.getAttribute('title')).toBe('自定义 AI 服务')
 })

 it('preserves each historical source across older pages and repeated refreshes when current settings change',async()=>{
  const h=fixture();h.response.messages=[reply('first',{speaker:'agent',provider:'claude'})];await settle()
  h.modelResponse.provider='codex';h.modelResponse.model='different-model'
  h.response.messages=[{...reply('older',{speaker:'agent',provider:'codex'}),at:0},reply('legacy')]
  await h.cRead(true);await h.cRead(false)
  expect(message(h,'first').querySelectorAll('.th-agent')).toHaveLength(1)
  expect(message(h,'first').querySelector('.th-agent')?.getAttribute('data-agent')).toBe('claude')
  expect(message(h,'older').querySelector('.th-agent')?.getAttribute('data-agent')).toBe('codex')
  expect(message(h,'legacy').querySelector('.th-agents')).toBeNull()
  expect(h.w.document.querySelectorAll('#message-first')).toHaveLength(1)
 })

 it('still renders attributed history if the optional provider-name read is unavailable',async()=>{
  const h=fixture();h.modelResponse.ok=false;h.response.messages=[reply('fallback',{speaker:'agent',provider:'claude'})];await settle()
  expect(message(h,'fallback').querySelectorAll('.th-agent')).toHaveLength(1)
  expect(message(h,'fallback').textContent).toContain('原始回复')
 })

 it('does not restore private messages when provider names arrive after device revocation',async()=>{
  const h=fixture(),release=h.deferNames();h.response.messages=[reply('private',{speaker:'agent',provider:'claude'})];await settle()
  expect(message(h,'private').querySelectorAll('.th-agent')).toHaveLength(1)
  h.cClearPrivate();release();await settle();await h.cRead()
  expect(h.w.document.getElementById('chat-messages')?.textContent).toBe('')
  expect(h.w.document.body.classList.contains('conversation-ready')).toBe(false)
 })
})

it('delegation references update once; old unlinked work is revealed only through waiting/search',async()=>{
 const h=fixture();await new Promise(r=>setTimeout(r,0))
 h.matters.push({id:'old',kind:'task',title:'以前的事',createdAt:1,updatedAt:2,state:'waiting'},{id:'linked',kind:'task',title:'查备份',originMessageId:'a',createdAt:1,updatedAt:2,state:'working'})
 h.cMatterUpdates();await new Promise(r=>setTimeout(r,0));expect(h.w.document.querySelectorAll('[data-reference]')).toHaveLength(1);expect(h.w.document.getElementById('chat-waiting')).toBeNull()
 h.matters[1].state='done';h.cMatterUpdates();await new Promise(r=>setTimeout(r,0));expect(h.w.document.querySelectorAll('[data-reference]')).toHaveLength(1);expect(h.w.document.getElementById('reference-linked')?.textContent).toContain('完成');expect(h.writes).toEqual([])
})

it('a successful send preserves the next draft typed while its receipt is in flight',async()=>{
 const h=fixture();await new Promise(r=>setTimeout(r,0));const input=h.w.document.getElementById('chat-input') as unknown as HTMLTextAreaElement;input.value='first';const release=h.deferSend(),sending=h.cSend({preventDefault(){}});input.value='next draft';release();await sending;expect(input.value).toBe('next draft')
})

it('revocation clears the active private transcript and stored device draft and prevents a subsequent private read',async()=>{
 const h=fixture();await new Promise(r=>setTimeout(r,0));const input=h.w.document.getElementById('chat-input') as unknown as HTMLTextAreaElement;input.value='private draft';input.dispatchEvent(new h.w.Event('input'));const reads=h.reads.length;h.cClearPrivate();await h.cRead();expect(h.reads).toHaveLength(reads);expect(h.w.document.getElementById('chat-messages')?.textContent).toBe('');expect(input.value).toBe('');expect(h.w.sessionStorage.length).toBe(0)
})

it('removing the configured owner clears the old transcript instead of retaining it as an available conversation',async()=>{
 const h=fixture();await new Promise(r=>setTimeout(r,0));h.response.ok=false;h.response.error='no_owner_chat';await h.cRead();expect(h.w.document.getElementById('chat-messages')?.textContent).toBe('');expect(h.w.document.body.classList.contains('conversation-ready')).toBe(false);expect(h.w.document.getElementById('chat-notice')?.textContent).toContain('还没设好主人对话')
})

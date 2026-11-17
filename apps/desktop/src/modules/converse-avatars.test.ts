// @vitest-environment happy-dom
import {afterEach,beforeEach,expect,it,vi} from 'vitest'

const settle=async()=>{for(let i=0;i<60;i++)await Promise.resolve()}
beforeEach(()=>{
  vi.resetModules();vi.useFakeTimers();localStorage.clear()
  document.body.innerHTML='<div id="converse-root"></div>'
  vi.stubGlobal('requestAnimationFrame',(fn:FrameRequestCallback)=>{fn(0);return 1})
})
afterEach(()=>{window.dispatchEvent(new Event('pagehide'));vi.clearAllTimers();vi.useRealTimers();vi.unstubAllGlobals();document.body.innerHTML=''})
const stored=(id:string,text:string,meta:Record<string,unknown>={})=>({messageId:id,kind:'text',text,createdAt:1,source:'desktop',...meta})
const row=(text:string)=>[...document.querySelectorAll('.converse-msg')].find(n=>n.textContent?.includes(text))!
// Frontend boundary mocks; native passthrough is separately covered by Rust unit tests.
// Browser mocks alone do not prove the packaged Tauri bridge.
async function mount(options:{messages?:any[],results?:any[],events?:any[],names?:()=>Promise<any>,legacy?:boolean}={}){
  const call=vi.fn(async(_method:string,path:string):Promise<any>=>{
    if(path==='/v1/protocol/capabilities')return options.legacy?{}:{routes:'v1',topics:'v1'}
    if(path==='/v1/matter/owner-chat/model')return options.names?options.names():{ok:true,providers:[{id:'claude',name:'Claude'},{id:'codex',name:'Codex'},{id:'openai',name:'我的网关'}]}
    if(path.includes('/window'))return {messages:options.messages??[],earlier:null,later:null,anchor:null}
    if(path.endsWith('/work'))return {references:[],results:options.results??[]}
    if(path.includes('/events'))return {running:options.events?.length?{turnId:'live'}:null,events:options.events??[],cursor:1}
    if(path==='/v1/matter/owner-chat')return {events:options.messages??[]}
    throw Error(path)
  })
  const invoke=vi.fn(async()=>({reply:'即时代答',speaker:'agent',provider:'codex',matterId:'attribution-only'}))
  const module=await import('./converse.js');module.initConversePage({invoke,invokeWorkbenchApi:call})
  await settle();return {call,invoke,module}
}

it('uses one shared named avatar only for attributed agent replies, including the generic gateway',async()=>{
  await mount({messages:[
    stored('a','Claude 代答',{speaker:'agent',provider:'claude'}),stored('b','Codex 代答',{speaker:'agent',provider:'codex'}),
    stored('c','网关代答',{speaker:'agent',provider:'openai',model:'claude-test'}),stored('d','未知服务',{speaker:'agent',provider:'future'}),
    stored('e','CC 本人',{speaker:'cc',provider:'claude'}),stored('f','通知',{speaker:'notice',provider:'codex'}),
    stored('g','旧消息',{provider:'codex'}),stored('h','空来源',{speaker:'agent',provider:'  '}),
    stored('i','你的话',{kind:'user',speaker:'agent',provider:'claude'}),stored('j','坏来源',{speaker:'agent',provider:42}),
  ]})
  for(const [text,id,name] of [['Claude 代答','claude','Claude'],['Codex 代答','codex','Codex'],['网关代答','service','我的网关'],['未知服务','service','future']]){
    const message=row(text!),avatar=message.querySelector('.th-agents')!
    expect(message.querySelectorAll('.th-agent')).toHaveLength(1)
    expect(avatar.getAttribute('role')).toBe('img');expect(avatar.getAttribute('aria-label')).toBe(name);expect(avatar.getAttribute('title')).toBe(name)
    expect(avatar.querySelector('.th-agent')?.getAttribute('data-agent')).toBe(id)
    expect(message.getAttribute('aria-label')).toBe(name)
  }
  expect(row('网关代答').querySelector('.th-agent svg')).toBeNull()
  expect(row('网关代答').querySelector('.th-agent-mono')?.textContent).toBe('A')
  expect(row('未知服务').querySelector('.th-agent-mono')?.textContent).toBe('A')
  for(const text of ['CC 本人','通知','旧消息','空来源','你的话','坏来源'])expect(row(text).querySelector('.th-agent')).toBeNull()
  expect(row('CC 本人').getAttribute('aria-label')).toBe('CC')
})

it('keeps late display names out of the text DOM and preserves history when current providers change',async()=>{
  let resolveNames!:(value:any)=>void
  const h=await mount({messages:[stored('a','已有代答',{speaker:'agent',provider:'claude'}),stored('old','已有旧消息'),stored('gateway','迟到网关名',{speaker:'agent',provider:'openai'})],names:()=>new Promise(resolve=>{resolveNames=resolve})})
  const message=row('已有代答'),bubble=message.querySelector('.converse-bubble')!,old=row('已有旧消息')
  expect(message.querySelector('.th-agents')?.getAttribute('aria-label')).toBe('claude')
  const gateway=row('迟到网关名'),generic=gateway.querySelector('.th-agent-mono')!
  expect(generic.textContent).toBe('A')
  resolveNames({ok:true,provider:'codex',providers:[{id:'claude',name:'Claude <自定>'},{id:'openai',name:'我的网关'}]});await settle()
  expect(row('已有代答')).toBe(message);expect(message.querySelector('.converse-bubble')).toBe(bubble)
  expect(message.querySelector('.th-agents')?.getAttribute('aria-label')).toBe('Claude <自定>')
  expect(message.querySelector('自定')).toBeNull();expect(row('已有旧消息')).toBe(old);expect(old.querySelector('.th-agent')).toBeNull()
  expect(row('迟到网关名')).toBe(gateway);expect(gateway.querySelector('.th-agent-mono')).toBe(generic)
  expect(generic.textContent).toBe('A');expect(gateway.querySelector('.th-agents')?.getAttribute('aria-label')).toBe('我的网关')
  await vi.advanceTimersByTimeAsync(6000);await settle()
  expect(row('已有代答').querySelector('.th-agent')?.getAttribute('data-agent')).toBe('claude')
  expect(h.call).toHaveBeenCalledWith('GET','/v1/matter/owner-chat/model')
})

it('preserves attribution through legacy history, immediate replies and optional name lookup failure',async()=>{
  await mount({legacy:true,messages:[stored('old','旧接口代答',{speaker:'agent',provider:'openai'})],names:async()=>{throw Error('offline')}})
  expect(row('旧接口代答').querySelector('.th-agents')?.getAttribute('aria-label')).toBe('openai')
  const input=document.querySelector<HTMLTextAreaElement>('#converse-input')!;input.value='说一句'
  document.querySelector<HTMLButtonElement>('#converse-send')!.click();await settle()
  expect(row('即时代答').querySelector('.th-agent')?.getAttribute('data-agent')).toBe('codex')
  expect(row('即时代答').querySelector('[data-matter-id]')).toBeNull()
})

it('uses each stream/result source and each mixed reply part without duplicating its attachments',async()=>{
  const mixed={reply:'第一家\n通知',speaker:undefined,attachments:[{kind:'voice',text:'另一家的语音'}],narration:['另一家的过程'],replyParts:[
    {speaker:'agent',provider:'codex',text:'第一家'},
    {speaker:'agent',provider:'claude',text:'',attachmentIndexes:[0],narrationIndexes:[0]},
    {speaker:'notice',provider:'codex',text:'通知'},
  ]}
  const h=await mount({legacy:true,messages:[],results:[]})
  h.invoke.mockResolvedValueOnce(mixed as any)
  document.querySelector<HTMLTextAreaElement>('#converse-input')!.value='问两家'
  document.querySelector<HTMLButtonElement>('#converse-send')!.click();await settle()
  expect(row('第一家').querySelector('.th-agent')?.getAttribute('data-agent')).toBe('codex')
  expect(row('另一家的语音').querySelector('.th-agent')?.getAttribute('data-agent')).toBe('claude')
  expect(row('通知').querySelector('.th-agent')).toBeNull()
  expect(document.querySelectorAll('.converse-att-voice')).toHaveLength(1)
})

it('renders stored mixed parts, live replies and returned results using their own sources',async()=>{
  await mount({messages:[stored('parts','历史第一家\n历史第二家',{replyParts:[{text:'历史第一家',speaker:'agent',provider:'claude'},{text:'历史第二家',speaker:'agent',provider:'codex'}]})],
    results:[{id:'result',text:'带回的原始结果',createdAt:2,speaker:'agent',provider:'claude',matterId:'work'}],
    events:[{id:'event',turnId:'live',kind:'agent_message',text:'实时代答',createdAt:3,speaker:'agent',provider:'codex'}]})
  for(const [text,provider] of [['历史第一家','claude'],['历史第二家','codex'],['带回的原始结果','claude'],['实时代答','codex']]){
    expect(row(text!).querySelector('.th-agent')?.getAttribute('data-agent')).toBe(provider)
    expect(row(text!).querySelector('small')?.textContent??'').not.toContain('CC')
  }
})

it('remaps filtered mixed media and opens history files by their original attachment index',async()=>{
  const h=await mount({messages:[stored('media','合并正文',{replyExtras:{
    attachments:[null,{kind:'voice',text:'语音正文'},{kind:'invalid'},{kind:'file',name:'原始索引.pdf'}],
    narration:[null,'', '属于 Claude 的过程'],
  },replyParts:[
    {text:'先答',speaker:'agent',provider:'codex'},
    {text:'',speaker:'agent',provider:'claude',attachmentIndexes:[1,3,3],narrationIndexes:[2]},
  ]})]})
  expect(row('语音正文').querySelector('.th-agent')?.getAttribute('data-agent')).toBe('claude')
  expect(row('属于 Claude 的过程').querySelector('.th-agent')?.getAttribute('data-agent')).toBe('claude')
  expect(document.querySelectorAll('.converse-att-voice')).toHaveLength(1)
  expect(document.querySelectorAll('.converse-att-file')).toHaveLength(1)
  expect(document.querySelectorAll('.converse-process-lines li')).toHaveLength(1)
  expect(document.querySelector('#converse-scroll')?.textContent).not.toContain('合并正文')
  document.querySelector<HTMLButtonElement>('.converse-history-file')!.click();await settle()
  expect(h.call).toHaveBeenCalledWith('GET','/v1/matter/owner-chat/file?id=media&i=3&offset=0')
})

it('updates same-id history attribution and parts without repainting unrelated messages',async()=>{
  const current=stored('same','正文不变'),other=stored('other','保留正文节点')
  await mount({messages:[current,other]})
  const stable=row('保留正文节点'),old=row('正文不变')
  Object.assign(current,{speaker:'agent',provider:'claude'})
  await vi.advanceTimersByTimeAsync(6000);await settle()
  expect(row('正文不变')).not.toBe(old)
  expect(row('正文不变').querySelector('.th-agent')?.getAttribute('data-agent')).toBe('claude')
  Object.assign(current,{provider:'codex'})
  await vi.advanceTimersByTimeAsync(6000);await settle()
  expect(row('正文不变').querySelector('.th-agent')?.getAttribute('data-agent')).toBe('codex')
  Object.assign(current,{replyParts:[{text:'正文不变',speaker:'agent',provider:'claude'}]})
  await vi.advanceTimersByTimeAsync(6000);await settle()
  expect(row('正文不变').querySelector('.th-agent')?.getAttribute('data-agent')).toBe('claude')
  expect(row('保留正文节点')).toBe(stable)
})

it('keeps the truncation marker on stored mixed reply parts',async()=>{
  await mount({messages:[stored('truncated','历史长回复',{truncated:true,replyParts:[{text:'被裁剪的第一家',truncated:true,speaker:'agent',provider:'claude'},{text:'第二家',speaker:'agent',provider:'codex'}]})]})
  expect(row('被裁剪的第一家').querySelector('.converse-bubble')?.textContent).toContain('被裁剪的第一家…')
})

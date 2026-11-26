import { describe, it, expect } from 'vitest'
import { gateTool } from './openai/openai-gate'
import { makeCanUseTool } from './claude/permission-relay'
import { makeGeminiToolGate } from './gemini/gemini-agent-provider'
import { TIER_PROFILES } from '../../domain/user-tier'
import {prepareChatApprovalPrompt} from './chat-approval'

it.each(['Claude','OpenAI','Gemini','Codex'])('%s shows one executor on the shared card without promising relay',async provider=>{
  const { prompt }=await prepareChatApprovalPrompt(provider,'mcp__wechat__matter_plan',{title:'整理插图',project:'relay-lab',legs:[{executor:'codex',brief:'整理插图文件'}]},'single',{
    resolveMatterPlan:()=>({target:{kind:'project',projectId:'p-0123456789abcdef0123'},projectName:'relay-lab',projectPath:'/offline/project'}),
  },'owner')
  expect(prompt).toContain('第 1 棒 · codex：整理插图文件')
  expect(prompt).not.toContain('第 2 棒')
  expect(prompt).toContain('relay-lab（/offline/project）')
  expect(prompt).toContain('批准后开工')
  expect(prompt).not.toContain('按此顺序接力')
})

const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic
const cases = [
  { label: 'credential fields, URL auth and headers', input: { id: '__offline_action__', api_key: '__offline_secret_value__', url: 'https://offline:__offline_url_password__@example.invalid/?token=__offline_url_token__', headers: [{ name: 'Authorization', value: 'Bearer __offline_header_secret__' }] }, shown: '__offline_action__' },
  { label: 'long input', input: { id: '__offline_action__', note: 'x'.repeat(6000) }, shown: '__offline_action__' },
  { label: 'oversized input', input: { note: 'x'.repeat(25000) }, shown: 'omitted' },
  { label: 'cyclic input', input: cyclic, shown: 'omitted' },
]
for (const provider of ['Claude', 'OpenAI', 'Gemini']) describe(`${provider} shared approval preview`, () => {
  it('shows all six ordered plan legs on one approval card and denying never authorizes',async()=>{
    const cards:string[]=[],input={target:{kind:'managed'},title:'插图',legs:Array.from({length:6},(_,i)=>({executor:`worker-${i+1}`,brief:`第${i+1}项工作 https://example.invalid/?authorization=__offline_secret_query__ `+'资料 '.repeat(400)}))}
    const askUser=async(_chat:string,prompt:string)=>{cards.push(prompt);return 'deny' as const}
    if(provider==='OpenAI')expect(await gateTool({toolName:'matter_plan',mcpServer:'wechat',input,tierProfile:TIER_PROFILES.admin,permissionMode:'strict',chatId:'owner',approval:{askUser,adminFor:()=>'owner'}})).toMatchObject({decision:'deny'})
    else if(provider==='Claude')await makeCanUseTool({askUser,initiatingChatId:()=>'owner',adminChatId:()=>'owner',resolveTier:()=>'admin',log:()=>{},mode:()=>'solo',provider:'claude',permissionMode:'strict'})('mcp__wechat__matter_plan',input,{signal:new AbortController().signal,toolUseID:'plan'} as any)
    else await makeGeminiToolGate({askUser,adminFor:()=>'owner',modeFor:()=>'solo',lookupBase:()=>({askUser:'per-tool'})})({tierProfile:TIER_PROFILES.admin,permissionMode:'strict',chatId:'owner'})('matter_plan',input)
    expect(cards).toHaveLength(1)
    for(let i=1;i<=6;i++){expect(cards[0]).toContain(`第 ${i} 棒`);expect(cards[0]).toContain(`worker-${i}`);expect(cards[0]).toContain(`第${i}项工作`)}
    expect(cards[0]!.length).toBeLessThanOrEqual(2000)
    expect(cards[0]).not.toContain('__offline_secret_query__')
  })
  it.each(cases)('$label', async ({ input, shown }) => {
    const cards: string[] = []
    const askUser = async (_chat: string, prompt: string) => { cards.push(prompt); return 'deny' as const }
    if (provider === 'OpenAI') await gateTool({ toolName: 'matter_handoff', mcpServer: 'wechat', input, tierProfile: TIER_PROFILES.admin, permissionMode: 'strict', chatId: 'owner', approval: { askUser, adminFor: () => 'owner' } })
    else if (provider === 'Claude') await makeCanUseTool({ askUser, initiatingChatId: () => 'owner', adminChatId: () => 'owner', resolveTier: () => 'admin', log: () => {}, mode: () => 'solo', provider: 'claude', permissionMode: 'strict' })('mcp__wechat__matter_handoff', input, { signal: new AbortController().signal, toolUseID: 'render', title: 'Authorization: Bearer __offline_title_secret__' } as any)
    else await makeGeminiToolGate({ askUser, adminFor: () => 'owner', modeFor: () => 'solo', lookupBase: () => ({ askUser: 'per-tool' }) })({ tierProfile: TIER_PROFILES.admin, permissionMode: 'strict', chatId: 'owner' })('matter_handoff', input)
    expect(cards).toHaveLength(1)
    expect(cards[0]!.length).toBeLessThanOrEqual(2000)
    expect(cards[0]).toContain('matter_handoff')
    expect(cards[0]).toContain(shown)
    for (const secret of ['__offline_secret_value__', '__offline_url_password__', '__offline_url_token__', '__offline_header_secret__', '__offline_title_secret__']) expect(cards[0]).not.toContain(secret)
  })
})

for(const provider of ['Claude','OpenAI','Gemini'])it(`${provider} resolves the target before approval and pins the shown project`,async()=>{
 const {resolvePlanTarget}=await import('../workbench/matter-plan-input')
 const cards:string[]=[],input={project:'RELAY-LAB',title:'整理',legs:[{executor:'claude',brief:'先做'},{executor:'openai',brief:'后做'}]}
 const catalog=[{id:'p-0123456789abcdef0123',name:'relay-lab',path:'/offline/registered-project',providerId:'claude'}]
 const channel={askUser:async(_chat:string,prompt:string)=>{cards.push(prompt);return 'allow' as const},resolveMatterPlan:(args:unknown)=>resolvePlanTarget(args as never,catalog)}
 if(provider==='OpenAI')expect(await gateTool({toolName:'matter_plan',mcpServer:'wechat',input,tierProfile:TIER_PROFILES.admin,permissionMode:'strict',chatId:'owner',approval:{...channel,adminFor:()=>'owner'}})).toMatchObject({decision:'allow'})
 else if(provider==='Claude')expect(await makeCanUseTool({...channel,initiatingChatId:()=>'owner',adminChatId:()=>'owner',resolveTier:()=>'admin',log:()=>{},mode:()=>'solo',provider:'claude',permissionMode:'strict'})('mcp__wechat__matter_plan',input,{signal:new AbortController().signal,toolUseID:'plan'} as any)).toMatchObject({behavior:'allow'})
 else expect(await makeGeminiToolGate({...channel,adminFor:()=>'owner',modeFor:()=>'solo',lookupBase:()=>({askUser:'per-tool'})})({tierProfile:TIER_PROFILES.admin,permissionMode:'strict',chatId:'owner'})('matter_plan',input)).toMatchObject({allow:true})
 expect(cards).toHaveLength(1)
 expect(cards[0]).toContain('relay-lab')
 expect(cards[0]).toContain('/offline/registered-project')
 expect(input).toMatchObject({target:{kind:'project',projectId:'p-0123456789abcdef0123'}})
 expect(input).not.toHaveProperty('project')
})

it('resolved approval still distinguishes isolated workspaces and their base branch',async()=>{
 const {prepareChatApprovalPrompt}=await import('./chat-approval')
 const { prompt }=await prepareChatApprovalPrompt('OpenAI','mcp__wechat__matter_plan',{title:'整理',legs:[{executor:'claude',brief:'先做'},{executor:'openai',brief:'后做'}]},'test',{
  resolveMatterPlan:()=>({target:{kind:'project',projectId:'p-0123456789abcdef0123',isolation:'worktree',base:'dev'},projectName:'relay-lab',projectPath:'/offline/project'}),
 },'owner')
 expect(prompt).toContain('独立工作区')
 expect(prompt).toContain('dev')
})

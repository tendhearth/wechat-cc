import { describe, it, expect } from 'vitest'
import { gateTool } from './openai/openai-gate'
import { makeCanUseTool } from './claude/permission-relay'
import { makeGeminiToolGate } from './gemini/gemini-agent-provider'
import { TIER_PROFILES } from '../../domain/user-tier'

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

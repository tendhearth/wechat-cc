import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMcpToolBridge } from './openai/openai-mcp-bridge'
import { connectWechatMcp } from './gemini/gemini-agent-provider'
import { buildOpenaiMcpSpecs, matterStdioMcpSpec } from '../../daemon/bootstrap/mcp-specs'
import { builtinTools } from './openai/openai-tools'

const dirs: string[] = []
afterEach(() => { vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function fixture(expectedToken: string) {
  const dir = mkdtempSync(join(tmpdir(), 'token-mcp-')); dirs.push(dir)
  const entry = join(dir, 'offline.cjs')
  writeFileSync(entry, `
const {writeFileSync}=require('node:fs');
const rl=require('node:readline').createInterface({input:process.stdin});
writeFileSync(process.argv[2], JSON.stringify({argvLeak:process.argv.some(v=>v.includes('SECRET_CANARY')),hasToken:Object.hasOwn(process.env,'WECHAT_SESSION_TOKEN'),hasTier:Object.hasOwn(process.env,'WECHAT_SESSION_TIER'),tokenMatchesExpected:process.env.WECHAT_SESSION_TOKEN===${JSON.stringify(expectedToken)}}));
rl.on('line',line=>{const m=JSON.parse(line); if(m.id===undefined)return;
let result=m.method==='initialize'?{protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'offline',version:'1'}}:{tools:[]};
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});
`)
  vi.stubEnv('WECHAT_SESSION_TOKEN', 'MCP_AMBIENT_SECRET_CANARY')
  vi.stubEnv('WECHAT_SESSION_TIER', 'admin')
  const spec = (name: string) => ({ command: process.execPath, args: [entry, join(dir, name + '.json')] })
  const snapshot = (name: string): { argvLeak: boolean; hasToken: boolean; hasTier: boolean; tokenMatchesExpected: boolean } => JSON.parse(readFileSync(join(dir, name + '.json'), 'utf8'))
  return { spec, snapshot, dir }
}

it('OpenAI bridge spawns core MCP with private env, never argv; plugin general env has no token', async () => {
  const f = fixture('CORE_MCP_SECRET_CANARY')
  const bridge = await createMcpToolBridge(buildOpenaiMcpSpecs({ wechat: f.spec('wechat'), delegate: f.spec('delegate'), pluginMcp: { plugin: f.spec('plugin') } }, { WECHAT_SESSION_TOKEN: 'CORE_MCP_SECRET_CANARY' }))
  try {
    for (const name of ['wechat', 'delegate', 'plugin']) expect(f.snapshot(name).argvLeak).toBe(false)
    expect(f.snapshot('wechat').tokenMatchesExpected).toBe(true)
    expect(f.snapshot('delegate').tokenMatchesExpected).toBe(true)
    expect(f.snapshot('plugin').hasToken).toBe(false)
    expect(f.snapshot('plugin').hasTier).toBe(false)
  } finally { await bridge.close() }
})

it('Gemini MCP spawn keeps session token out of argv and never inherits an ambient credential', async () => {
  const f = fixture('GEMINI_SESSION_SECRET_CANARY')
  const core = await connectWechatMcp(f.spec('core'), { WECHAT_SESSION_TOKEN: 'GEMINI_SESSION_SECRET_CANARY' })
  try {
    expect(f.snapshot('core').argvLeak).toBe(false)
    expect(f.snapshot('core').tokenMatchesExpected).toBe(true)
    expect(f.snapshot('core').hasTier).toBe(false)
  } finally { await core.close() }
  const bare = await connectWechatMcp(f.spec('bare'))
  try {
    expect(f.snapshot('bare').hasToken).toBe(false)
    expect(f.snapshot('bare').hasTier).toBe(false)
  } finally { await bare.close() }
})

it('workbench OpenAI matter child gets its own baton while generic MCP children inherit neither session credential', async () => {
  const token='MATTER_BATON_SECRET_CANARY'
  const f=fixture(token)
  const matter=matterStdioMcpSpec({baseUrl:'http://127.0.0.1:1'})
  const bridge=await createMcpToolBridge({
    'wechat-cc-matter':{...matter,...f.spec('matter'),env:{...matter.env,WECHAT_SESSION_TOKEN:token}},
    generic:f.spec('generic'),
  })
  try{
    expect(f.snapshot('matter')).toEqual({argvLeak:false,hasToken:true,hasTier:false,tokenMatchesExpected:true})
    expect(f.snapshot('generic')).toEqual({argvLeak:false,hasToken:false,hasTier:false,tokenMatchesExpected:false})
  }finally{await bridge.close()}
})

it('OpenAI model Bash (also used by bare delegates) spawns with token-free argv and general env', async () => {
  const f = fixture('unused')
  const script = join(f.dir, 'shell.cjs')
  writeFileSync(script, `process.stdout.write(JSON.stringify({leaked:!!process.env.WECHAT_SESSION_TOKEN,tierLeaked:Object.hasOwn(process.env,'WECHAT_SESSION_TIER'),argvLeak:process.argv.some(v=>v.includes('SECRET_CANARY'))}))`)
  const quote = (value: string) => process.platform === 'win32'
    ? '"' + value.replaceAll('"', '""') + '"'
    : "'" + value.replaceAll("'", "'\\''") + "'"
  const bash = builtinTools(f.dir).find(t => t.spec.name === 'Bash')!
  const result = JSON.parse(await bash.execute({ command: `${quote(process.execPath)} ${quote(script)}` }))
  expect(result).toEqual({ leaked: false, tierLeaked: false, argvLeak: false })
})

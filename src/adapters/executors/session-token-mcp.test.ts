import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMcpToolBridge } from './openai/openai-mcp-bridge'
import { connectWechatMcp } from './gemini/gemini-agent-provider'
import { buildOpenaiMcpSpecs } from '../../daemon/bootstrap/mcp-specs'
import { builtinTools } from './openai/openai-tools'

const dirs: string[] = []
afterEach(() => { vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'token-mcp-')); dirs.push(dir)
  const entry = join(dir, 'offline.cjs')
  writeFileSync(entry, `
const {writeFileSync}=require('node:fs');
const rl=require('node:readline').createInterface({input:process.stdin});
writeFileSync(process.argv[2], JSON.stringify({argv:process.argv, token:process.env.WECHAT_SESSION_TOKEN??null}));
rl.on('line',line=>{const m=JSON.parse(line); if(m.id===undefined)return;
let result=m.method==='initialize'?{protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'offline',version:'1'}}:{tools:[]};
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});
`)
  vi.stubEnv('WECHAT_SESSION_TOKEN', 'MCP_AMBIENT_SECRET_CANARY')
  const spec = (name: string) => ({ command: process.execPath, args: [entry, join(dir, name + '.json')] })
  const snapshot = (name: string): { argv: string[]; token: string | null } => JSON.parse(readFileSync(join(dir, name + '.json'), 'utf8'))
  return { spec, snapshot, dir }
}

it('OpenAI bridge spawns core MCP with private env, never argv; plugin general env has no token', async () => {
  const f = fixture()
  const bridge = await createMcpToolBridge(buildOpenaiMcpSpecs({ wechat: f.spec('wechat'), delegate: f.spec('delegate'), pluginMcp: { plugin: f.spec('plugin') } }, { WECHAT_SESSION_TOKEN: 'CORE_MCP_SECRET_CANARY' }))
  try {
    for (const name of ['wechat', 'delegate', 'plugin']) expect(f.snapshot(name).argv.some(v => v.includes('SECRET_CANARY'))).toBe(false)
    expect(f.snapshot('wechat').token).toBe('CORE_MCP_SECRET_CANARY')
    expect(f.snapshot('delegate').token).toBe('CORE_MCP_SECRET_CANARY')
    expect(f.snapshot('plugin').token).toBeNull()
  } finally { await bridge.close() }
})

it('Gemini MCP spawn keeps session token out of argv and never inherits an ambient credential', async () => {
  const f = fixture()
  const core = await connectWechatMcp(f.spec('core'), { WECHAT_SESSION_TOKEN: 'GEMINI_SESSION_SECRET_CANARY' })
  try {
    expect(f.snapshot('core').argv.some(v => v.includes('SECRET_CANARY'))).toBe(false)
    expect(f.snapshot('core').token).toBe('GEMINI_SESSION_SECRET_CANARY')
  } finally { await core.close() }
  const bare = await connectWechatMcp(f.spec('bare'))
  try { expect(f.snapshot('bare').token).toBeNull() } finally { await bare.close() }
})

it('OpenAI model Bash (also used by bare delegates) spawns with token-free argv and general env', async () => {
  const f = fixture()
  const script = join(f.dir, 'shell.cjs')
  writeFileSync(script, `process.stdout.write(JSON.stringify({leaked:!!process.env.WECHAT_SESSION_TOKEN,argvLeak:process.argv.some(v=>v.includes('SECRET_CANARY'))}))`)
  const quote = (value: string) => process.platform === 'win32'
    ? '"' + value.replaceAll('"', '""') + '"'
    : "'" + value.replaceAll("'", "'\\''") + "'"
  const bash = builtinTools(f.dir).find(t => t.spec.name === 'Bash')!
  const result = JSON.parse(await bash.execute({ command: `${quote(process.execPath)} ${quote(script)}` }))
  expect(result).toEqual({ leaked: false, argvLeak: false })
})

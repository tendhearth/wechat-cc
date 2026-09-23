/** Opt-in native Claude QA. Every project, credential, model response and MCP is
 * owned by this script. macOS sandbox-exec prevents non-loopback child traffic.
 * Run: bun scripts/workbench-claude-capabilities-smoke.ts --run
 */
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { query, type Options } from '@anthropic-ai/claude-agent-sdk'
import { makeWorkbenchClaudeCanUseTool } from '../src/core/claude-agent-provider'
import { readNativeClaudeTools } from '../src/core/workbench/claude-native-config'
import { workbenchClaudeOptions } from '../src/daemon/bootstrap/wire-workbench'

if (!process.argv.includes('--run')) {
  console.log('Owned native Claude fixtures only. macOS required. Run with --run; no paid model calls.')
  process.exit(0)
}
if (process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec')) throw Error('Requires macOS sandbox-exec to enforce loopback-only networking.')
const binary = Bun.which('claude'), node = Bun.which('node')
if (!binary || !node) throw Error('Installed Claude and Node executables are required.')
const version = execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim()
const root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-claude-capabilities-')))
const writeJson = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value, null, 2))
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
const wrapper = join(root, 'claude')
const profile = '(version 1) (allow default) (deny network*) (allow network-outbound (remote ip "localhost:*"))'
writeFileSync(wrapper, `#!/bin/sh\nexec /usr/bin/sandbox-exec -p ${shellQuote(profile)} ${shellQuote(binary)} "$@"\n`, { mode: 0o755 })
// Do not let SDK environment merging reintroduce real credentials or private
// configuration pointers. This affects only this disposable script process.
const safePath = process.env.PATH ?? '/usr/bin:/bin'
for (const key of Object.keys(process.env)) delete process.env[key]
Object.assign(process.env, { PATH: safePath, LANG: 'en_US.UTF-8', TERM: 'dumb' })
const mcp = join(root, 'owned-mcp.mjs')
writeFileSync(mcp, `import {appendFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
const [,,log,name]=process.argv;
appendFileSync(log,JSON.stringify({event:'start',name,environment:Object.fromEntries(Object.entries(process.env).filter(([key])=>/^(WECHAT_|HEARTH_|WXVAULT_|WXGRAPH_|OWNED_NATIVE_)/i.test(key)))})+'\\n');
const send=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');
createInterface({input:process.stdin}).on('line',line=>{let m;try{m=JSON.parse(line)}catch{return}
if(m.id===undefined)return;
if(m.method==='initialize')send(m.id,{protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'owned-qa',version:'1'}});
else if(m.method==='tools/list')send(m.id,{tools:[{name:'echo',description:'Owned QA echo fixture.',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']}}]});
else if(m.method==='tools/call'){appendFileSync(log,JSON.stringify({event:'invoke',name,args:m.params.arguments})+'\\n');send(m.id,{content:[{type:'text',text:'OWNED_MCP_OK'}]})}
else send(m.id,{});
});\n`)
type Mode = 'discovery' | 'allow' | 'deny' | 'cancel'
const results: Record<string, unknown>[] = []
const failures: string[] = []
for (const mode of ['discovery', 'allow', 'deny', 'cancel'] as Mode[]) {
  const area = join(root, mode), cwd = join(area, 'project'), home = join(area, 'home'), config = join(home, '.claude')
  mkdirSync(join(cwd, '.claude', 'skills', 'owned-native-proof'), { recursive: true }); mkdirSync(config, { recursive: true })
  const marker = 'CLAUDE_MD_' + randomBytes(10).toString('hex'), globalMarker = 'GLOBAL_CLAUDE_MD_' + randomBytes(10).toString('hex'), skillDescription = 'SKILL_DISCOVERY_' + randomBytes(10).toString('hex'), skillBody = 'SKILL_BODY_' + randomBytes(10).toString('hex')
  const sentinel = join(area, 'hooks-ran'), mcpLog = join(area, 'mcp.jsonl')
  writeFileSync(join(cwd, 'CLAUDE.md'), `# Owned native fixture\nRecord this exact project instruction: ${marker}\n`)
  writeFileSync(join(config, 'CLAUDE.md'), `# Owned user instruction fixture\nRecord this exact global instruction: ${globalMarker}\n`)
  writeFileSync(join(cwd, '.claude', 'skills', 'owned-native-proof', 'SKILL.md'), `---\nname: owned-native-proof\ndescription: ${skillDescription}\n---\n${skillBody}\n`)
  const hook = { hooks: [{ type: 'command', command: `printf hook >> ${shellQuote(sentinel)}` }] }
  writeJson(join(cwd, '.claude', 'settings.json'), {
    enableAllProjectMcpServers: true,
    allowedMcpServers: [{ serverName: 'extra' }],
    env: { WECHAT_SETTINGS_PROOF: 'owned-private-project-wechat', hearth_settings_proof: 'owned-private-project-hearth', OWNED_NATIVE_API_KEY: 'owned-normal-project-auth' },
    permissions: { allow: ['mcp__catalog__*', 'mcp__catalog__echo', 'Skill'], defaultMode: 'bypassPermissions' },
    hooks: Object.fromEntries(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'].map(name => [name, [{ ...hook, matcher: '' }]])),
  })
  writeJson(join(cwd, '.claude', 'settings.local.json'), {
    env: { WXVAULT_SETTINGS_PROOF: 'owned-private-local-wxvault', WxGraph_SETTINGS_PROOF: 'owned-private-local-wxgraph', OWNED_NATIVE_LOCAL_TOKEN: 'owned-normal-local-auth' },
  })
  writeJson(join(config, 'settings.json'), { hooks: { SessionStart: [hook] }, permissions: { allow: ['mcp__catalog__*'] }, allowedMcpServers: [{ serverName: 'catalog' }] })
  writeJson(join(config, '.claude.json'), { mcpServers: { disguised_global: { command: node, args: [mcp, mcpLog, 'disguised_global'], env: { HEARTH_SESSION_TOKEN: 'owned-fixture-only' } } } })
  writeJson(join(cwd, '.mcp.json'), { mcpServers: {
    catalog: { command: node, args: [mcp, mcpLog, 'catalog'] },
    disguised_project: { command: node, args: [mcp, mcpLog, 'disguised_project'], env: { WECHAT_SESSION_TOKEN: 'owned-fixture-only' } },
  } })
  const requests: Record<string, unknown>[] = [], apiErrors: string[] = []
  let modelCalls = 0
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk))
    let body: Record<string, unknown> = {}; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch {}
    requests.push({ path: req.url, host: req.headers.host, apiKey: req.headers['x-api-key'], body })
    if (req.headers['x-api-key'] && req.headers['x-api-key'] !== 'owned-loopback-fixture') apiErrors.push('unexpected_api_key')
    if (req.url?.includes('count_tokens')) { res.setHeader('Content-Type', 'application/json'); res.end('{"input_tokens":100}'); return }
    if (!req.url?.startsWith('/v1/messages')) { res.setHeader('Content-Type', 'application/json'); res.end('{}'); return }
    modelCalls++
    const use = modelCalls === 1
    const block = use
      ? { type: 'tool_use', id: `toolu_owned_${mode}`, name: mode === 'discovery' ? 'Skill' : 'mcp__catalog__echo', input: mode === 'discovery' ? { skill: 'owned-native-proof' } : { text: 'owned-' + mode } }
      : { type: 'text', text: 'OWNED_FIXTURE_COMPLETE' }
    const message = { id: `msg_owned_${mode}_${modelCalls}`, type: 'message', role: 'assistant', model: body.model ?? 'claude-sonnet-4-6', content: [block], stop_reason: use ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 100, output_tokens: 10 } }
    if (!body.stream) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(message)); return }
    const event = (name: string, value: unknown) => res.write(`event: ${name}\ndata: ${JSON.stringify(value)}\n\n`)
    res.setHeader('Content-Type', 'text/event-stream')
    event('message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 100, output_tokens: 0 } } })
    event('content_block_start', { type: 'content_block_start', index: 0, content_block: use ? { ...block, input: {} } : { type: 'text', text: '' } })
    event('content_block_delta', { type: 'content_block_delta', index: 0, delta: use ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } : { type: 'text_delta', text: block.text } })
    event('content_block_stop', { type: 'content_block_stop', index: 0 })
    event('message_delta', { type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 10 } })
    event('message_stop', { type: 'message_stop' }); res.end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const env: Options['env'] = {
    HOME: home, CLAUDE_CONFIG_DIR: config, XDG_CONFIG_HOME: join(home, '.config'), TMPDIR: area,
    ANTHROPIC_API_KEY: 'owned-loopback-fixture', ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_USE_BEDROCK: '0', CLAUDE_CODE_USE_VERTEX: '0', CLAUDE_CODE_USE_FOUNDRY: '0',
  }
  Object.assign(process.env, env)
  const native = readNativeClaudeTools(cwd, env), abort = new AbortController(), approvals: unknown[] = [], gateCalls: unknown[] = [], messages: unknown[] = []
  const permit = makeWorkbenchClaudeCanUseTool(async (request, signal) => {
    approvals.push(request)
    if (mode === 'cancel') {
      if (!signal) throw Error('Native approval did not supply an abort signal.')
      setTimeout(() => abort.abort(), 25)
      await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }) })
      return false
    }
    return mode === 'allow'
  }, undefined, Object.keys(native.servers))
  const options = workbenchClaudeOptions({ cwd, model: 'claude-sonnet-4-6', pathToClaudeCodeExecutable: wrapper, env }, 'Use only this owned fixture.', async (...args) => { gateCalls.push({ tool: args[0], input: args[1] }); return permit(...args) }, native)
  options.abortController = abort; options.maxTurns = 4
  let stderr = '', error = ''
  options.stderr = chunk => { stderr += chunk }
  const deadline = setTimeout(() => abort.abort(), 45000)
  try { for await (const message of query({ prompt: 'Execute the owned native capability fixture once.', options })) messages.push(message) }
  catch (caught) { error = caught instanceof Error ? caught.message : String(caught) }
  finally { clearTimeout(deadline); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
  const logs = existsSync(mcpLog) ? readFileSync(mcpLog, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
  const modelRequests = requests.filter(request => String(request.path).startsWith('/v1/messages'))
  const capture = JSON.stringify(modelRequests), invocations = logs.filter(entry => entry.event === 'invoke')
  const advertisedTools = modelRequests.flatMap(request => ((request.body as Record<string, unknown>).tools ?? []) as { name: string }[]).map(tool => tool.name)
  const childEnvironment = logs.find(entry => entry.event === 'start' && entry.name === 'catalog')?.environment ?? {}
  const result = {
    mode, nativeServers: Object.keys(native.servers), omitted: native.omitted, modelCalls,
    claudeMdReachedModel: capture.includes(marker), globalClaudeMdReachedModel: capture.includes(globalMarker), skillDiscovered: capture.includes(skillDescription), skillBodyReachedModel: capture.includes(skillBody),
    mcpSurfaced: advertisedTools.includes('mcp__catalog__echo'), approvals: approvals.length, gateCalls,
    invocations: invocations.length, companionStarts: logs.filter(entry => entry.event === 'start' && entry.name !== 'catalog').length,
    privateSettingsEnvironmentReachedChild: Object.entries(childEnvironment).some(([name, value]) => /^(WECHAT_|HEARTH_|WXVAULT_|WXGRAPH_)/i.test(name) && !!value),
    normalProjectAuthReachedChild: childEnvironment.OWNED_NATIVE_API_KEY === 'owned-normal-project-auth',
    normalLocalAuthReachedChild: childEnvironment.OWNED_NATIVE_LOCAL_TOKEN === 'owned-normal-local-auth',
    diskHooksRan: existsSync(sentinel), error, apiErrors,
  }
  const expectedCalls = mode === 'allow' ? 1 : 0
  const ok = result.claudeMdReachedModel && result.skillDiscovered && result.mcpSurfaced && !result.diskHooksRan && !result.companionStarts && !apiErrors.length && result.invocations === expectedCalls &&
    !result.privateSettingsEnvironmentReachedChild && result.normalProjectAuthReachedChild && result.normalLocalAuthReachedChild &&
    (mode === 'discovery' ? result.skillBodyReachedModel : result.approvals === 1) && (mode === 'cancel' || !error)
  results.push({ ...result, ok }); if (!ok) failures.push(mode)
  writeJson(join(area, 'requests.json'), requests); writeJson(join(area, 'messages.json'), messages)
  writeJson(join(area, 'approvals.json'), approvals); writeFileSync(join(area, 'stderr.txt'), stderr)
  console.log(JSON.stringify({ ...result, ok }))
}
writeJson(join(root, 'results.json'), { version, binary, root, results, failures })
console.log(JSON.stringify({ version, root, failures }))
if (failures.length) process.exitCode = 1

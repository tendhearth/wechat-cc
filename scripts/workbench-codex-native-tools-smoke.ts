import {MANAGED_NATIVE_CAPABILITIES} from '../src/core/workbench/executor-capabilities'
/** Explicit, offline native-protocol smoke: only temporary CC-owned MCP servers
 * and a local fake Responses endpoint are started. No user configuration or
 * provider account is used. Run: bun scripts/workbench-codex-native-tools-smoke.ts */
import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent, AgentProvider, AgentSession, SpawnContext } from '../src/core/agent-provider'
import { createProviderRegistry } from '../src/core/provider-registry'
import { createWorkbenchCodexProvider } from '../src/core/workbench/codex-app-server'
import { makeWorkbenchService } from '../src/core/workbench/service'
import { makeWorkbenchStore } from '../src/core/workbench/store'
import { TIER_PROFILES } from '../src/core/user-tier'
import { openDb } from '../src/lib/db'
import { findCodexBinary } from '../src/lib/find-codex-binary'

const binary = process.argv[2] || findCodexBinary()
if (!binary) throw Error('Install Codex 0.153.4 or newer to run this isolated smoke.')
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
const countLines = async (path: string) => (await readFile(path, 'utf8').catch(() => '')).split('\n').filter(Boolean).length

async function waitFor(label: string, ready: () => boolean, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (!ready()) {
    assert(Date.now() < deadline, `Timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

/** Drive the same native fixture through the actual task store/service and
 * synthetic inbound phone commands. No channel transport or provider mock. */
async function verifyWechat(provider: AgentProvider, directory: string, calls: string, companion: string, modelRequests: () => number) {
  const db = openDb({ path: join(directory, 'workbench.db') }), store = makeWorkbenchStore(db)
  const registry = createProviderRegistry(), owner = 'owned-offline-chat'
  registry.register('codex', provider, { workbench: MANAGED_NATIVE_CAPABILITIES, displayName: 'Codex', canResume: () => true })
  const service = makeWorkbenchService({ store, registry, stateDir: directory, ownerChatId: () => owner, timeoutMs: 15_000, permissionTimeoutMs: 15_000 })
  const phone = async (text: string, msgId = crypto.randomUUID()) => {
    const reply=await service.handleWechat(owner, text, { accountId: 'owned-offline-account', userId: owner, msgId, createTimeMs: 1 })
    assert(reply===null||typeof reply==='string','a native approval/query command unexpectedly delivered a file')
    return reply
  }
  try {
    const task = service.create({ path: directory, providerId: 'codex', title: 'Offline phone approval fixture', text: 'Call the isolated fixture echo tool once.' })
    const list = await phone('任务')
    const taskId = /^([a-f0-9]{8}) ·/m.exec(list ?? '')?.[1]
    assert.equal(taskId, task.id, 'phone task list did not expose the created task')
    await waitFor('native permission in the task service', () => service.detail(task.id).permissions.length === 1)
    const pending = service.detail(task.id), runId = pending.runId, nativeId = store.get(task.id).sessionId
    assert(runId && nativeId, 'permission must belong to an active task run and native session')
    const status = await phone(`任务 ${taskId}`)
    const permissionId = /权限 ([a-f0-9-]{36})/i.exec(status ?? '')?.[1]
    assert.equal(permissionId, pending.permissions[0]!.id, 'phone must use the actual pending permission UUID')
    const review = await phone(`任务 ${taskId} 权限 ${permissionId}`)
    assert(review, 'phone permission review was unavailable')
    assert(review.includes('mcp__fixture__echo') && review.includes('CC fixture'))
    assert(!review.includes('fixture-secret'), 'phone permission exposed a credential')
    assert.equal(await countLines(calls), 0)
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(await countLines(calls), 0, 'native tool executed while the phone was reviewing')
    const waitingActivity = pending.events.find(event => event.kind === 'tool_call' && event.activity?.status === 'running')
    assert(waitingActivity, 'native invocation must already be visible during approval')
    assert.equal(waitingActivity.runId, runId)
    assert.equal(await service.handleWechat('another-chat', `任务 ${taskId} 允许 ${permissionId}`), null)
    assert.equal(service.detail(task.id).permissions.length, 1, 'another phone owner changed the permission')

    const approveCommand = `任务 ${taskId} 允许 ${permissionId}`, messageId = crypto.randomUUID()
    assert((await phone(approveCommand, messageId))?.includes('已允许'))
    assert((await phone(approveCommand, messageId))?.includes('已失效'), 'duplicate phone delivery was not rejected')
    await waitFor('native task completion', () => !['queued', 'running', 'cancelling'].includes(service.detail(task.id).task.status))
    const completed = service.detail(task.id)
    assert.equal(completed.task.status, 'completed')
    assert.equal(store.get(task.id).sessionId, nativeId, 'phone approval switched the native session')
    assert.equal(completed.permissions.length, 0)
    const result = await phone(`任务 ${taskId} 结果`)
    assert(result?.includes('这一轮已完成') && result.includes('Fixture finished.'))
    assert((await phone(approveCommand))?.includes('已失效'), 'a later duplicate reused the resolved UUID')
    assert.equal(await countLines(calls), 1, 'phone approval dispatched the native MCP more than once')
    assert.equal(await countLines(companion), 0)
    assert.equal(modelRequests(), 2, 'phone queries or duplicate approval started another model turn')
    assert.equal(store.listOwned(owner, 8).length, 1)
    assert.deepEqual([...new Set(completed.events.flatMap(event => event.runId ? [event.runId] : []))], [runId])
    assert(completed.events.every(event => event.taskId === task.id))
    assert.equal(completed.events.filter(event => event.text.startsWith('权限请求：')).length, 1)
    assert.equal(completed.events.filter(event => event.text.startsWith('权限结果：') && event.text.includes(' · allow · ')).length, 1)
    const finishedActivity = completed.events.find(event => event.id === waitingActivity.id)
    assert.equal(finishedActivity?.activity?.status, 'completed', 'the same invocation row did not finish')
    assert(!JSON.stringify(completed.events).includes('fixture-secret'))
    return { scenario: 'wechat', permissionRequests: 1, executedCalls: 1, companionStarts: 0, taskRuns: 1, nativeSessionBound: true, duplicatePhoneApprovalRejected: true, phoneResultObserved: true }
  } finally { await service.shutdown(); db.close() }
}

type Scenario = 'accept' | 'decline' | 'cancel' | 'resume' | 'wechat'
async function verify(scenario: Scenario) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'cc-codex-tools-')))
  const calls = join(directory, 'calls'), companion = join(directory, 'companion-started')
  const mcpPath = join(directory, 'fixture.mjs'), wrapper = join(directory, 'codex')
  let modelRequests = 0, permissionRequests = 0, expectedCalls = 0
  let session: AgentSession | undefined
  const web = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Drain own fixture request. Never log prompts. */ }
    const number = ++modelRequests, id = `response-${number}`
    const item = number % 2 === 1
      ? { id: `function-${number}`, type: 'function_call', call_id: `call-${number}`, name: 'echo', namespace: 'mcp__fixture', arguments: JSON.stringify({ message: 'CC fixture', api_key: 'fixture-secret' }) }
      : { id: `message-${number}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Fixture finished.', annotations: [] }] }
    const events = [
      { type: 'response.created', response: { id } },
      { type: 'response.output_item.added', output_index: 0, item },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { id, status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ]
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
  })
  await new Promise<void>(resolve => web.listen(0, '127.0.0.1', resolve))
  const address = web.address()
  assert(address && typeof address === 'object')
  try {
    await writeFile(mcpPath, `
import { createInterface } from 'node:readline'
import { appendFileSync } from 'node:fs'
if (process.env.CC_FIXTURE_COMPANION) appendFileSync(process.env.CC_FIXTURE_COMPANION, 'started\\n')
const send = value => process.stdout.write(JSON.stringify(value) + '\\n')
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line)
  if (request.id === undefined) return
  let result = {}
  if (request.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'CC test fixture', version: '1' } }
  if (request.method === 'tools/list') result = { tools: [{ name: 'echo', description: 'Offline CC test tool', inputSchema: { type: 'object', properties: { message: { type: 'string' }, api_key: { type: 'string' } }, required: ['message', 'api_key'], additionalProperties: false }, annotations: { readOnlyHint: true } }] }
  if (request.method === 'tools/call') {
    appendFileSync(${JSON.stringify(calls)}, 'called\\n')
    result = { content: [{ type: 'text', text: 'Fixture echo.' }] }
  }
  send({ jsonrpc: '2.0', id: request.id, result })
})
`)
    // The wrapper scopes both discovery and execution without changing this
    // process's environment or the user's native configuration.
    await writeFile(wrapper, `#!/bin/sh\nexport CODEX_HOME=${quote(directory)}\nexport HOME=${quote(directory)}\nexec ${quote(binary!)} "$@"\n`)
    await chmod(wrapper, 0o700)
    await writeFile(join(directory, 'config.toml'), `
model = 'mock-model'
model_provider = 'fixture'
web_search = 'cached'
[model_providers.fixture]
name = 'CC offline fixture'
base_url = 'http://127.0.0.1:${address.port}/v1'
wire_api = 'responses'
requires_openai_auth = false
supports_websockets = false
[mcp_servers.fixture]
command = ${JSON.stringify(process.execPath)}
args = [${JSON.stringify(mcpPath)}]
default_tools_approval_mode = 'approve'
[mcp_servers.fixture.tools.echo]
approval_mode = 'approve'
[mcp_servers.renamed_companion]
command = ${JSON.stringify(process.execPath)}
args = [${JSON.stringify(mcpPath)}]
env = { WECHAT_INTERNAL_API = 'http://127.0.0.1:1', CC_FIXTURE_COMPANION = ${JSON.stringify(companion)} }
[features]
plugins = false
apps = false
hooks = false
tool_call_mcp_elicitation = false
`)
    const provider = createWorkbenchCodexProvider({ codexPathOverride: wrapper, model: 'mock-model', rpcTimeoutMs: 10_000 })
    if (scenario === 'wechat') return await verifyWechat(provider, directory, calls, companion, () => modelRequests)
    const context: SpawnContext = {
      chatId: 'workbench:offline-fixture', tierProfile: TIER_PROFILES.trusted, permissionMode: 'strict',
      requestPermission: async (request, signal) => {
        permissionRequests++
        assert.equal(request.tool, 'mcp__fixture__echo')
        assert(request.description.includes('CC fixture'))
        assert(!request.description.includes('fixture-secret'))
        assert.equal(await countLines(calls), expectedCalls)
        await new Promise(resolve => setTimeout(resolve, 50))
        assert.equal(await countLines(calls), expectedCalls, 'tool executed before approval')
        if (scenario === 'cancel') { await session!.cancel!(); assert(signal?.aborted); return false }
        return scenario !== 'decline'
      },
    }
    const spawnSession = (resumeSessionId?: string) => provider.spawn({ path: directory, alias: 'offline-fixture' }, { ...context, resumeSessionId })
    session = await spawnSession()
    let nativeId = ''
    const rounds = scenario === 'accept' || scenario === 'resume' ? 2 : 1
    for (let round = 0; round < rounds; round++) {
      const events: AgentEvent[] = []
      const timeout = setTimeout(() => { void session!.close() }, 15_000)
      try { for await (const event of session.dispatch('Call the isolated fixture echo tool once.')) events.push(event) }
      finally { clearTimeout(timeout) }
      const init = events.find(event => event.kind === 'init')
      assert(init?.kind === 'init')
      if (nativeId) assert.equal(init.sessionId, nativeId)
      nativeId = init.sessionId
      assert.equal(permissionRequests, round + 1, 'every invocation must prompt even after prior acceptance')
      if (scenario === 'accept' || scenario === 'resume') expectedCalls++
      assert.equal(await countLines(calls), expectedCalls)
      assert.equal(await countLines(companion), 0, 'companion server was started')
      assert(!JSON.stringify(events).includes('fixture-secret'))
      assert(events.some(event => event.kind === 'tool_call' && event.activity?.status === 'running'))
      if (scenario === 'cancel') assert(events.some(event => event.kind === 'error'))
      else {
        assert(events.some(event => event.kind === 'tool_call' && event.activity?.status === (scenario === 'decline' ? 'failed' : 'completed')))
        assert(events.some(event => event.kind === 'result'))
      }
      if (scenario === 'resume' && round === 0) { await session.close(); session = await spawnSession(nativeId) }
    }
    return { scenario, permissionRequests, executedCalls: expectedCalls, companionStarts: await countLines(companion), nativeSessionResumed: scenario === 'resume' }
  } finally {
    await session?.close()
    await new Promise<void>(resolve => web.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  }
}

for (const scenario of ['accept', 'decline', 'cancel', 'resume', 'wechat'] as const) console.log(JSON.stringify(await verify(scenario)))

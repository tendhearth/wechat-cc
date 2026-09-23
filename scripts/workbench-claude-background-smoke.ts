/** Actual installed Claude task lifecycle against synthetic Anthropic responses.
 * No real model, credential, settings or MCP is used. macOS sandbox-exec confines
 * the native process to loopback. Run: bun scripts/workbench-claude-background-smoke.ts --run
 * Optional: --modes=plain,complete,pair,pair-input,bash,stop,interrupt,close,abort,adapter
 * Add --with-internal-state-events for an explicitly internal diagnostic flag.
 * Add --production-runtime --modes=plain,pair,pair-input,bash,bash-close,close,interrupt to exercise the workbench adapter.
 * Evidence is retained under the printed owned temporary directory.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { query, type Options, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { AsyncQueue } from '../src/core/async-queue'
import { createClaudeAgentProvider } from '../src/core/claude-agent-provider'
import { TIER_PROFILES } from '../src/core/user-tier'

if (!process.argv.includes('--run')) { console.log('Use --run for owned, loopback-only Claude background task fixtures.'); process.exit(0) }
assert.equal(process.platform, 'darwin', 'macOS sandbox-exec is required for enforced network isolation.')
assert(existsSync('/usr/bin/sandbox-exec'))
const binary = Bun.which('claude'); assert(binary)
const version = execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim()
const sdkVersion = JSON.parse(readFileSync(new URL('../node_modules/@anthropic-ai/claude-agent-sdk/package.json', import.meta.url), 'utf8')).version as string
const root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-claude-background-')))
const safePath = process.env.PATH ?? '/usr/bin:/bin'
for (const key of Object.keys(process.env)) delete process.env[key]
Object.assign(process.env, { PATH: safePath, LANG: 'en_US.UTF-8', TERM: 'dumb', HOME: root, TMPDIR: root })
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
const profile = '(version 1) (allow default) (deny network*) (allow network-outbound (remote ip "localhost:*"))'
type Mode = 'plain' | 'complete' | 'pair' | 'pair-input' | 'bash' | 'bash-close' | 'stop' | 'interrupt' | 'close' | 'abort' | 'adapter'
const allowedModes: Mode[] = ['plain', 'complete', 'pair', 'pair-input', 'bash', 'bash-close', 'stop', 'interrupt', 'close', 'abort', 'adapter']
const modes = (process.argv.find(value => value.startsWith('--modes='))?.slice(8).split(',') ?? allowedModes.filter(mode => mode !== 'bash-close')) as Mode[]
assert(modes.every(mode => allowedModes.includes(mode)), 'Unknown mode')
const productionRuntime = process.argv.includes('--production-runtime')
assert(!productionRuntime || modes.every(mode => !['stop', 'adapter'].includes(mode)), 'Production runtime does not expose individual child stopTask or legacy adapter mode')
const results: unknown[] = []
console.log(JSON.stringify({ root, version, sdkVersion, modes, nativeRuntime: true, syntheticModelEndpoint: true, loopbackOnly: true, productionRuntime, internalStateFlag: process.argv.includes('--with-internal-state-events') }))
for (const mode of modes) {
  const pairMode = mode === 'pair' || mode === 'pair-input', bashMode = mode === 'bash' || mode === 'bash-close'
  assert(mode !== 'bash-close' || productionRuntime, 'bash-close probes production teardown only')
  const area = join(root, mode), cwd = join(area, 'project'), ownedHome = join(area, 'home'), config = join(ownedHome, '.claude')
  mkdirSync(cwd, { recursive: true }); mkdirSync(config, { recursive: true })
  const fixtureFile = join(cwd, 'owned-fixture.txt'); writeFileSync(fixtureFile, 'OWNED_CHILD_READ_RESULT\n')
  const wrapper = join(area, 'claude'), pidFile = join(area, 'native.pid')
  const bashPidFile = join(area, 'bash.pid'), sleepPidFile = join(area, 'sleep.pid'), bashGroupFile = join(area, 'bash-processes.txt')
  writeFileSync(wrapper, `#!/bin/sh\nprintf '%s' "$$" > ${quote(pidFile)}\nexec /usr/bin/sandbox-exec -p ${quote(profile)} ${quote(binary)} "$@"\n`, { mode: 0o700 })
  const started = Date.now(), elapsed = () => Date.now() - started
  const requests: any[] = [], events: any[] = [], actions: any[] = [], securityFailures: string[] = []
  const snapshots: any[] = [], acknowledgedInputs: string[] = []
  const responseTimers = new Set<ReturnType<typeof setTimeout>>()
  const childCounts: Record<string, number> = {}
  const humanInputs = ['ONE', 'TWO'].map(key => ({ uuid: randomUUID(), text: `OWNED_HUMAN_FOLLOWUP_${key}`, priority: 'next' as const }))
  let submitHumanInputs: (() => void) | undefined, allStimuliParentCall: number | undefined
  let parentCalls = 0, childCalls = 0, firstResultAt: number | undefined, taskId: string | undefined, stderr = '', error = '', actionDone = false, consumerEnded = false, childDisconnects = 0, liveTaskIds: string[] = []
  const respond = (response: ServerResponse, body: any, block: any, id: string) => {
    if (response.destroyed) return
    const blocks = Array.isArray(block) ? block : [block], use = blocks.some(value => value.type === 'tool_use')
    const message = { id, type: 'message', role: 'assistant', model: body.model, content: blocks, stop_reason: use ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 100, output_tokens: 10 } }
    if (!body.stream) { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(message)); return }
    response.setHeader('content-type', 'text/event-stream')
    const event = (value: any) => response.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`)
    event({ type: 'message_start', message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 100, output_tokens: 0 } } })
    for (const [index, value] of blocks.entries()) {
      const isTool = value.type === 'tool_use'
      event({ type: 'content_block_start', index, content_block: isTool ? { ...value, input: {} } : { type: 'text', text: '' } })
      event({ type: 'content_block_delta', index, delta: isTool ? { type: 'input_json_delta', partial_json: JSON.stringify(value.input) } : { type: 'text_delta', text: value.text } })
      event({ type: 'content_block_stop', index })
    }
    event({ type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 10 } })
    event({ type: 'message_stop' }); response.end()
  }
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const raw = Buffer.concat(chunks), body = JSON.parse((request.headers['content-encoding'] === 'gzip' ? gunzipSync(raw) : raw).toString() || '{}')
      if (request.headers['x-api-key'] && request.headers['x-api-key'] !== 'owned-background-fixture') securityFailures.push('unexpected_api_key')
      if (request.headers.authorization && request.headers.authorization !== 'Bearer owned-background-fixture') securityFailures.push('unexpected_authorization')
      if (request.url?.includes('count_tokens')) { response.setHeader('content-type', 'application/json'); response.end('{"input_tokens":100}'); return }
      if (!request.url?.startsWith('/v1/messages')) { response.setHeader('content-type', 'application/json'); response.end('{}'); return }
      const child = JSON.stringify(body.system).includes('OWNED_CHILD_SYSTEM')
      const childKey = JSON.stringify(body.system).includes('OWNED_CHILD_SYSTEM_B') ? 'B' : 'A'
      if (child) childCalls++
      const count = child ? childCounts[childKey] = (childCounts[childKey] ?? 0) + 1 : ++parentCalls
      requests.push({ at: elapsed(), path: request.url, child, ...(child ? { childKey } : {}), count, body })
      if (child) {
        response.on('close', () => { if (!response.writableEnded) { childDisconnects++; actions.push({ at: elapsed(), action: 'child_model_connection_closed', count }) } })
        const timer = setTimeout(() => {
          responseTimers.delete(timer)
          respond(response, body, count === 1 ? { type: 'tool_use', id: `toolu_owned_child_read_${childKey}`, name: 'Read', input: { file_path: fixtureFile } } : { type: 'text', text: `OWNED_CHILD_COMPLETE_${childKey}` }, `msg_owned_child_${childKey}_${count}`)
        }, pairMode ? childKey === 'A' ? 750 : count === 1 ? 1000 : 2000 : 3000)
        responseTimers.add(timer)
      } else {
        const block = count === 1 && mode !== 'plain'
          ? pairMode
            ? ['A', 'B'].map(key => ({ type: 'tool_use', id: `toolu_owned_agent_${key}`, name: 'Agent', input: { description: `Owned background child ${key}`, prompt: `Read the owned fixture and return OWNED_CHILD_COMPLETE_${key}.`, subagent_type: `owned-worker-${key}`, run_in_background: true } }))
            : bashMode
            ? { type: 'tool_use', id: 'toolu_owned_bash', name: 'Bash', input: { command: mode === 'bash-close' ? `printf '%s' "$$" > ${quote(bashPidFile)}; /bin/sleep 60 & owned_sleep=$!; printf '%s' "$owned_sleep" > ${quote(sleepPidFile)}; /bin/ps -o pid=,ppid=,pgid= -p "$$,$owned_sleep" > ${quote(bashGroupFile)}; wait "$owned_sleep"` : '/bin/sleep 5; printf OWNED_BASH_COMPLETE', description: 'Owned background command', run_in_background: true } }
            : { type: 'tool_use', id: 'toolu_owned_agent', name: 'Agent', input: { description: 'Owned background child', prompt: 'Read the owned fixture and return OWNED_CHILD_COMPLETE.', subagent_type: 'owned-worker', run_in_background: true } }
          : { type: 'text', text: count === 2 ? 'OWNED_PARENT_RETURNED' : `OWNED_PARENT_AFTER_CHILD_${count - 2}` }
        if (mode === 'pair-input') {
          const transcript = JSON.stringify(body.messages)
          if (humanInputs.every(value => transcript.includes(value.text)) && ['A', 'B'].every(key => transcript.includes(`<result>OWNED_CHILD_COMPLETE_${key}</result>`))) {
            allStimuliParentCall ??= count
            actions.push({ at: elapsed(), action: 'all_owned_stimuli_reached_parent_model', count })
          }
        }
        if (pairMode && count === 3) {
          actions.push({ at: elapsed(), action: 'holding_first_parent_followup_until_second_child_finishes' })
          if (mode === 'pair-input') {
            const inputTimer = setTimeout(() => { responseTimers.delete(inputTimer); submitHumanInputs?.() }, 150)
            responseTimers.add(inputTimer)
          }
          const timer = setTimeout(() => { responseTimers.delete(timer); respond(response, body, block, `msg_owned_parent_${count}`) }, 3500)
          responseTimers.add(timer)
        } else respond(response, body, block, `msg_owned_parent_${count}`)
      }
    } catch (caught) { error = String(caught); response.writeHead(500); response.end('{}') }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const abort = new AbortController(), input = new AsyncQueue<SDKUserMessage>()
  const options: Options = {
    cwd, model: 'claude-sonnet-4-6', pathToClaudeCodeExecutable: wrapper, settingSources: [], mcpServers: {}, strictMcpConfig: true, persistSession: false,
    systemPrompt: 'OWNED_PARENT_SYSTEM. Execute only this owned fixture.',
    agents: { 'owned-worker': { description: 'Owned QA background worker.', prompt: 'OWNED_CHILD_SYSTEM. Read only the owned fixture then return its completion marker.', tools: ['Read'] },
      ...Object.fromEntries(['A', 'B'].map(key => [`owned-worker-${key}`, { description: `Owned QA background worker ${key}.`, prompt: `OWNED_CHILD_SYSTEM_${key}. Read only the owned fixture then return its completion marker.`, tools: ['Read'] }])) },
    ...(pairMode ? { extraArgs: { 'replay-user-messages': null } } : {}),
    tools: ['Agent', 'Read', ...(bashMode ? ['Bash'] : [])], allowedTools: ['Agent', 'Read', ...(bashMode ? ['Bash'] : [])], permissionMode: 'default',
    canUseTool: async (toolName, inputValue) => {
      actions.push({ at: elapsed(), action: 'permission', toolName, input: inputValue })
      return toolName === 'Agent' || toolName === 'Read' || bashMode && toolName === 'Bash' ? { behavior: 'allow', updatedInput: inputValue } : { behavior: 'deny', message: 'Fixture tool unavailable.' }
    },
    abortController: abort, maxTurns: 8, stderr: chunk => { stderr += chunk },
    env: { HOME: ownedHome, CLAUDE_CONFIG_DIR: config, XDG_CONFIG_HOME: join(ownedHome, '.config'), TMPDIR: area,
      ANTHROPIC_API_KEY: 'owned-background-fixture', ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1',
      ...(process.argv.includes('--with-internal-state-events') ? { CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1' } : {}),
      CLAUDE_CODE_USE_BEDROCK: '0', CLAUDE_CODE_USE_VERTEX: '0', CLAUDE_CODE_USE_FOUNDRY: '0' },
  }
  Object.assign(process.env, options.env)
  let cleanup: () => void | Promise<void> = () => {}, consumer: Promise<void> = Promise.resolve()
  let deadline: ReturnType<typeof setTimeout> | undefined
  try {
    if (productionRuntime) {
      const provider = createClaudeAgentProvider({ sdkOptionsForProject: () => ({ ...options }) })
      const session = await provider.spawn({ alias: 'owned-background', path: cwd }, { tierProfile: TIER_PROFILES.trusted, permissionMode: 'strict', chatId: 'owned-background', workbenchTimeline: true, workbenchLifecycle: true })
      const runtime = session.workbenchRuntime; assert(runtime)
      cleanup = () => session.close()
      submitHumanInputs = () => {
        for (const value of humanInputs) {
          actions.push({ at: elapsed(), action: 'local_human_input_enqueue', ...value })
          void runtime.submit(value.uuid, value.text).then(() => { acknowledgedInputs.push(value.uuid); actions.push({ at: elapsed(), action: 'production_native_input_ack', requestId: value.uuid }) }, caught => { error = String(caught) })
        }
      }
      let latestParentText = '', closeTriggered = false, interruptRequest: Promise<void> | undefined
      consumer = (async () => {
        for await (const event of runtime.events) {
          events.push({ at: elapsed(), message: event }); snapshots.push({ at: elapsed(), ...runtime.snapshot() })
          if (event.kind === 'text') latestParentText = event.text
          if (event.kind === 'result') {
            firstResultAt ??= elapsed()
            const expectedText = mode === 'pair-input' ? (allStimuliParentCall !== undefined ? `OWNED_PARENT_AFTER_CHILD_${allStimuliParentCall - 2}` : undefined) : mode === 'pair' ? 'OWNED_PARENT_AFTER_CHILD_2' : 'OWNED_PARENT_AFTER_CHILD_1'
            if (!['plain', 'close', 'bash-close', 'abort', 'interrupt'].includes(mode) && latestParentText === expectedText) {
              actions.push({ at: elapsed(), action: 'expected_production_fixture_result_close' }); await session.close()
            }
          }
          if (!closeTriggered && ['close', 'bash-close', 'abort', 'interrupt'].includes(mode) && event.kind === 'tool_call' && event.activity?.id.startsWith('claude:task:') && event.activity.status === 'running') {
            closeTriggered = true
            const timer = setTimeout(() => {
              responseTimers.delete(timer); actions.push({ at: elapsed(), action: `production_${mode}` })
              if (mode === 'bash-close' && existsSync(bashPidFile) && existsSync(sleepPidFile)) {
                const pids = [pidFile, bashPidFile, sleepPidFile].map(file => readFileSync(file, 'utf8').trim()).join(',')
                writeFileSync(bashGroupFile, execFileSync('/bin/ps', ['-o', 'pid=,ppid=,pgid=', '-p', pids], { encoding: 'utf8' }))
              }
              if (mode === 'abort') abort.abort()
              else if (mode === 'interrupt') { interruptRequest = session.cancel?.() ?? Promise.resolve(); void interruptRequest.catch(caught => { error = String(caught) }) }
              else void session.close().catch(caught => { error = String(caught) })
            }, 700)
            responseTimers.add(timer)
          }
          if (mode === 'interrupt' && event.kind === 'tool_call' && event.activity?.id.startsWith('claude:task:') && event.activity.status === 'cancelled') { await interruptRequest; await session.close() }
        }
        consumerEnded = true; actions.push({ at: elapsed(), action: 'production_runtime_stream_ended' })
      })()
      deadline = setTimeout(() => { actions.push({ at: elapsed(), action: 'fixture_deadline' }); void session.close() }, 18000)
      runtime.start('Run the owned background fixture.')
      await consumer
      await session.close()
      snapshots.push({ at: elapsed(), ...runtime.snapshot() })
    } else if (mode === 'adapter') {
      const provider = createClaudeAgentProvider({ sdkOptionsForProject: () => ({ ...options }) })
      const session = await provider.spawn({ alias: 'owned-background', path: cwd }, { tierProfile: TIER_PROFILES.trusted, permissionMode: 'strict', chatId: 'owned-background', workbenchTimeline: true })
      cleanup = () => session.close()
      consumer = (async () => {
        for await (const event of session.dispatch('Run the owned background fixture.')) {
          events.push({ at: elapsed(), message: event })
          if (event.kind === 'result') firstResultAt ??= elapsed()
        }
        consumerEnded = true; actions.push({ at: elapsed(), action: 'adapter_dispatch_ended' })
      })()
      deadline = setTimeout(() => { actions.push({ at: elapsed(), action: 'fixture_deadline' }); void session.close() }, 18000)
      await consumer
      // Current service calls close after dispatch finishes. Match that lifecycle.
      await session.close(); actions.push({ at: elapsed(), action: 'adapter_session_closed' })
    } else {
      const q = query({ prompt: input.iterable(), options })
      submitHumanInputs = () => {
        for (const value of humanInputs) {
          actions.push({ at: elapsed(), action: 'local_human_input_enqueue', ...value })
          input.push({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: value.text }, uuid: value.uuid, priority: value.priority })
        }
      }
      void q.initializationResult().then(value => writeFileSync(join(area, 'initialization.json'), JSON.stringify(value, null, 2))).catch(caught => actions.push({ at: elapsed(), action: 'initialization_error', error: String(caught) }))
      cleanup = () => { input.end(); q.close(); abort.abort() }
      const act = async () => {
        if (actionDone || !taskId || mode === 'complete' || pairMode || mode === 'plain' || mode === 'bash') return
        actionDone = true; actions.push({ at: elapsed(), action: mode, taskId })
        try {
          if (mode === 'stop') await q.stopTask(taskId)
          else if (mode === 'interrupt') await q.interrupt()
          else if (mode === 'close') q.close()
          else if (mode === 'abort') abort.abort()
          actions.push({ at: elapsed(), action: `${mode}_resolved` })
        } catch (caught) { actions.push({ at: elapsed(), action: `${mode}_error`, error: String(caught) }) }
      }
      consumer = (async () => {
        try {
          for await (const message of q) {
            events.push({ at: elapsed(), message })
            if (message.type === 'system' && (message as any).subtype === 'background_tasks_changed') liveTaskIds = (message as any).tasks.map((task: any) => task.task_id)
            if (message.type === 'system' && message.subtype === 'task_started') {
              taskId = message.task_id
              if (mode !== 'complete' && !pairMode && mode !== 'plain' && mode !== 'bash') setTimeout(() => void act(), 700)
            }
            if (message.type === 'result') {
              firstResultAt ??= elapsed()
              // Fixture expectations, not a production quiescence algorithm:
              // the endpoint has an exact known number of child/follow-up calls.
              const expectedInputResult = mode === 'pair-input' && allStimuliParentCall !== undefined && (message as any).result === `OWNED_PARENT_AFTER_CHILD_${allStimuliParentCall - 2}`
              if (!process.argv.includes('--with-internal-state-events') && (mode === 'plain' || expectedInputResult || mode !== 'pair-input' && (message as any).origin?.kind === 'task-notification' && (!pairMode || parentCalls >= 4))) {
                actions.push({ at: elapsed(), action: 'expected_fixture_result_close' }); q.close()
              }
            }
            if (mode === 'interrupt' && !process.argv.includes('--with-internal-state-events') && message.type === 'user' && message.parent_tool_use_id && JSON.stringify(message.message.content).includes('[Request interrupted by user]')) {
              actions.push({ at: elapsed(), action: 'expected_child_interruption_close' }); q.close()
            }
            if (message.type === 'system' && message.subtype === 'session_state_changed' && message.state === 'idle' && firstResultAt !== undefined) {
              actions.push({ at: elapsed(), action: 'native_idle', liveTaskIds })
              if (!liveTaskIds.length && (!pairMode || parentCalls >= 4) && (mode !== 'pair-input' || allStimuliParentCall !== undefined)) { actions.push({ at: elapsed(), action: 'expected_fixture_idle_close' }); q.close() }
            }
          }
        } catch (caught) { error = String(caught) }
        finally { consumerEnded = true; actions.push({ at: elapsed(), action: 'sdk_consumer_ended' }) }
      })()
      deadline = setTimeout(() => { actions.push({ at: elapsed(), action: 'fixture_deadline' }); q.close(); abort.abort() }, 18000)
      input.push({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: 'Run the owned background fixture.' } })
      await consumer
    }
  } catch (caught) { error = String(caught) }
  finally {
    if (deadline) clearTimeout(deadline)
    try { await cleanup() } catch (caught) { error = String(caught) }; for (const timer of responseTimers) clearTimeout(timer)
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
  }
  let nativeAlive = false
  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, 'utf8'))
    for (let count = 0; count < 50; count++) {
      try { process.kill(pid, 0); nativeAlive = true } catch { nativeAlive = false; break }
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }
  const bashProcesses = [bashPidFile, sleepPidFile].flatMap(file => {
    if (!existsSync(file)) return []
    const pid = Number(readFileSync(file, 'utf8')); let alive = false
    try { process.kill(pid, 0); alive = true } catch {}
    if (alive) { try { process.kill(pid, 'SIGKILL') } catch {} } // Fixture-only cleanup, after recording failed production close.
    return [{ pid, aliveAfterClose: alive }]
  })
  const bashGroups = mode === 'bash-close' && existsSync(bashGroupFile) ? [...new Set(readFileSync(bashGroupFile, 'utf8').trim().split('\n').flatMap(line => { const values = line.trim().split(/\s+/).map(Number); return values.length === 3 && values[2]! > 0 ? [values[2]!] : [] }))].map(pgid => { let alive = false; try { process.kill(-pgid, 0); alive = true } catch {}; return { pgid, aliveAfterClose: alive } }) : []
  const eventSummary = events.map(({ at, message: m }) => ({ at, type: m.type ?? m.kind, subtype: m.subtype, state: m.state, task_id: m.task_id, tool_use_id: m.tool_use_id, parent_tool_use_id: m.parent_tool_use_id, status: m.status, patch: m.patch, text: typeof m.message?.content === 'string' ? m.message.content : m.message?.content?.filter?.((v: any) => v.type === 'text').map((v: any) => v.text).join('') || m.text || m.result, usage: m.usage, origin: m.origin, terminal_reason: m.terminal_reason, ...(mode === 'pair-input' ? { uuid: m.uuid, command_uuid: m.command_uuid, isReplay: m.isReplay, user_message_uuid: m.user_message_uuid, user_message_uuids: m.user_message_uuids, queued_turn_count: m.queued_turn_count } : {}) }))
  const result = { mode, parentCalls, childCalls, childDisconnects, firstResultAt, consumerEnded, nativeAlive, bashProcesses, bashGroups, securityFailures, error, actions, eventSummary, ...(productionRuntime ? { snapshots, acknowledgedInputs } : {}), ...(mode === 'pair-input' ? { humanInputs, allStimuliParentCall } : {}) }
  for (const [name, value] of Object.entries({ requests, events, result })) writeFileSync(join(area, `${name}.json`), JSON.stringify(value, null, 2))
  writeFileSync(join(area, 'stderr.txt'), stderr); results.push(result)
  console.log(JSON.stringify({ ...result, eventSummary: eventSummary.map(({ usage, ...event }) => event) }))
  if (mode === 'bash-close') { assert.equal(bashProcesses.length, 2); assert(bashGroups.length > 0); assert(bashGroups.every(value => !value.aliveAfterClose), 'Owned background Bash process group survived production close'); assert(bashProcesses.every(value => !value.aliveAfterClose), 'Owned background Bash descendant survived production close') }
  assert.equal(nativeAlive, false, 'Owned native child did not terminate')
  assert.deepEqual(securityFailures, [])
  assert(!actions.some(value => value.action === 'fixture_deadline'), 'Fixture did not reach its expected terminal response')
  if (productionRuntime) {
    assert(firstResultAt !== undefined)
    assert.equal(error, '')
    const parentText = events.filter(event => event.message.kind === 'text').map(event => event.message.text)
    assert(!parentText.some(text => text.includes('OWNED_CHILD_COMPLETE')), 'Child reply leaked into main conversation')
    if (mode !== 'plain') assert(snapshots.some(snapshot => snapshot.retained === true))
    if (mode === 'pair' || mode === 'pair-input' || mode === 'complete') {
      const childOutputs = new Map(events.filter(event => event.message.kind === 'tool_call' && event.message.activity?.output).map(event => [event.message.activity.id, event.message.activity.output]))
      assert.equal(childOutputs.size, pairMode ? 2 : 1)
      assert([...childOutputs.values()].every(output => String(output).includes('OWNED_CHILD_COMPLETE')))
      assert.equal(parentCalls, mode === 'pair-input' ? 5 : mode === 'pair' ? 4 : 3)
    }
    if (mode === 'pair-input') assert.deepEqual(acknowledgedInputs, humanInputs.map(value => value.uuid), 'Production submit was not acknowledged by native replay')
    if (mode === 'close' || mode === 'abort') assert(!events.some(event => event.message.activity?.output?.includes('OWNED_CHILD_COMPLETE')))
  } else if (mode !== 'adapter') {
    const messages = events.map(event => event.message)
    const starts = messages.filter(message => message.type === 'system' && message.subtype === 'task_started')
    const notifications = messages.filter(message => message.type === 'system' && message.subtype === 'task_notification')
    const nativeResults = messages.filter(message => message.type === 'result')
    assert(firstResultAt !== undefined, 'Parent did not return a result')
    if (!process.argv.includes('--with-internal-state-events')) assert(!messages.some(message => message.subtype === 'session_state_changed'), 'Native state-event default changed; inspect new lifecycle')
    if (mode === 'plain') { assert.equal(starts.length, 0); assert.equal(nativeResults.length, 1) }
    if (mode === 'complete' || mode === 'pair') {
      const count = mode === 'pair' ? 2 : 1
      assert.equal(starts.length, count); assert.equal(notifications.length, count)
      assert(notifications.every(message => message.status === 'completed'))
      assert.equal(nativeResults.length, count + 1)
      assert.equal(childCalls, count * 2)
      assert(events.find(event => event.message.subtype === 'task_notification')!.at > firstResultAt)
      for (const task of starts) assert(messages.some(message => message.type === 'assistant' && message.parent_tool_use_id === task.tool_use_id), 'Child has no native owner correlation')
      if (mode === 'pair') {
        const followupIndices = messages.flatMap((message, index) => message.type === 'result' && message.origin?.kind === 'task-notification' ? [index] : [])
        const lastNotification = messages.findLastIndex(message => message.subtype === 'task_notification')
        assert.equal(followupIndices.length, 2)
        assert(lastNotification < followupIndices[0]!, 'Pair fixture did not reproduce queued follow-up after all children finish')
        assert(requests.find(request => !request.child && request.count === 3)!.at < events[lastNotification]!.at, 'First parent follow-up was not held while second child completed')
      }
    }
    if (mode === 'pair-input') {
      assert.equal(starts.length, 2); assert.equal(notifications.length, 2); assert.equal(childCalls, 4)
      assert(allStimuliParentCall !== undefined, 'Not all owned stimuli reached the native parent model')
      for (const value of humanInputs) assert(messages.some(message => message.type === 'user' && message.isReplay === true && message.uuid === value.uuid), 'Missing native user input replay acknowledgement')
      const holdAt = actions.find(value => value.action === 'holding_first_parent_followup_until_second_child_finishes')!.at
      const heldReplyAt = events.find(event => event.message.type === 'assistant' && JSON.stringify(event.message.message.content).includes('OWNED_PARENT_AFTER_CHILD_1'))!.at
      assert(actions.filter(value => value.action === 'local_human_input_enqueue').every(value => value.at > holdAt && value.at < heldReplyAt), 'Input was not enqueued during held automatic response')
      for (const value of humanInputs) {
        const lifecycle = events.filter(event => event.message.type === 'command_lifecycle' && event.message.command_uuid === value.uuid)
        assert.deepEqual(lifecycle.map(event => event.message.state), ['queued', 'started', 'completed'])
        assert(lifecycle[0]!.at < heldReplyAt, 'Native queue acknowledgement waited for held model response')
      }
      const humanResults = nativeResults.filter(message => message.user_message_uuids?.includes(humanInputs[0]!.uuid))
      assert.equal(humanResults.length, 1, 'Human supplements did not coalesce into one native turn')
      assert.deepEqual(humanResults[0].user_message_uuids, humanInputs.map(value => value.uuid))
      assert.equal(humanResults[0].user_message_uuid, humanInputs[1]!.uuid)
      assert.equal(humanResults[0].origin, undefined, 'Merged human turn was marked autonomous')
      assert.equal(nativeResults.at(-1).origin?.kind, 'task-notification', 'Second child follow-up was lost after human turn')
    }
    if (mode === 'stop' || mode === 'interrupt') {
      assert(notifications.some(message => message.status === 'stopped'))
      assert.equal(nativeResults.length, mode === 'stop' ? 2 : 1)
    }
    if (mode === 'close' || mode === 'abort') assert.equal(notifications.length, 0, 'Force-close unexpectedly flushed a task terminal; inspect changed native lifecycle')
    if (mode === 'abort') assert(error.includes('aborted by user'))
    else assert.equal(error, '')
    if (mode === 'bash') {
      assert.equal(starts[0]?.task_type, 'local_bash')
      const output = readFileSync(notifications[0].output_file, 'utf8')
      assert(output.includes('OWNED_BASH_COMPLETE') && !output.includes('command not found'))
    }
  }
}
writeFileSync(join(root, 'results.json'), JSON.stringify({ version, sdkVersion, root, results }, null, 2))
console.log(JSON.stringify({ root, completedModes: modes }))

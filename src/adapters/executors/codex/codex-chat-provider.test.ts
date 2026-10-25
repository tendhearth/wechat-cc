import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classifyCall } from '../../../lib/call-classifier'
import { providerErrorCodeOf } from '../../../lib/provider-error-code'
import { createCodexChatProvider, codexChatToolCall, codexChatThreadConfig, CODEX_CAPABILITIES, type CodexChatProviderOptions } from './codex-chat-provider'
import { extractTurnReply } from '../../../domain/turn-reply'
import { collectTurn, type AgentEvent, type AgentSession, type SpawnContext } from '../../../ports/agent-provider'
import { TIER_PROFILES } from '../../../domain/user-tier'
import { TERMINAL_SAY_TOOL_TIMEOUT_MS } from '../../../core/mcp-stdio-spec'
import { createScriptedCodex, MCP_REJECTED, type ScriptedCodexOptions } from '../../../test-support/executors/codex-scripted'

/**
 * Codex 对话侧(B1 2026-10-25:SDK → app-server)。对面是照 app-server v2 形状演的剧本子进程
 * (test-support/executors/codex-scripted.ts),不起真 codex、不连网。
 */
const sessions: AgentSession[] = []
afterEach(async () => { for (const s of sessions.splice(0)) await s.close().catch(() => {}) })

const drain = async (events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> => { const out: AgentEvent[] = []; for await (const ev of events) out.push(ev); return out }
const ctx = (extra: Partial<SpawnContext> = {}): SpawnContext => ({ tierProfile: TIER_PROFILES.admin, permissionMode: 'dangerously', chatId: 'c', ...extra })
function rig(script: Partial<ScriptedCodexOptions> = {}, opts: CodexChatProviderOptions = {}) {
  const scripted = createScriptedCodex({ turns: [], ...script })
  const provider = createCodexChatProvider({ codexPathOverride: '/bin/codex', spawnProcess: scripted.spawn, rpcTimeoutMs: 2_000, closeTimeoutMs: 300, timeouts: { firstEventTimeoutMs: 5_000, connectTimeoutMs: 5_000 }, ...opts })
  const spawn = async (extra: Partial<SpawnContext> = {}, path = '/p') => { const s = await provider.spawn({ alias: 'a', path }, ctx(extra)); sessions.push(s); return s }
  return { scripted, provider, spawn }
}
const lastStart = (r: ReturnType<typeof rig>) => r.scripted.threadStarts.at(-1)!

describe('Codex 对话 provider —— 起会话(策略 / 模型 / 续接 / MCP)', () => {
  it('dangerously ⇒ danger-full-access + never(不看档位),且 MCP 免审', async () => {
    const r = rig({}, { dangerouslyBypassApprovalsAndSandbox: true, mcpServers: { wechat: { command: 'bun', args: ['wechat.ts'] } } })
    for (const tier of ['admin', 'trusted', 'guest'] as const) {
      await r.spawn({ tierProfile: TIER_PROFILES[tier] })
      expect(lastStart(r).params).toMatchObject({ sandbox: 'danger-full-access', approvalPolicy: 'never', config: { dangerously_bypass_approvals_and_sandbox: true, mcp_servers: { wechat: { default_tools_approval_mode: 'approve' } } } })
    }
  })

  it('strict:admin / trusted ⇒ workspace-write + never;guest ⇒ read-only + untrusted,联网搜索关;都不免审', async () => {
    const r = rig({}, { dangerouslyBypassApprovalsAndSandbox: true, mcpServers: { wechat: { command: 'bun' } } })
    await r.spawn({ permissionMode: 'strict' })
    expect(lastStart(r).params).toMatchObject({ sandbox: 'workspace-write', approvalPolicy: 'never' })
    expect(lastStart(r).params.config).not.toHaveProperty('dangerously_bypass_approvals_and_sandbox')
    expect((lastStart(r).params.config as any).mcp_servers.wechat).not.toHaveProperty('default_tools_approval_mode')
    await r.spawn({ permissionMode: 'strict', tierProfile: TIER_PROFILES.trusted })
    expect(lastStart(r).params).toMatchObject({ sandbox: 'workspace-write', approvalPolicy: 'never' })
    await r.spawn({ permissionMode: 'strict', tierProfile: TIER_PROFILES.guest })
    expect(lastStart(r).params).toMatchObject({ sandbox: 'read-only', approvalPolicy: 'untrusted', config: { web_search: 'disabled' } })
  })

  it('会话线程从不设 network_access(只有一次性评估设;e2e 假 codex 靠它认出 cheapEval)', async () => {
    const r = rig()
    await r.spawn()
    expect(JSON.stringify(lastStart(r).params)).not.toContain('network_access')
  })

  it('模型:每次 spawn 钉的优先,其次构造时的,都没有就不传', async () => {
    const r = rig({}, { model: 'gpt-construct' })
    await r.spawn({ model: 'gpt-pinned' })
    expect(lastStart(r).params.model).toBe('gpt-pinned')
    await r.spawn()
    expect(lastStart(r).params.model).toBe('gpt-construct')
    const bare = rig()
    await bare.spawn()
    expect(lastStart(bare).params).not.toHaveProperty('model')
  })

  it('resumeSessionId ⇒ thread/resume 同一个 id;续接不上 ⇒ 起新线程(不卡在坏 id 上)', async () => {
    const r = rig()
    await r.spawn({ resumeSessionId: 'th-old' })
    expect(lastStart(r)).toMatchObject({ method: 'thread/resume', params: { threadId: 'th-old' } })
    const bad = rig({ resumeFails: true })
    await bad.spawn({ resumeSessionId: 'th-gone' })
    expect(bad.scripted.threadStarts.map(t => t.method)).toEqual(['thread/resume', 'thread/start'])
  })

  it('系统指令走开发者指令槽,不再前置到第一条消息;没有就不带', async () => {
    const r = rig({ turns: [{ steps: [{ say: 'a' }] }, { steps: [{ say: 'b' }] }] })
    const s = await r.spawn({ appendInstructions: 'SYSTEM PROMPT' })
    expect(lastStart(r).params.developerInstructions).toBe('SYSTEM PROMPT')
    await drain(s.dispatch('第一句')); await drain(s.dispatch('第二句'))
    expect(r.scripted.inputs).toEqual(['第一句', '第二句'])
    await r.spawn()
    expect(lastStart(r).params).not.toHaveProperty('developerInstructions')
  })

  it('会话令牌 / 档位只并进核心 MCP(wechat / delegate)的 env,插件拿不到;令牌不进 argv', async () => {
    const r = rig({}, { mcpServers: { wechat: { command: 'bun', env: { A: '1' } }, plugin: { command: 'p' } } })
    await r.spawn({ mcpEnv: { WECHAT_SESSION_TOKEN: 'tok-secret', WECHAT_SESSION_TIER: 'trusted' } })
    const servers = (lastStart(r).params.config as any).mcp_servers
    expect(servers.wechat.env).toEqual({ A: '1', WECHAT_SESSION_TOKEN: 'tok-secret', WECHAT_SESSION_TIER: 'trusted' })
    expect(servers.plugin.env).toBeUndefined()
    expect(JSON.stringify(r.scripted.spawned)).not.toContain('tok-secret')
    expect(r.scripted.spawned.at(-1)!.args).toEqual(['app-server', '--listen', 'stdio://'])
  })

  it('delegate 的工具超时放宽;admin 会话的 wechat 放宽到 terminal_say 要等的时长,trusted 照旧', () => {
    const servers = { wechat: { command: 'w' }, delegate: { command: 'd' } }
    const admin = codexChatThreadConfig(servers, { tierProfile: TIER_PROFILES.admin, permissionMode: 'strict', mcpEnv: { WECHAT_SESSION_TIER: 'admin' } }, false) as any
    expect(admin.mcp_servers.delegate.tool_timeout_sec).toBe(600)
    expect(admin.mcp_servers.wechat.tool_timeout_sec).toBe(TERMINAL_SAY_TOOL_TIMEOUT_MS / 1000)
    const trusted = codexChatThreadConfig(servers, { tierProfile: TIER_PROFILES.trusted, permissionMode: 'strict', mcpEnv: { WECHAT_SESSION_TIER: 'trusted' } }, false) as any
    expect(trusted.mcp_servers.wechat).not.toHaveProperty('tool_timeout_sec')
  })

  it('codex 报回来的线程策略和要的不一样 ⇒ 不开(fail closed)', async () => {
    const scripted = createScriptedCodex({ turns: [], rewrite: m => m.result?.approvalPolicy === 'never' ? { ...m, result: { ...m.result, approvalPolicy: 'on-request' } } : m })
    const p = createCodexChatProvider({ codexPathOverride: '/bin/codex', spawnProcess: scripted.spawn, rpcTimeoutMs: 2_000, closeTimeoutMs: 300 })
    await expect(p.spawn({ alias: 'a', path: '/p' }, ctx())).rejects.toThrow(/codex_unverified_thread_policy/)
    expect(scripted.alive()).toBe(0)
  })
})

describe('Codex 对话 provider —— 一轮的事件', () => {
  it('init → text(整条、自成一段,不发逐字增量)→ result(sessionId = thread,numTurns 逐轮加一)', async () => {
    const r = rig({ turns: [{ steps: [{ think: '想' }, { say: '你好' }] }, { steps: [{ say: '再见' }] }] })
    const s = await r.spawn()
    const first = await drain(s.dispatch('hi'))
    expect(first.map(e => e.kind)).toEqual(['init', 'text', 'result'])
    expect(first[1]).toEqual({ kind: 'text', text: '你好', ownSegment: true })
    expect(first[2]).toMatchObject({ kind: 'result', sessionId: 'scripted-thread', numTurns: 1 })
    const second = await drain(s.dispatch('bye'))
    expect(second.at(-1)).toMatchObject({ kind: 'result', numTurns: 2 })
  })

  it('MCP 调用 ⇒ 一次 tool_call(server + tool);shell / 不认识的新条目也各一次;userMessage 不是工具', async () => {
    const r = rig({ turns: [{ steps: [{ mcp: { server: 'wechat', tool: 'list_projects' } }, { shell: 'ls' }, { notify: { method: 'item/started', params: { item: { id: 'x1', type: 'brandNewTool' } } } }, { say: '好' }] }] }, { dangerouslyBypassApprovalsAndSandbox: true })
    const s = await r.spawn()
    const calls = (await drain(s.dispatch('hi'))).filter(e => e.kind === 'tool_call')
    expect(calls).toEqual([
      { kind: 'tool_call', server: 'wechat', tool: 'list_projects' },
      { kind: 'tool_call', tool: 'shell' },
      { kind: 'tool_call', tool: 'brandNewTool' },
    ])
  })

  it('「我先跑个命令」→ shell →「结论」:shell 是分段边界 ⇒ 最后的话只有结论', async () => {
    const r = rig({ turns: [{ steps: [{ say: '我先跑个命令看看。' }, { shell: 'git status' }, { say: '工作区是干净的。' }] }] })
    const s = await r.spawn()
    const reply = extractTurnReply(await drain(s.dispatch('hi')))
    expect(reply.finalText).toBe('工作区是干净的。')
    expect(reply.narration).toEqual(['我先跑个命令看看。'])
  })

  it('两条消息之间只隔一段思考 ⇒ 照样各自成段;非致命的 error 条目永远不进文字', async () => {
    const r = rig({ turns: [{ steps: [{ say: '先说一句。' }, { think: 'x' }, { notify: { method: 'item/completed', params: { item: { id: 'e1', type: 'error', message: 'mcp server failed to start' } } } }, { say: '结论。' }] }] })
    const s = await r.spawn()
    const events = await drain(s.dispatch('hi'))
    expect(events.filter(e => e.kind === 'text').map(e => (e as { text: string }).text)).toEqual(['先说一句。', '结论。'])
    expect(extractTurnReply(events).finalText).toBe('结论。')
  })

  it('strict 下 codex 拒掉 MCP 调用:模型看得到失败、改用文字说 —— 失败的调用仍是一次 tool_call', async () => {
    const r = rig({ turns: [{ steps: [{ mcp: { server: 'wechat', tool: 'reply' }, ifRejected: [{ say: '我直接用文字说。' }] }] }] })
    const s = await r.spawn({ permissionMode: 'strict' })
    const events = await drain(s.dispatch('hi'))
    expect(events.filter(e => e.kind === 'tool_call')).toEqual([{ kind: 'tool_call', server: 'wechat', tool: 'reply' }])
    expect(extractTurnReply(events).finalText).toBe('我直接用文字说。')
    expect(MCP_REJECTED).toMatch(/approval policy is never/)
  })

  it('codex 发来的审批 / 提问 / MCP 表单请求一律拒,会话不停、这一轮照常完成', async () => {
    const r = rig({ turns: [{ steps: [
      { request: { method: 'item/commandExecution/requestApproval', params: { itemId: 'i1', command: 'rm -rf x', availableDecisions: ['accept', 'decline'] } } },
      { request: { method: 'item/tool/requestUserInput', params: { itemId: 'q1', questions: [] } } },
      { request: { method: 'mcpServer/elicitation/request', params: { serverName: 'wechat', mode: 'form' } } },
      { say: '没跑成,我换个办法。' },
    ] }] })
    const s = await r.spawn({ permissionMode: 'strict', tierProfile: TIER_PROFILES.guest })
    const events = await drain(s.dispatch('hi'))
    expect(r.scripted.responses).toEqual([
      { method: 'item/commandExecution/requestApproval', result: { decision: 'decline' } },
      { method: 'item/tool/requestUserInput', result: { answers: {} } },
      { method: 'mcpServer/elicitation/request', result: { action: 'decline', content: null, _meta: null } },
    ])
    expect(events.at(-1)).toMatchObject({ kind: 'result' })
  })

  it('close() 之后 dispatch 是空的', async () => {
    const r = rig()
    const s = await r.spawn()
    await s.close()
    expect(await drain(s.dispatch('hi'))).toEqual([])
    expect(r.scripted.alive()).toBe(0)
  })
})

describe('Codex 对话 provider —— 错误码 / 超时 / 取消 / 插话 / 进程没了', () => {
  it('凭证缺失 ⇒ auth_failed;401 ⇒ auth_rejected;额度耗尽 ⇒ quota(文本与 codexErrorInfo 两条路)', async () => {
    const cases: Array<[string, unknown, string]> = [
      ['unexpected status 401 Unauthorized: Missing bearer or basic authentication in header', null, 'auth_failed'],
      ['unexpected status 401 Unauthorized: Incorrect API key provided', null, 'auth_rejected'],
      ["You've hit your usage limit. Upgrade to Pro", null, 'quota'],
      ['limit', 'usageLimitExceeded', 'quota'],
      ['nope', 'unauthorized', 'auth_rejected'],
    ]
    for (const [fail, failInfo, code] of cases) {
      const r = rig({ turns: [{ steps: [{ say: '我先看一下。' }], fail, failInfo }] })
      const s = await r.spawn()
      const summary = await collectTurn(s.dispatch('hi'))
      expect(summary.errorCode, fail).toBe(code)
      expect(summary.finalText ?? '').toBe('我先看一下。')
    }
  })

  it('只认得出「凭证失效」措辞的错误 ⇒ 兜底 auth_failed(auth-fail 的 sdk-error 宽集合)', async () => {
    const r = rig({ turns: [{ steps: [], fail: 'Not logged in · Please run /login' }] })
    const s = await r.spawn()
    expect((await collectTurn(s.dispatch('hi'))).errorCode).toBe('auth_failed')
  })

  it('连不上(codex 一直在重连)⇒ connect 上限后以 network 码收尾,重连通知不下发', async () => {
    const r = rig({ turns: [{ steps: [{ reconnect: 'Reconnecting... 1/5 (stream disconnected)' }], hang: true }] }, { timeouts: { firstEventTimeoutMs: 10_000, connectTimeoutMs: 40 } })
    const s = await r.spawn()
    const events = await drain(s.dispatch('hi'))
    expect(events.filter(e => e.kind === 'error')).toEqual([expect.objectContaining({ code: 'network' })])
  })

  it('cancel() 中断这一轮(「已停止」收尾),之后的 dispatch 照常', async () => {
    const r = rig({ turns: [{ steps: [{ say: '开始' }], hang: true }, { steps: [{ say: '第二轮' }] }] })
    const s = await r.spawn()
    const first = drain(s.dispatch('long'))
    await new Promise(res => setTimeout(res, 30))
    await s.cancel!()
    const events = await first
    expect(events.at(-1)).toMatchObject({ kind: 'error', message: 'Codex 本轮已停止。' })
    const second = await drain(s.dispatch('again'))
    expect(second.at(-1)).toMatchObject({ kind: 'result' })
    expect(r.scripted.inputs).toEqual(['long', 'again'])
  })

  it('steer():把一句话插进正在跑的这一轮(turn/steer);没有在跑的轮 ⇒ 拒', async () => {
    const r = rig({ turns: [{ steps: [{ delayMs: 80 }, { say: '收到补充' }] }] })
    const s = await r.spawn()
    const run = drain(s.dispatch('做个事'))
    await new Promise(res => setTimeout(res, 30))
    await s.steer!('顺便把测试也跑了')
    await run
    expect(r.scripted.steers).toEqual(['顺便把测试也跑了'])
    await expect(s.steer!('晚了')).rejects.toThrow()
  })

  it('app-server 中途退出:这一轮带码(stderr 里的真因)收尾;下一轮换新进程续接同一个 thread', async () => {
    const r = rig({ turns: [{ steps: [{ crash: 'unexpected status 401 Unauthorized: Missing bearer or basic authentication' }] }, { steps: [{ say: '我回来了' }] }] })
    const s = await r.spawn()
    const first = await collectTurn(s.dispatch('hi'))
    expect(first.errorCode).toBe('auth_failed')
    const second = await drain(s.dispatch('again'))
    expect(second.at(-1)).toMatchObject({ kind: 'result', sessionId: 'scripted-thread' })
    expect(r.scripted.threadStarts.map(t => t.method)).toEqual(['thread/start', 'thread/resume'])
    expect(r.scripted.threadStarts[1]!.params.threadId).toBe('scripted-thread')
  })
})

describe('Codex 对话 provider —— 一次性评估', () => {
  it('只读、不给网、低推理、cheap 模型、临时目录;拼起所有助理消息;用完就关', async () => {
    const r = rig({ cheapAnswer: p => `答:${p}` })
    expect(await r.provider.cheapEval!('一加一')).toBe('答:一加一')
    expect(lastStart(r).params).toMatchObject({ sandbox: 'read-only', approvalPolicy: 'never', config: { web_search: 'disabled', model_reasoning_effort: 'low', sandbox_workspace_write: { network_access: false } } })
    expect(r.scripted.cheapPrompts).toEqual(['一加一'])
    expect(r.scripted.inputs).toEqual([])
    expect(r.scripted.alive()).toBe(0)
  })

  it('起不来 ⇒ 带码抛出(stderr 里的 401 ⇒ auth_rejected)', async () => {
    const scripted = createScriptedCodex({ turns: [], startupCrash: 'failed to connect to websocket: HTTP error: 401 Unauthorized' })
    const p = createCodexChatProvider({ codexPathOverride: '/bin/codex', spawnProcess: scripted.spawn, rpcTimeoutMs: 2_000, closeTimeoutMs: 300 })
    const err = await p.cheapEval!('x').catch(e => e)
    expect(providerErrorCodeOf(err)).toBe('auth_rejected')
  })
})

describe('守护:对话侧 Codex 的实际端点(2026-10-03 规矩,B1 起会话按 codex 自己报的有效配置)', () => {
  const withHome = (configToml: string, fn: (opts: { env: NodeJS.ProcessEnv; systemDir: null }) => Promise<void> | void) => async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-chat-target-'))
    try {
      const home = join(root, 'codex-home')
      mkdirSync(home, { recursive: true })
      writeFileSync(join(home, 'config.toml'), configToml)
      await fn({ env: { HOME: root, CODEX_HOME: home, OPENAI_BASE_URL: 'https://dashscope.aliyuncs.com/compatible-mode/v1' }, systemDir: null })
    } finally { rmSync(root, { recursive: true, force: true }) }
  }

  it('OPENAI_BASE_URL 指到国内网关、config 默认 ⇒ 起会话前的预测与 cheapEval 都按官方,需要保护', withHome('model = "gpt-5.5"\n', (o) => {
    const p = createCodexChatProvider({ codexTargetOptions: () => o })
    for (const t of [p.callTarget!('session', { model: 'gpt-5.5' }), p.callTarget!('cheapEval')]) {
      expect(t).toMatchObject({ provider: 'codex', baseUrl: null, exact: true })
      expect(classifyCall(t!)).toMatchObject({ protected: true, kind: 'official' })
    }
  }))

  it('config 自定义 provider 指到国内 ⇒ 预测不需要保护', withHome('model_provider = "ds"\n[model_providers.ds]\nname = "d"\nbase_url = "https://api.deepseek.com/v1"\n', (o) => {
    const p = createCodexChatProvider({ codexTargetOptions: () => o })
    expect(classifyCall(p.callTarget!('session')!)).toMatchObject({ protected: false, kind: 'domestic' })
  }))

  it('坏的 config.toml ⇒ unresolved ⇒ 需要保护', withHome('model_provider = \n', (o) => {
    const p = createCodexChatProvider({ codexTargetOptions: () => o })
    expect(classifyCall(p.callTarget!('session')!)).toMatchObject({ protected: true, kind: 'unresolved' })
  }))

  it('会话起来以后按 codex 自己 config/read 报的有效配置判(常驻进程,配置在起来那一刻定下)', async () => {
    const r = rig()
    const s = await r.spawn()
    expect(classifyCall(s.callTarget!()!)).toMatchObject({ protected: true, kind: 'official', host: 'api.openai.com' })
  })
})

describe('能力表 / 工具判定', () => {
  it('codexChatToolCall:消息 / 思考 / 用户消息 / 非致命 error 不是工具;shell / 改文件 / 搜索 / 计划 / 新类型都是', () => {
    for (const type of ['agentMessage', 'reasoning', 'userMessage', 'error', 'contextCompaction']) expect(codexChatToolCall({ type })).toBeNull()
    expect(codexChatToolCall({ type: 'mcpToolCall', server: 'wechat', tool: 'list_projects' })).toEqual({ kind: 'tool_call', server: 'wechat', tool: 'list_projects' })
    expect(codexChatToolCall({ type: 'commandExecution' })).toEqual({ kind: 'tool_call', tool: 'shell' })
    expect(codexChatToolCall({ type: 'fileChange' })).toEqual({ kind: 'tool_call', tool: 'apply_patch' })
    expect(codexChatToolCall({ type: 'webSearch' })).toEqual({ kind: 'tool_call', tool: 'web_search' })
    expect(codexChatToolCall({ type: 'somethingNew' })).toEqual({ kind: 'tool_call', tool: 'somethingNew' })
  })

  it('Codex 是编码型:取最后一段;不支持逐工具回调,可续接、可被 delegate', () => {
    expect(CODEX_CAPABILITIES.replyText).toBe('last_segment')
    expect(CODEX_CAPABILITIES.perToolCallback).toBe(false)
    expect(CODEX_CAPABILITIES.supportsResume).toBe(true)
  })
})

import { afterEach, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { createClaudeAgentProvider } from './claude/claude-agent-provider'
import { createOpenAiAgentProvider } from './openai/openai-agent-provider'
import { createGeminiAgentProvider } from './gemini/gemini-agent-provider'
import { scriptedOpenAiModel } from '../../test-support/executors/openai-scripted'
import { makeCheckupTurn } from '../../features/checkup/runner'
import type { CheckupSample } from '../../domain/butler-checkup'

afterEach(() => { vi.unstubAllEnvs() })

const inherited = {
  WECHAT_SESSION_TOKEN: 'CHECKUP_TOKEN_SECRET_CANARY',
  WECHAT_SESSION_TIER: 'CHECKUP_TIER_SECRET_CANARY',
  wechat_session_token: 'CHECKUP_LOWER_TOKEN_SECRET_CANARY',
  wechat_session_tier: 'CHECKUP_LOWER_TIER_SECRET_CANARY',
}
function poisonAmbientCredentials() {
  for (const [name, value] of Object.entries(inherited)) vi.stubEnv(name, value)
  vi.stubEnv('CC_CHECKUP_BENIGN', 'preserved')
}
const sample: CheckupSample = { kind: 'tool', prompt: 'A fictional checkup.', tool: 'checkup_lookup', input: { code: 'invented', place: 'paper city' }, estimatedTokens: 20 }
const target = { provider: 'offline', address: 'default', model: 'invented', windowTokens: 8192, windowKnown: false }

it('checkup runner to real Claude SDK spawn excludes inherited token/tier from argv and env', async () => {
  poisonAmbientCredentials()
  let projectPath: string | undefined
  let bridgeUrl: string | undefined
  // Capture only booleans and explicitly selected, non-secret options. A failure
  // must never print the subprocess environment or inherited credentials.
  let boundary: { argvLeak: boolean; envLeak: boolean; credentialKeys: boolean; benign: boolean; controls: boolean; fakeMcpOnly: boolean } | undefined
  const builder = vi.fn(async () => { throw Error('production MCP builder must not open') })
  const provider = createClaudeAgentProvider({ sdkOptionsForProject: builder, queryImpl: input => {
    projectPath = input.options?.cwd
    const server = input.options?.mcpServers?.wechat
    if (server && 'url' in server) bridgeUrl = server.url
    return query({ ...input, options: {
      ...input.options, executable: 'node', pathToClaudeCodeExecutable: '/offline/fake-claude.js',
      spawnClaudeCodeProcess: options => {
        const mcpArg = options.args.indexOf('--mcp-config')
        const mcp = mcpArg < 0 ? null : JSON.parse(options.args[mcpArg + 1]!)
        const env = options.env ?? process.env
        boundary = {
          argvLeak: options.args.some(arg => Object.values(inherited).some(secret => arg.includes(secret))),
          envLeak: Object.values(env).some(value => value && Object.values(inherited).some(secret => value.includes(secret))) === true,
          credentialKeys: Object.keys(env).some(name => /^WECHAT_SESSION_(TOKEN|TIER)$/i.test(name)),
          benign: env.CC_CHECKUP_BENIGN === 'preserved',
          controls: env.CLAUDE_CODE_DISABLE_AUTO_MEMORY === '1' && env.CLAUDE_CODE_DISABLE_CLAUDE_MDS === '1'
            && env.CLAUDE_CODE_MAX_OUTPUT_TOKENS === '4096' && env.CLAUDE_CODE_MAX_RETRIES === '0' && env.CLAUDE_CODE_RETRY_WATCHDOG === '0',
          fakeMcpOnly: JSON.stringify(mcp) === JSON.stringify({ mcpServers: { wechat: { type: 'http', url: bridgeUrl } } }),
        }
        throw Error('captured_offline_checkup_spawn')
      },
    } })
  } })
  await expect(makeCheckupTurn(() => provider)(sample, target, new AbortController().signal)).rejects.toThrow('captured_offline_checkup_spawn')
  expect(builder).not.toHaveBeenCalled()
  expect(boundary).toEqual({ argvLeak: false, envLeak: false, credentialKeys: false, benign: true, controls: true, fakeMcpOnly: true })
  expect(projectPath !== undefined && !existsSync(projectPath)).toBe(true)
})

it.each(['openai', 'gemini'] as const)('%s checkup runner bypasses production subprocess/tool factories with inherited credentials present', async kind => {
  poisonAmbientCredentials()
  const productionBridge = vi.fn(async () => { throw Error('production subprocess must not open') })
  const productionTools = vi.fn(() => { throw Error('production tools must not open') })
  const model = scriptedOpenAiModel([{ calls: [{ name: sample.tool, input: sample.input }] }, { text: 'done' }])
  const requests: unknown[] = []
  const generateContent = vi.fn(async (request: unknown) => {
    requests.push(request)
    return requests.length === 1 ? { functionCalls: [{ name: sample.tool, args: sample.input }] } : { text: 'done' }
  })
  const provider = kind === 'openai'
    ? createOpenAiAgentProvider({ makeChatModel: () => model.model, makeMcpBridge: productionBridge, makeBuiltins: productionTools })
    : createGeminiAgentProvider({ genai: { models: { generateContent } }, model: 'production-model', systemInstruction: 'production memory', mcpConnect: productionBridge, buildGate: productionTools })
  const result = await makeCheckupTurn(() => provider)(sample, target, new AbortController().signal)
  expect(result.toolCalls).toEqual([{ name: sample.tool, input: sample.input }])
  expect(result.text).toBe('done')
  expect(productionBridge).not.toHaveBeenCalled()
  expect(productionTools).not.toHaveBeenCalled()
  const payload = JSON.stringify(kind === 'openai' ? model.seen : requests)
  expect(Object.values(inherited).some(secret => payload.includes(secret))).toBe(false)
})

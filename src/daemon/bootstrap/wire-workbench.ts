import type { Options, CanUseTool } from '@anthropic-ai/claude-agent-sdk'
import type { Db } from '../../lib/db'
import { loadAgentConfig, modelForProvider } from '../../lib/agent-config'
import { findCodexBinary } from '../../lib/find-codex-binary'
import { createProviderRegistry } from '../../core/provider-registry'
import { createClaudeAgentProvider, tierProfileToClaudeSdkOpts, makeWorkbenchClaudeCanUseTool } from '../../core/claude-agent-provider'
import { createWorkbenchCodexProvider } from '../../core/workbench/codex-app-server'
import type { PermissionRelayDeps } from '../../core/permission-relay'
import { TIER_PROFILES } from '../../core/user-tier'
import { makeWorkbenchStore } from '../../core/workbench/store'
import { makeWorkbenchService } from '../../core/workbench/service'
import { loadCompanionConfig } from '../companion/config'
import type { Bootstrap } from './types'
import type { InternalApi } from '../internal-api/types'

/** Reuse transport/model setup, never the companion's prompt or bypass. */
export function workbenchClaudeOptions(base: Options, instructions: string, permit: CanUseTool): Options {
  return {
    ...base,
    ...tierProfileToClaudeSdkOpts(TIER_PROFILES.trusted,'strict'),
    mcpServers:{},
    settingSources:[],
    hooks:{},
    plugins:[],
    systemPrompt:{type:'preset',preset:'claude_code',append:instructions},
    canUseTool: async (tool,input,context) => tool.startsWith('mcp__')
      ? { behavior:'deny',message:'This task uses local files only. Messaging and companion memory tools are unavailable.' }
      : permit(tool,input,context),
  }
}

export function wireWorkbench(opts: {
  db: Db; stateDir: string; boot: Bootstrap; internalApi: Pick<InternalApi, 'mintSessionToken' | 'invalidateSession'>
  askUser: PermissionRelayDeps['askUser']; log: PermissionRelayDeps['log']
}) {
  const ownerChatId=() => loadCompanionConfig(opts.stateDir).default_chat_id ?? null
  const registry=createProviderRegistry()
  const claude=opts.boot.registry.get('claude')
  if (claude) registry.register('claude',createClaudeAgentProvider({
    sdkOptionsForProject(alias,path,tier,chatId,env,instructions,context) {
      const base=opts.boot.sdkOptionsForProject(alias,path,tier,chatId,env,instructions)
      const permit=makeWorkbenchClaudeCanUseTool(context?.requestPermission)
      return workbenchClaudeOptions(base,instructions ?? '',permit)
    },
  }),claude.opts)
  const codex=opts.boot.registry.get('codex')
  const binary=codex ? findCodexBinary() : null
  if (codex && binary) registry.register('codex',createWorkbenchCodexProvider({
    codexPathOverride:binary,
    model:modelForProvider(loadAgentConfig(opts.stateDir),'codex'),
    // The adapter discovers and explicitly disables inherited MCPs before
    // starting a private app-server with native task-scoped approval requests.
  }),codex.opts)
  return makeWorkbenchService({
    store:makeWorkbenchStore(opts.db),registry,stateDir:opts.stateDir,ownerChatId,
    defaultProvider:opts.boot.defaultProviderId,holdBusy:opts.boot.holdBusy,
    // Empty allowlist is deliberate: office tasks never send messages or read
    // personal memory through the daemon, even if a CLI discovers old config.
    mintSessionToken:key => opts.internalApi.mintSessionToken('trusted',key,{routeAllow:new Set()}),
    revokeSessionToken:key => opts.internalApi.invalidateSession(key),
  })
}

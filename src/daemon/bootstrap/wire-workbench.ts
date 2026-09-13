import {createClaudeHistoryReader} from '../../core/workbench/native-claude-history'
import {createCodexHistoryReader} from '../../core/workbench/native-codex-history'
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
import { readNativeClaudeTools, workbenchClaudeEnvironment, type NativeClaudeTools } from '../../core/workbench/claude-native-config'
import { claudeNativeCapabilityNotice } from '../../core/workbench/native-capability-notice'
import { loadCompanionConfig } from '../companion/config'
import type { Bootstrap } from './types'
import type { InternalApi } from '../internal-api/types'

/** Reuse transport/model setup, never the companion's prompt or bypass. */
export function workbenchClaudeOptions(base: Options, instructions: string, permit: CanUseTool, native: NativeClaudeTools = {servers:{},omitted:[]}): Options {
  const tier = tierProfileToClaudeSdkOpts(TIER_PROFILES.trusted,'strict')
  return {
    cwd:base.cwd, model:base.model, effort:base.effort, thinking:base.thinking, pathToClaudeCodeExecutable:base.pathToClaudeCodeExecutable,
    executable:base.executable, executableArgs:base.executableArgs,
    env:workbenchClaudeEnvironment(base.env),
    ...tier,
    allowDangerouslySkipPermissions:false,
    allowedTools:[],
    disallowedTools:[...(tier.disallowedTools ?? []),'mcp__wechat__*','mcp__delegate__*'],
    tools:{type:'preset',preset:'claude_code'},
    mcpServers:native.servers,
    strictMcpConfig:true,
    settingSources:['project','local'],
    settings:{
      ...native.nativeMcpPolicy,
      // Flag settings override disk env values. Empty values neutralize these
      // automatic companion pointers; this is not filesystem/process isolation.
      env:Object.fromEntries((native.privateEnvironmentKeys??[]).map(name=>[name,''])),
      disableAllHooks:true, disableSkillShellExecution:true,
      enabledPlugins:native.disabledPlugins ?? {},
      permissions:{defaultMode:'default',disableBypassPermissionsMode:'disable',
        ask:['Bash','Write','Edit','NotebookEdit','AskUserQuestion',...Object.keys(native.servers).map(name=>`mcp__${name}__*`)],
        deny:['mcp__wechat__*','mcp__delegate__*'],
      },
    },
    hooks:{},
    plugins:[],
    systemPrompt:{type:'preset',preset:'claude_code',append:instructions},
    canUseTool: async (tool,input,context) => tool.startsWith('mcp__') && !Object.keys(native.servers).some(name=>tool.startsWith(`mcp__${name}__`))
      ? {behavior:'deny',message:'This tool is not registered for the task.'}
      : permit(tool,input,context),
  }
}

export function wireWorkbench(opts: {
  db: Db; stateDir: string; boot: Bootstrap; internalApi: Pick<InternalApi, 'mintSessionToken' | 'invalidateSession'>
  executionConflict?:(path:string,providerId:string,nativeId:string|null)=>boolean
  askUser: PermissionRelayDeps['askUser']; log: PermissionRelayDeps['log']
}) {
  const ownerChatId=() => loadCompanionConfig(opts.stateDir).default_chat_id ?? null
  const registry=createProviderRegistry()
  const claude=opts.boot.registry.get('claude')
  if (claude) registry.register('claude',createClaudeAgentProvider({
    sdkOptionsForProject(alias,path,tier,chatId,env,instructions,context) {
      const base=opts.boot.sdkOptionsForProject(alias,path,tier,chatId,env,instructions)
      const native=readNativeClaudeTools(path)
      const notice=claudeNativeCapabilityNotice(native)
      if(notice)context?.reportNotice?.(notice)
      const permit=makeWorkbenchClaudeCanUseTool(context?.requestPermission,context?.requestUserInput,Object.keys(native.servers))
      return workbenchClaudeOptions(base,instructions ?? '',permit,native)
    },
  }),claude.opts)
  const codex=opts.boot.registry.get('codex')
  const binary=codex ? findCodexBinary() : null
  if (codex && binary) registry.register('codex',createWorkbenchCodexProvider({
    codexPathOverride:binary,
    model:modelForProvider(loadAgentConfig(opts.stateDir),'codex'),
    // The adapter discovers native tools, excludes companion services, and
    // routes admitted tool calls through this task's approval requests.
  }),codex.opts)
  return makeWorkbenchService({
    executionConflict:opts.executionConflict,
    nativeHistory:{claude:createClaudeHistoryReader(),...(binary?{codex:createCodexHistoryReader({codexPathOverride:binary})}:{})},
    store:makeWorkbenchStore(opts.db),registry,stateDir:opts.stateDir,ownerChatId,
    defaultProvider:opts.boot.defaultProviderId,holdBusy:opts.boot.holdBusy,
    // Empty allowlist is deliberate: office tasks never send messages or read
    // personal memory through the daemon, even if a CLI discovers old config.
    mintSessionToken:key => opts.internalApi.mintSessionToken('trusted',key,{routeAllow:new Set()}),
    revokeSessionToken:key => opts.internalApi.invalidateSession(key),
  })
}

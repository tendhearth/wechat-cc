import {createClaudeHistoryReader} from '../../core/workbench/native-claude-history'
import {createCodexHistoryReader} from '../../core/workbench/native-codex-history'
import type { Options, CanUseTool } from '@anthropic-ai/claude-agent-sdk'
import type { Db } from '../../lib/db'
import {join} from 'node:path'
import {listProjects} from '../../lib/project-registry'
import { loadAgentConfig, saveAgentConfig, modelForProvider } from '../../lib/agent-config'
import { findCodexBinary } from '../../lib/find-codex-binary'
import { createProviderRegistry, type ProviderRegistry } from '../../core/provider-registry'
import { createClaudeAgentProvider, tierProfileToClaudeSdkOpts, makeWorkbenchClaudeCanUseTool } from '../../core/claude-agent-provider'
import { createWorkbenchCodexProvider } from '../../core/workbench/codex-app-server'
import type { PermissionRelayDeps } from '../../core/permission-relay'
import { TIER_PROFILES } from '../../core/user-tier'
import { makeWorkbenchStore } from '../../core/workbench/store'
import { makeWorkbenchService } from '../../core/workbench/service'
import { ACP_CAPABILITIES, MANAGED_NATIVE_CAPABILITIES, UNATTENDED_CAPABILITIES } from '../../core/workbench/executor-capabilities'
import { readNativeClaudeTools, workbenchClaudeEnvironment, type NativeClaudeTools } from '../../core/workbench/claude-native-config'
import { claudeNativeCapabilityNotice } from '../../core/workbench/native-capability-notice'
import { loadCompanionConfig } from '../companion/config'
import type { Bootstrap } from './types'
import type { InternalApi } from '../internal-api/types'
import {registerWorkbenchApi} from './workbench-api'
import { makeUsageMonitor, parseClaudeUsage, parseCodexRateLimits, readClaudeOAuthToken } from '../../core/subscription-usage'
import { readCodexRateLimits } from '../../core/workbench/codex-history-rpc'
import { spawnSync } from '../../lib/runtime/process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { createAcpWorkbenchProvider } from '../../core/acp-workbench-provider'
import { resolveAcpAgent } from '../../core/acp/agents'
import { findOnPath } from '../../lib/util'

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

/** 免审执行者:只剩 agy(cursor 自 2026-09-17 起走 ACP,见 registerAcpExecutors)。 */
export function registerUnattendedExecutors(target: ProviderRegistry, source: Pick<ProviderRegistry, 'get'>): string[] {
  const registered: string[] = []
  for (const id of ['agy'] as const) {
    const entry = source.get(id)
    if (entry) {
      target.register(id, entry.provider, { ...entry.opts, workbench: UNATTENDED_CAPABILITIES })
      registered.push(id)
    }
  }
  return registered
}

/**
 * 走 ACP 的执行者:boot registry 有 cursor(对话侧的 print 模式 provider,证明用户装了 cursor-agent)
 * 且二进制能解析 ⇒ 工作台登记一个**新的** ACP provider(不是同一个实例;对话侧那个不动),
 * displayName/canResume 沿用 boot 的登记项。解析不到 ⇒ 不登记、不退回免审,记一行日志。
 */
export function registerAcpExecutors(target: ProviderRegistry, source: Pick<ProviderRegistry, 'get'>, config: { cursorAgentBin?: string },
  deps: { findOnPath?: (cmd: string) => string | null; create?: typeof createAcpWorkbenchProvider; log?: (tag: string, line: string) => void } = {}): string[] {
  const entry = source.get('cursor')
  if (!entry) return []
  const launch = resolveAcpAgent('cursor', config, deps.findOnPath ?? findOnPath)
  if (!launch) { deps.log?.('WORKBENCH', 'cursor: cursor-agent binary not resolvable — ACP executor not registered'); return [] }
  const provider = (deps.create ?? createAcpWorkbenchProvider)({ command: launch.command, args: launch.args, displayName: launch.displayName, log: deps.log })
  target.register('cursor', provider, { ...entry.opts, workbench: ACP_CAPABILITIES })
  return ['cursor']
}

/** 免审执行者一次性确认开关的落盘实现 —— 读写 agent-config.json 的
 *  `workbench_unattended_ack_at`(其余字段原样保留)。 */
export function makeUnattendedAckStore(stateDir: string): { get(): number | null; set(at: number): void } {
  return {
    get: () => loadAgentConfig(stateDir).workbench_unattended_ack_at ?? null,
    set: at => {
      const current = loadAgentConfig(stateDir)
      saveAgentConfig(stateDir, { ...current, workbench_unattended_ack_at: at })
    },
  }
}

export function wireWorkbench(opts: {
  db: Db; stateDir: string; boot: Bootstrap; internalApi: Pick<InternalApi, 'mintSessionToken' | 'invalidateSession'>
  executionConflict?:(path:string,providerId:string,nativeId:string|null)=>boolean
  askUser: PermissionRelayDeps['askUser']; log: PermissionRelayDeps['log']
  /** 「一件事」登记处:任务与 matter 一对一同步(可选,老接线不传)。 */
  matters?: import('../../core/matters/store').MatterStore
}) {
  // 订阅额度监视器:Codex 问 app-server,Claude 用 Claude Code 自己的 OAuth 凭据问 usage 接口(subscription-usage.ts)。
  const usageMonitor=makeUsageMonitor({sources:{
    ...(opts.boot.registry.has('codex')&&findCodexBinary()?{codex:async()=>{const r=await readCodexRateLimits({codexPathOverride:findCodexBinary()!});return r?parseCodexRateLimits(r,Date.now()):null}}:{}),
    ...(opts.boot.registry.has('claude')?{claude:async()=>{
      const cred=readClaudeOAuthToken({platform:process.platform,keychain:()=>spawnSync(['security','find-generic-password','-s','Claude Code-credentials','-w']).stdout.toString(),readFile:()=>readFileSync(join(homedir(),'.claude','.credentials.json'),'utf8'),now:Date.now})
      if(!cred)return null
      const r=await fetch('https://api.anthropic.com/api/oauth/usage',{headers:{authorization:`Bearer ${cred.token}`,'anthropic-beta':'oauth-2025-04-20'},signal:AbortSignal.timeout(8_000)})
      if(!r.ok)return null
      return parseClaudeUsage(await r.json().catch(()=>null),Date.now(),cred.plan)
    }}:{}),
  },ttlMs:5*60_000})

  const ownerChatId=() => loadCompanionConfig(opts.stateDir).default_chat_id ?? null
  const registry=createProviderRegistry()
  const agentConfig=loadAgentConfig(opts.stateDir)
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
  }),{...claude.opts,workbench:MANAGED_NATIVE_CAPABILITIES})
  const codex=opts.boot.registry.get('codex')
  const binary=codex ? findCodexBinary() : null
  if (codex && binary) registry.register('codex',createWorkbenchCodexProvider({
    codexPathOverride:binary,
    model:modelForProvider(loadAgentConfig(opts.stateDir),'codex'),
    // The adapter discovers native tools, excludes companion services, and
    // routes admitted tool calls through this task's approval requests.
  }),{...codex.opts,workbench:MANAGED_NATIVE_CAPABILITIES})
  if(opts.boot.registry.has('openai'))registerWorkbenchApi(registry,opts.db,opts.stateDir,agentConfig,process.env)
  registerAcpExecutors(registry,opts.boot.registry,agentConfig,{log:opts.log})
  registerUnattendedExecutors(registry,opts.boot.registry)
  return makeWorkbenchService({
    executionConflict:opts.executionConflict,
    nativeHistory:{claude:createClaudeHistoryReader(),...(binary?{codex:createCodexHistoryReader({codexPathOverride:binary})}:{})},
    store:makeWorkbenchStore(opts.db),registry,stateDir:opts.stateDir,ownerChatId,matters:opts.matters,log:opts.log,
    usage:(id)=>id==='claude'||id==='codex'?usageMonitor.cached(id):null,
    registeredProjects:()=>listProjects(join(opts.stateDir,'projects.json')),
    defaultProvider:opts.boot.defaultProviderId,holdBusy:opts.boot.holdBusy,
    // Empty allowlist is deliberate: office tasks never send messages or read
    // personal memory through the daemon, even if a CLI discovers old config.
    mintSessionToken:key => opts.internalApi.mintSessionToken('trusted',key,{routeAllow:new Set()}),
    revokeSessionToken:key => opts.internalApi.invalidateSession(key),
    unattendedAck:makeUnattendedAckStore(opts.stateDir),
    // 空闲自动收工的两档时长:用闭包读(同 ownerChatId),主人改了 agent-config.json 立刻生效;
    // 负数或非数由 service 侧当缺省处理。
    retainedIdleCloseMs:()=>loadAgentConfig(opts.stateDir).workbench_retained_idle_close_ms ?? 600_000,
    handoffGraceMs:()=>loadAgentConfig(opts.stateDir).workbench_handoff_grace_ms ?? 15_000,
  })
}

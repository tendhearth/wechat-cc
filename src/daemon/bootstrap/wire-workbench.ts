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
import { makeReportSink } from '../reports/report-sink'
import { makeRecollectSink } from '../recollection/recollect-sink'
import { makeJournal } from '../../core/journal-store'
import { wrapCheapEvalWithAuthFailCheck } from './index'
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
  /** 回报投递队列(task-3,2026-09-23):与 matters 一起有才接得上 ReportSink,单传一个不够。 */
  reportOutbox?: import('../reports/outbox').ReportOutboxStore
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
  const store=makeWorkbenchStore(opts.db)
  // 回报投递(task-3,2026-09-23):两样都要有才接得上——没有 matters 就没法建/追出生地,
  // 没有 reportOutbox 就没地方写;任一个缺,整条功能不存在(降级路径,同 matters 的老接线约定)。
  const reports=opts.matters&&opts.reportOutbox?makeReportSink({
    matters:opts.matters,outbox:opts.reportOutbox,
    taskTitle:id=>store.get(id).title,artifactCount:id=>store.artifacts(id).length,
    log:opts.log,
  }):undefined
  // 回忆(task-5,fix round 2,2026-09-23,复审新 Important ③):只要 matters 就接得
  // 上——journal 用 opts.db 现开(makeJournal 是无状态构造,跟 wire-social.ts 里
  // recordVisit/recordPostcard 同一惯例)。便宜模型**不用**上面这个 wireWorkbench 自己
  // 建的 workbench-local `registry`(那是 `createProviderRegistry()` 不带任何 opts 建
  // 的,丢了 cheapEvalProvider getter——`/set cheap` 和面板钉死的便宜模型对回忆完全无
  // 效、丢了 cheapEvalPreflight——2026-08-29 为根治"开机 spawn agy → 刷 token 撞超时 →
  // 弹浏览器 Google OAuth 页"而加的网络预检、也丢了 onProviderFailure/log 的失败诊
  // 断)。而工作台的这个 registry 里有 cheapEval 的只有 agy 和 claude(claude 还没传
  // claudeBin),意味着装了 agy 的机器上回忆恰好由 agy 来答——正是当年弹 OAuth 页那条
  // 路,这次还没有预检。改用 `opts.boot.registry`(已经在这个函数里到处用,见
  // :123/124/155/156/157),跟 pipeline-deps.ts:728 的管家判定同一惯例(同样调
  // `boot.registry.getCheapEval()`),不缓存 provider 本身、每次现取。
  const recollect=opts.matters?makeRecollectSink({
    matters:opts.matters,journal:makeJournal(opts.db),
    // fix round 3(评审 M6):跟 bootstrap/index.ts:1048 的 haikuEval/verdictEval
    // 同一处理——裸 getCheapEval() 拿到的候选没做过「登出/401 之类的认证失败
    // 别当成正常回复」这道检查,套上 wrapCheapEvalWithAuthFailCheck(导出复
    // 用,不重新发明)。它内部 assertNotAuthFailed 抛错时,maybeRecollect 的
    // try/catch 会当成真的调用失败留痕——跟"没有便宜模型"是两回事。
    cheapEval:()=>wrapCheapEvalWithAuthFailCheck(opts.boot.registry.getCheapEval(),opts.log)??null,
    ownerChatId,log:opts.log,
    // fix round 3(评审 M2):终态那一拍的模型调用是 fire-and-forget,没有
    // holdBusy 挡着的话空闲自动重启可能切在中间、这条回忆静默丢失且不留
    // 痕——已经在手边(opts.boot.holdBusy 这个函数在这个文件里到处用,见
    // 下面 makeWorkbenchService 传的那个),零新依赖。
    holdBusy:opts.boot.holdBusy,
  }):undefined
  return makeWorkbenchService({
    executionConflict:opts.executionConflict,
    nativeHistory:{claude:createClaudeHistoryReader(),...(binary?{codex:createCodexHistoryReader({codexPathOverride:binary})}:{})},
    store,registry,stateDir:opts.stateDir,ownerChatId,matters:opts.matters,reports,recollect,log:opts.log,
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

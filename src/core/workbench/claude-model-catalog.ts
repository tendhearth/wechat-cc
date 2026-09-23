import {query, type Options, type SDKUserMessage} from '@anthropic-ai/claude-agent-sdk'
import {AsyncQueue} from '../async-queue'
import {readNativeClaudeTools,workbenchClaudeEnvironment} from './claude-native-config'
import {claudeModelCatalog} from './native-model-catalog'

/** Initialize only: never feed a prompt, launch a tool, or persist an empty session. */
export async function discoverClaudeModels(base: Options, timeoutMs = 15_000) {
  const deadline=Date.now()+timeoutMs
  if (Date.now() >= deadline) throw new Error('model_catalog_unavailable')
  const input=new AsyncQueue<SDKUserMessage>(), abortController=new AbortController()
  const native=readNativeClaudeTools(base.cwd ?? process.cwd())
  const settings=typeof base.settings === 'object' ? base.settings : {}
  const options:Options={
    cwd:base.cwd,env:workbenchClaudeEnvironment(base.env),pathToClaudeCodeExecutable:base.pathToClaudeCodeExecutable,
    executable:base.executable,executableArgs:base.executableArgs,settingSources:base.settingSources,
    abortController,persistSession:false,tools:[],allowedTools:[],disallowedTools:['*'],
    mcpServers:{},strictMcpConfig:true,hooks:{},plugins:[],allowDangerouslySkipPermissions:false,permissionMode:'default',
    settings:{...settings,disableAllHooks:true,disableSkillShellExecution:true,enabledPlugins:{...native.disabledPlugins,...Object.fromEntries(Object.keys(settings.enabledPlugins ?? {}).map(name=>[name,false]))},env:{...settings.env,...Object.fromEntries((native.privateEnvironmentKeys??[]).map(name=>[name,'']))},permissions:{defaultMode:'default',disableBypassPermissionsMode:'disable',deny:['*']}},
    canUseTool:async()=>({behavior:'deny',message:'Model discovery does not permit tools.'}),
  }
  if (Date.now() >= deadline) throw new Error('model_catalog_unavailable')
  const session=query({prompt:input.iterable(),options})
  let timer:ReturnType<typeof setTimeout>|undefined
  try {
    return await Promise.race([
      session.supportedModels().then(claudeModelCatalog),
      new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('model_catalog_unavailable')),Math.max(0,deadline-Date.now()))}),
    ])
  } finally {
    clearTimeout(timer);input.end()
    try {session.close()} finally {abortController.abort()}
  }
}

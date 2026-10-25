import {mkdirSync} from 'node:fs'
import type {Db} from '../../lib/db'
import {executorCredential,executorMissingConfig} from '../../lib/executor-detect'
import type {ProviderRegistry} from '../../app/provider-registry'
import {createApiModel} from '../../adapters/executors/openai/api-model'
import {makeApiSessionStore} from '../../adapters/executors/openai/api-sessions'
import {apiTaskConnectionHash,createOpenAiWorkbenchProvider,validateApiTaskInput} from '../../adapters/executors/openai/openai-workbench-provider'
import {MANAGED_API_CAPABILITIES} from '../../domain/workbench/executor-capabilities'

/**
 * OpenAI 兼容执行者进一起做(架构终态 B2:和对话同一种会话,用途是「工作台」):只有文件工具,
 * 和 Claude / Codex 的工作台一样不给 wechat MCP。
 */
export function registerWorkbenchApi(
  registry:ProviderRegistry,
  db:Db,
  stateDir:string,
  config:{openaiBaseUrl?:string;openaiModel?:string},
  env:Record<string,string|undefined>,
  log?:(tag:string,line:string)=>void,
):boolean{
  const baseURL=config.openaiBaseUrl?.trim(),model=config.openaiModel?.trim(),apiKey=executorCredential('openai',env)
  if(executorMissingConfig('openai',config).length>0||!baseURL||!model||!apiKey)return false
  try{
    const connection={baseURL,apiKey,model}
    const configHash=apiTaskConnectionHash(connection)
    mkdirSync(stateDir,{recursive:true,mode:0o700})
    const provider=createOpenAiWorkbenchProvider({sessions:makeApiSessionStore(db),model:createApiModel(connection),configHash,configuredModel:model,baseURL,privateStateDir:stateDir,...(log?{log}:{})})
    registry.register('openai',provider,{displayName:`API · ${model}（文档与成果）`,canResume:provider.canResume,workbench:MANAGED_API_CAPABILITIES,validateWorkbenchInput:validateApiTaskInput})
    return true
  }catch{return false}
}

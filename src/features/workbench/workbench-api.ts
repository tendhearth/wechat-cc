import {mkdirSync} from 'node:fs'
import type {Db} from '../../lib/db'
import {executorCredential,executorMissingConfig} from '../../lib/executor-detect'
import type {ProviderRegistry} from '../../app/provider-registry'
import {createApiModel} from '../../adapters/executors/openai/api-model'
import {makeApiSessionStore} from '../../adapters/executors/openai/api-sessions'
import {apiTaskConnectionHash,createApiTaskProvider,validateApiTaskInput} from '../../adapters/executors/openai/api-task-provider'
import {MANAGED_API_CAPABILITIES} from '../../core/workbench/executor-capabilities'

export function registerWorkbenchApi(
  registry:ProviderRegistry,
  db:Db,
  stateDir:string,
  config:{openaiBaseUrl?:string;openaiModel?:string},
  env:Record<string,string|undefined>,
):boolean{
  const baseURL=config.openaiBaseUrl?.trim(),model=config.openaiModel?.trim(),apiKey=executorCredential('openai',env)
  if(executorMissingConfig('openai',config).length>0||!baseURL||!model||!apiKey)return false
  try{
    const connection={baseURL,apiKey,model}
    const configHash=apiTaskConnectionHash(connection)
    mkdirSync(stateDir,{recursive:true,mode:0o700})
    const provider=createApiTaskProvider({sessions:makeApiSessionStore(db),model:createApiModel(connection),configHash,configuredModel:model,baseURL,privateStateDir:stateDir})
    registry.register('openai',provider,{displayName:`API · ${model}（文档与成果）`,canResume:provider.canResume,workbench:MANAGED_API_CAPABILITIES,validateWorkbenchInput:validateApiTaskInput})
    return true
  }catch{return false}
}

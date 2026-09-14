import {mkdirSync} from 'node:fs'
import type {Db} from '../../lib/db'
import type {ProviderRegistry} from '../../core/provider-registry'
import {createApiModel} from '../../core/workbench/api-model'
import {makeApiSessionStore} from '../../core/workbench/api-sessions'
import {apiTaskConnectionHash,createApiTaskProvider} from '../../core/workbench/api-task-provider'
import {MANAGED_API_CAPABILITIES} from '../../core/workbench/executor-capabilities'

export function registerWorkbenchApi(
  registry:ProviderRegistry,
  db:Db,
  stateDir:string,
  config:{openaiBaseUrl?:string;openaiModel?:string},
  env:Record<string,string|undefined>,
):boolean{
  const baseURL=config.openaiBaseUrl?.trim(),model=config.openaiModel?.trim(),apiKey=env.WECHAT_OPENAI_API_KEY
  if(!baseURL||!model||!apiKey)return false
  try{
    const connection={baseURL,apiKey,model}
    const configHash=apiTaskConnectionHash(connection)
    mkdirSync(stateDir,{recursive:true,mode:0o700})
    const provider=createApiTaskProvider({sessions:makeApiSessionStore(db),model:createApiModel(connection),configHash,configuredModel:model,privateStateDir:stateDir})
    registry.register('openai',provider,{displayName:`API · ${model}（文档与成果）`,canResume:provider.canResume,workbench:MANAGED_API_CAPABILITIES})
    return true
  }catch{return false}
}

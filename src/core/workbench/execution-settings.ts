import type {Db} from '../../lib/db'
import type {AgentExecutionChoice,AgentExecutionObservation} from '../agent-provider'

export const PROVIDER_EXECUTION_CHOICE:Readonly<AgentExecutionChoice>={defaults:'provider',model:null,reasoningEffort:null}
export const NATIVE_EXECUTION_CHOICE:Readonly<AgentExecutionChoice>={defaults:'native',model:null,reasoningEffort:null}

/** Keep task.error as the diagnostic code; the conversation also reaches phone users. */
export function executionFailureMessage(code:string):string {
  const messages:Record<string,string>={
    execution_model_unsupported:'当前模型不可用，请重新选择模型，或使用自动。',
    execution_effort_unsupported:'这个模型不支持所选思考强度，请重新选择，或使用自动。',
    execution_model_unknown:'暂时无法确认当前模型，请明确选择一个模型后重试。',
    execution_image_unsupported:'所选模型不接收图片，请更换支持图片的模型，或移除图片。',
    model_catalog_invalid:'暂时无法读取模型，请重新读取后再选择；也可以使用自动。',
    model_catalog_unavailable:'暂时无法读取模型，请重新读取后再选择；也可以使用自动。',
  }
  return messages[code]??code
}

const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)
const identifier=(value:unknown,max:number):value is string=>typeof value==='string'&&value.length>0&&value.length<=max&&!/[\s\x00-\x1f\x7f]/u.test(value)
const choiceKeys=new Set(['defaults','model','reasoningEffort'])

/** Missing fields retain the supplied choice; explicit null means no task override. */
export function normalizeExecutionChoice(value:unknown,fallback:AgentExecutionChoice):AgentExecutionChoice {
  if(value!==undefined&&(!object(value)||Object.keys(value).some(key=>!choiceKeys.has(key))))throw Error('invalid_execution')
  const input=value===undefined?{}:value as Record<string,unknown>
  const defaults=Object.hasOwn(input,'defaults')?input.defaults:fallback.defaults
  const model=Object.hasOwn(input,'model')?input.model:fallback.model
  const reasoningEffort=Object.hasOwn(input,'reasoningEffort')?input.reasoningEffort:fallback.reasoningEffort
  if((defaults!=='provider'&&defaults!=='native')||(model!==null&&!identifier(model,200))||(reasoningEffort!==null&&!identifier(reasoningEffort,64)))throw Error('invalid_execution')
  return {defaults,model,reasoningEffort}
}
export const sameExecutionChoice=(a:AgentExecutionChoice,b:AgentExecutionChoice):boolean=>a.defaults===b.defaults&&a.model===b.model&&a.reasoningEffort===b.reasoningEffort

export interface RunExecution {
  taskId:string;runId:string;choice:AgentExecutionChoice;effective:AgentExecutionObservation|null
  createdAt:number;observedAt:number|null
}
interface RunRow {taskId:string;runId:string;choiceJson:string;effectiveJson:string|null;createdAt:number;observedAt:number|null}
const SELECT='SELECT task_id AS taskId,run_id AS runId,choice_json AS choiceJson,effective_json AS effectiveJson,created_at AS createdAt,observed_at AS observedAt FROM workbench_run_execution'
const publicRun=(row:RunRow|null):RunExecution|null=>{
  if(!row)return null
  const {choiceJson,effectiveJson,...run}=row
  return {...run,choice:normalizeExecutionChoice(JSON.parse(choiceJson),PROVIDER_EXECUTION_CHOICE),effective:effectiveJson?JSON.parse(effectiveJson) as AgentExecutionObservation:null}
}
function observation(value:AgentExecutionObservation):AgentExecutionObservation {
  if(!object(value)||Object.keys(value).some(key=>!['model','reasoningEffort','sessionId','source'].includes(key))||!identifier(value.model,200)||!['native_response','native_message','native_reroute'].includes(value.source)||
    (value.reasoningEffort!==undefined&&!identifier(value.reasoningEffort,64))||(value.sessionId!==undefined&&!identifier(value.sessionId,200)))throw Error('invalid_execution_observation')
  return {model:value.model,source:value.source,...(value.reasoningEffort!==undefined?{reasoningEffort:value.reasoningEffort}:{}),...(value.sessionId!==undefined?{sessionId:value.sessionId}:{})}
}

export function makeExecutionSettingsStore(db:Db){
  const choice=(taskId:string):AgentExecutionChoice=>{
    const row=db.query<{choiceJson:string},[string]>('SELECT execution_choice_json AS choiceJson FROM workbench_tasks WHERE id=?').get(taskId)
    if(!row)throw Error('not_found')
    return normalizeExecutionChoice(JSON.parse(row.choiceJson),PROVIDER_EXECUTION_CHOICE)
  }
  const run=(taskId:string,runId:string):RunExecution|null=>publicRun(db.query<RunRow,[string,string]>(SELECT+' WHERE task_id=? AND run_id=?').get(taskId,runId))
  return {
    choice,run,
    last:(taskId:string):RunExecution|null=>publicRun(db.query<RunRow,[string]>(SELECT+' WHERE task_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(taskId)),
    accept(taskId:string,runId:string,input:AgentExecutionChoice):void {
      if(!identifier(runId,200))throw Error('invalid_execution')
      const accepted=normalizeExecutionChoice(input,PROVIDER_EXECUTION_CHOICE)
      db.transaction(()=>{
        choice(taskId)
        const prior=publicRun(db.query<RunRow,[string]>(SELECT+' WHERE run_id=?').get(runId))
        if(prior){
          if(prior.taskId!==taskId||!sameExecutionChoice(prior.choice,accepted))throw Error('execution_conflict')
          // An old receipt replay must not rewind the choice retained by a newer run.
          return
        }
        const json=JSON.stringify(accepted)
        db.query('INSERT INTO workbench_run_execution(run_id,task_id,choice_json,created_at) VALUES(?,?,?,?)').run(runId,taskId,json,Date.now())
        db.query('UPDATE workbench_tasks SET execution_choice_json=? WHERE id=?').run(json,taskId)
      })()
    },
    observe(taskId:string,runId:string,value:AgentExecutionObservation):void {
      const json=JSON.stringify(observation(value))
      const prior=run(taskId,runId)
      if(!prior)throw Error('not_found')
      if(JSON.stringify(prior.effective)===json)return
      db.query('UPDATE workbench_run_execution SET effective_json=?,observed_at=? WHERE task_id=? AND run_id=?').run(json,Date.now(),taskId,runId)
    },
  }
}

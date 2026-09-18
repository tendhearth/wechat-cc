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
    attachment_image_unsupported:'附件图片格式不受支持（只收 PNG / JPEG / GIF / WebP）。',
    attachment_data_missing:'附件内容已变化或无法安全读取，请重新添加后再试。',
    api_task_attachment_unsupported:'这个 API 执行者暂不支持 PDF 或其他二进制附件。请改用文字、CSV、JSON 或图片。',
    api_task_attachment_invalid:'附件内容已变化或无法安全读取，请重新添加后再试。',
    api_task_input_invalid:'任务内容或附件超出 API 执行者的处理范围，请缩短内容或减少附件。',
    api_task_incomplete:'API 响应未完整结束，任务没有被标记为完成。请检查服务状态后重试。',
    api_task_response_invalid:'API 返回了无法安全继续的响应，任务已停止。请检查模型兼容性。',
    api_task_scope_changed:'任务文件夹已变化，为避免读写错误，API 执行者已停止。请重新打开任务。',
    api_task_cancelled:'API 任务已停止，没有继续执行后续操作。',
    api_task_step_limit:'API 任务达到步骤上限，尚未完整完成。请缩小任务范围后继续。',
    api_task_tool_unsupported:'模型请求了此执行者不支持的操作，任务已停止。请调整要求后继续。',
    api_task_tool_failed:'API 执行者未能完成已允许的文件操作。请查看任务记录后重试。',
    api_task_request_failed:'API 请求失败，任务没有被标记为完成。请检查端点和网络后重试。',
    api_task_close_unconfirmed:'API 请求尚未确认结束。请等待或重启服务后查看中断状态，不要重复提交。',
    api_task_private_scope:'所选文件夹与任务服务的私有状态目录重叠，无法安全开始。请选择具体的项目文件夹。',
    provider_quota_exhausted:'这家执行者的额度已用完，这一轮没有开始或没有完成。等额度恢复，或把这件事交给另一位执行者继续。',
    provider_rate_limited:'这家执行者暂时限流，这一轮没有完成。稍等几分钟再继续。',
    api_task_scope_invalid:'无法确认 API 任务的项目范围，任务没有开始。请重新打开项目后再试。',
    api_task_busy:'这个 API 会话正在处理另一轮，请等待当前轮结束。',
    api_task_closed:'这个 API 会话已经关闭，请从任务页面重新继续。',
  }
  const ACP_SESSION = 'Cursor 的 ACP 会话无法建立或中断，请确认 cursor-agent 是支持 acp 子命令的版本后重试。'
  const acp: Array<[string, string]> = [
    ['acp_auth_required', 'Cursor 登录态失效，请在电脑上跑一次 cursor-agent login 后再试。'],
    ['acp_resume_unsupported', '这个版本的 Cursor 不支持接着原会话，请带记录重新开始。'],
    ['acp_protocol_version_unsupported', ACP_SESSION], ['acp_session_failed', ACP_SESSION], ['acp_process_exited', ACP_SESSION],
    ['acp_process_start_failed', ACP_SESSION], ['acp_invalid_protocol_message', ACP_SESSION], ['acp_line_too_long', ACP_SESSION], ['acp_protocol_write_failed', ACP_SESSION],
    ['acp_session_closed', ACP_SESSION],
    ['acp_stop_max_tokens', 'Cursor 因输出长度上限停了下来，请缩小要求或分步进行。'],
    ['acp_stop_max_turn_requests', 'Cursor 因单轮请求次数上限停了下来，请缩小要求或分步进行。'],
    ['acp_stop_refusal', 'Cursor 拒绝了这项要求，没有继续。'],
    ['acp_resume_session_mismatch', 'Cursor 接上的不是原会话，已停止；请带记录重新开始。'],
    ['acp_rpc_timeout', 'Cursor 长时间没有响应，任务已停止；请检查 cursor-agent 是否正常后重试。'],
    ['acp_turn_already_running', 'Cursor 正在处理上一轮，请等它答复后再发。'],
    ['acp_attachments_unsupported', 'Cursor 执行者暂不支持附件，请移除附件后再试。'],
    ['acp_attachment_image_unsupported', '这个版本的 Cursor 不接收图片附件，请移除图片，或改用 Claude / Codex。'],
    ['acp_prompt_too_large', '附件太大，Cursor 一次接不下（上限约 4 MB），请压缩图片或分批发送。'],
  ]
  for (const [prefix, text] of acp) if (code === prefix || code.startsWith(`${prefix}:`)) return text
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

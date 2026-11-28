import {MatterPlanRequest,REQUEST_SCHEMAS} from '../../../../packages/protocol/src/desktop-api'
import type {PreparedPlanTarget} from '../../../adapters/workbench/matter-plan-input'

const stable=(value:unknown):unknown=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,stable(v)])):value
const normalize=(tool:string,input:unknown)=>{
  if(tool==='mcp__wechat__matter_plan'){
    const parsed=MatterPlanRequest.safeParse(input)
    if(parsed.success){const {requestId:_id,...content}=parsed.data;return content}
  }
  if(tool==='mcp__wechat__matter_handoff'){
    const parsed=REQUEST_SCHEMAS['POST /v1/matter/relay']!.safeParse(input)
    if(parsed.success)return parsed.data
  }
  if(tool==='mcp__wechat__matter_share'){
    const parsed=REQUEST_SCHEMAS['POST /v1/matter/share']!.safeParse(input)
    if(parsed.success)return parsed.data
  }
  return input
}
interface Approval {scope:string;approved:boolean;target?:PreparedPlanTarget}

/** Process-local bindings belong to live daemon turns; restart revokes the corresponding conversations/cards. */
export function matterApprovals(){
  const records=new Map<string,Approval>()
  const key=(scope:string,tool:string,input:unknown)=>JSON.stringify([scope,tool,stable(normalize(tool,input))])
  return {
    get(scope:string,tool:string,input:unknown){return records.get(key(scope,tool,input))},
    drop(scope:string){for(const [k,v] of records)if(v.scope===scope)records.delete(k)},
    preview(scope:string,input:unknown,target:PreparedPlanTarget){
      const tool='mcp__wechat__matter_plan'
      const prior=records.get(key(scope,tool,input))
      if(prior?.target)return
      const {target:entryTarget,projectName,projectPath,registrationPath,legs}=target
      const record={scope,approved:false,target:{target:entryTarget,projectName,projectPath,registrationPath,legs}}
      records.set(key(scope,tool,input),record)
      // 待登记的目标还没有工作台编号，批准只认出卡时的原请求。
      if(registrationPath)return
      const parsed=MatterPlanRequest.parse(input),{project:_project,isolation:_isolation,base:_base,...rest}=parsed
      records.set(key(scope,tool,{...rest,target:target.target,legs:target.legs.map(({executor,brief,parallel})=>parallel?{parallel,brief}:{executor,brief})}),record)
    },
    /** 用掉一次批准(开分享链接:点一次头只开一个)。 */
    consume(scope:string,tool:string,input:unknown){records.delete(key(scope,tool,input))},
    approve(scope:string,tool:string,input:unknown){const k=key(scope,tool,input),record=records.get(k);if(record)record.approved=true;else records.set(k,{scope,approved:true})},
  }
}

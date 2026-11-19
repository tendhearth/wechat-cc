import {createHash} from 'node:crypto'
import {realpathSync} from 'node:fs'
import type {z} from 'zod'
import {MatterPlanRequest} from '../../../packages/protocol/src/desktop-api'
import type {ProjectCatalogEntry} from './project-catalog'
import type {EntryTarget} from './task-entry'
import {validBaseBranch} from '../git/worktree-workspaces'

export type MatterPlanInput=z.infer<typeof MatterPlanRequest>
export interface PlanConversation {scope:string;path?:string}
export interface PlanCaller {sessionKey?:string;chatId?:string;provider?:string}
export interface PlanTarget {target:EntryTarget;projectName:string;projectPath:string}
export type PlanLegs=Array<{executor:string;brief:string}>
export interface PreparedPlanTarget extends PlanTarget {legs:PlanLegs}
export interface PlanExecutors {available:readonly string[];defaultProviderId:string|null}
export class PlanInputError extends Error {
  constructor(code:string,readonly projects?:ProjectCatalogEntry[],readonly executors?:readonly string[]){super(code)}
}

export function resolvePlanLegs(input:MatterPlanInput,executors:()=>PlanExecutors):PlanLegs {
  return input.legs.map(leg=>{
    if(leg.executor!==undefined)return {executor:leg.executor,brief:leg.brief}
    if(input.legs.length!==1)throw new PlanInputError('invalid_matter_plan')
    const {available,defaultProviderId}=executors()
    if(!defaultProviderId)throw new PlanInputError('unavailable_provider',undefined,available)
    return {executor:defaultProviderId,brief:leg.brief}
  })
}
const canonical=(path:string)=>{try{return realpathSync(path)}catch{return null}}

/** Resolve only registered/catalog entries. Never interpret a model-invented local target as cwd. */
export function resolvePlanTarget(input:MatterPlanInput,projects:ProjectCatalogEntry[],path?:string):PlanTarget {
  const fail=(code:string):never=>{throw new PlanInputError(code,projects)}
  const target=input.target
  if(input.project!==undefined&&target!==undefined)return fail('invalid_target')
  if(target?.kind==='managed'){
    if(input.isolation||input.base)return fail('invalid_target')
    return {target,projectName:'由 CC 安排',projectPath:'CC 受管工作区'}
  }
  if(target&&target.kind!=='project')return fail('invalid_target')
  const value=input.project??(target?.kind==='project'?target.projectId:undefined)
  let found:ProjectCatalogEntry[]=[]
  if(value!==undefined){
    found=projects.filter(p=>p.id===value)
    if(!found.length)found=projects.filter(p=>p.name.toLowerCase()===value.toLowerCase())
    if(!found.length){const resolved=canonical(value);if(resolved)found=projects.filter(p=>p.path===resolved)}
  }else if(target)return fail('invalid_target')
  else if(path){const resolved=canonical(path);if(resolved)found=projects.filter(p=>p.path===resolved)}
  if(found.length>1)return fail('matter_project_ambiguous')
  const project=found[0]
  if(!project)return fail('project_stale')
  const isolation=input.isolation??(target?.kind==='project'?target.isolation:undefined)
  const base=input.base??(target?.kind==='project'?target.base:undefined)
  if(base!==undefined&&(isolation!=='worktree'||!validBaseBranch(base)))return fail('invalid_target')
  return {target:{kind:'project',projectId:project.id,...(isolation?{isolation}:{}),...(base?{base}:{})},projectName:project.name,projectPath:project.path}
}

export function planRequestId(scope:string,input:{title:string;target:EntryTarget;legs:MatterPlanInput['legs']}):string {
  const hash=createHash('sha256').update(JSON.stringify(['matter-plan',scope,input.title,input.target,input.legs])).digest('hex')
  // Content-derived id in the existing entry's UUID v4 shape; no model-supplied identifiers.
  return `${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-8${hash.slice(17,20)}-${hash.slice(20,32)}`
}

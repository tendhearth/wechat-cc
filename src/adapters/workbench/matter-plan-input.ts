import {createHash} from 'node:crypto'
import {realpathSync} from 'node:fs'
import {basename,dirname,isAbsolute} from 'node:path'
import type {z} from 'zod'
import type {MatterPlaceChoice} from '../../../packages/protocol/src/workbench-errors'
import {MatterPlanRequest} from '../../../packages/protocol/src/desktop-api'
import type {ProjectCatalogEntry} from './project-catalog'
import {projectRegistrationId} from './project-catalog'
import {validateProjectRegistration} from './project-registration'
import type {PlaceRecord} from '../../domain/places'
import type {EntryTarget} from './task-entry'
import {validBaseBranch} from '../git/worktree-workspaces'

export type PlanPlace=Pick<PlaceRecord,'root'|'name'>
export type MatterPlanInput=z.infer<typeof MatterPlanRequest>
export interface PlanConversation {scope:string;path?:string}
export interface PlanCaller {sessionKey?:string;chatId?:string;provider?:string}
export interface PlanTarget {target:EntryTarget;projectName:string;projectPath:string;registrationPath?:string}
export type PlanLegs=Array<{executor:string;brief:string;parallel?:string[]}>
export interface PreparedPlanTarget extends PlanTarget {legs:PlanLegs}
export interface PlanExecutors {
  available:readonly string[]
  defaultProviderId:string|null
  defaultUnavailableReason?:{code:string;message:string}
}
export class PlanInputError extends Error {
  constructor(code:string,readonly projects?:ProjectCatalogEntry[],readonly executors?:readonly string[],readonly defaultUnavailableMessage?:string,readonly candidateNames?:readonly string[],readonly placeChoices?:readonly MatterPlaceChoice[]){super(code)}
}

export function resolvePlanLegs(input:MatterPlanInput,executors:()=>PlanExecutors):PlanLegs {
  return input.legs.map(leg=>{
    if('parallel' in leg)return {executor:leg.parallel[0]!,brief:leg.brief,parallel:leg.parallel}
    if(leg.executor!==undefined)return {executor:leg.executor,brief:leg.brief}
    if(input.legs.length!==1)throw new PlanInputError('invalid_matter_plan')
    const {available,defaultProviderId,defaultUnavailableReason}=executors()
    if(!defaultProviderId){
      const message=defaultUnavailableReason?.message??(available.length?'还没有连接默认执行者。':undefined)
      throw new PlanInputError('unavailable_provider',undefined,available,message)
    }
    return {executor:defaultProviderId,brief:leg.brief}
  })
}
const placeSelector=(root:string)=>'place:'+createHash('sha256').update(root).digest('hex').slice(0,32)

function parentNames(root:string):string[] {
  const names:string[]=[]
  for(let parent=dirname(root);parent!==dirname(parent);parent=dirname(parent)){
    names.push(basename(parent))
  }
  return names
}

function placeChoices(matches:readonly PlanPlace[]):MatterPlaceChoice[] {
  const names=matches.map(place=>isAbsolute(place.name)?basename(place.name)||'根目录':place.name)
  const parents=matches.map(place=>parentNames(place.root))
  const labels=names.map((name,i)=>{
    const others=names.flatMap((other,j)=>j!==i&&other===name?[parents[j]!]:[])
    if(!others.length)return name
    const ancestors=parents[i]!
    const parent=ancestors[0]||'根目录'
    if(others.every(other=>other[0]!==ancestors[0]))return `${name}（在 ${parent} 下）`
    // When parent names also coincide, include a distinguishing ancestor component.
    const qualifier=ancestors.find((ancestor,depth)=>depth>0&&others.every(other=>other[depth]!==ancestor))
    return qualifier?`${name}（在 ${parent} 下，上层目录有 ${qualifier}）`:`${name}（在 ${parent} 下）`
  })
  return matches.map((place,i)=>({
    label:labels.filter(label=>label===labels[i]).length===1?labels[i]!:`选项 ${i+1} · ${labels[i]}`,
    selector:placeSelector(place.root),
  }))
}

const canonical=(path:string)=>{try{return realpathSync(path)}catch{return null}}

/** The catalog takes priority. Only a stored place can supply an unregistered directory. */
export function resolvePlanTarget(input:MatterPlanInput,projects:ProjectCatalogEntry[],path?:string,places:()=>readonly PlanPlace[]=()=>[],ownerChatId=''):PlanTarget {
  const fail=(code:string):never=>{throw new PlanInputError(code,projects)}
  const parallel=input.legs.some(leg=>'parallel' in leg)
  const target=input.target
  if(input.project!==undefined&&target!==undefined)return fail('invalid_target')
  if(target?.kind==='managed'){
    if(parallel)return fail('matter_parallel_requires_project')
    if(input.isolation||input.base)return fail('invalid_target')
    return {target,projectName:'由 CC 安排',projectPath:'CC 受管工作区'}
  }
  if(target&&target.kind!=='project')return fail('invalid_target')
  const value=input.project??(target?.kind==='project'?target.projectId:undefined)
  let found:ProjectCatalogEntry[]=[]
  if(value!==undefined){
    found=projects.filter(p=>p.id===value)
    // Keep existing IDs, aliases, basenames and paths ahead of saved display names.
    if(!found.length)found=projects.filter(p=>(p.lookupName??p.name).toLowerCase()===value.toLowerCase())
    if(!found.length){const resolved=canonical(value);if(resolved)found=projects.filter(p=>p.path===resolved)}
    if(!found.length)found=projects.filter(p=>p.name.toLowerCase()===value.toLowerCase())
  }else if(target)return fail('invalid_target')
  else if(path){const resolved=canonical(path);if(resolved)found=projects.filter(p=>p.path===resolved)}
  if(found.length>1)return fail('matter_project_ambiguous')
  const project=found[0]

  const isolation=input.isolation??(target?.kind==='project'?target.isolation:undefined)??(parallel?'worktree':undefined)
  const base=input.base??(target?.kind==='project'?target.base:undefined)
  if(base!==undefined&&(isolation!=='worktree'||!validBaseBranch(base)))return fail('invalid_target')
  const options={...(isolation?{isolation}:{}),...(base?{base}:{})}
  if(project)return {target:{kind:'project',projectId:project.id,...options},projectName:project.name,projectPath:project.path}
  if(input.project===undefined)return fail('project_stale')
  const projectPaths=new Set(projects.map(p=>p.path))
  const known=places().filter(place=>!projectPaths.has(canonical(place.root)??place.root))
  const name=input.project.toLowerCase()
  const selected=known.find(place=>placeSelector(place.root)===input.project)
  const matches=selected?[selected]:known.filter(place=>place.name.toLowerCase()===name||basename(place.root)===input.project||place.root===input.project)
  if(matches.length>1){
    const choices=placeChoices(matches)
    throw new PlanInputError('matter_place_ambiguous',undefined,undefined,undefined,choices.map(choice=>choice.label),choices)
  }
  const place=matches[0]
  if(!place){
    const candidates=[...projects.map(p=>p.name),...known.map(p=>p.name)]
    throw new PlanInputError('project_stale',undefined,undefined,undefined,[...new Set(candidates)])
  }
  let registrationPath:string
  try{registrationPath=validateProjectRegistration({path:place.root,name:place.name})}
  catch(error){
    if(error instanceof Error&&error.message==='invalid_request')throw Error('matter_place_invalid_registration')
    if(error instanceof Error&&error.message==='invalid_path')throw Error('matter_place_invalid_path')
    throw error
  }
  const projectId=projectRegistrationId(ownerChatId,registrationPath)
  if(!projectId)throw Error('matter_place_invalid_path')
  return {target:{kind:'project',projectId,...options},projectName:place.name,projectPath:place.root,registrationPath}
}

export function planRequestId(scope:string,input:{title:string;target:EntryTarget;legs:PlanLegs|MatterPlanInput['legs']}):string {
  const hash=createHash('sha256').update(JSON.stringify(['matter-plan',scope,input.title,input.target,input.legs])).digest('hex')
  // Content-derived id in the existing entry's UUID v4 shape; no model-supplied identifiers.
  return `${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-8${hash.slice(17,20)}-${hash.slice(20,32)}`
}

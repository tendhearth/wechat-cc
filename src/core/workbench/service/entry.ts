/**
 * entry 域:桌面 / 手机「交办」入口 —— 受管工作目录、主人校验、创建回执,以及 entryOptions / entryReceipt / createEntry。
 * 从 service.ts 逐字搬来(Codex #129 加的域,按 spec §6「直接建 service/<domain>.ts」);只认 ctx。
 * 跨域依赖用已建好的域对象显式注入(同 execute.ts):createTask 来自 execute,projects / taskView 来自 view,
 * requireInput / requireEntryInput 来自 admission,quota 来自 quota。
 */
import { mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { readdirAnchored } from '../anchored-fs'
import { canonicalProject } from '../artifacts'
import type { EntryRecord } from '../entry-store'
import { executionFailureMessage, normalizeExecutionChoice, PROVIDER_EXECUTION_CHOICE } from '../execution-settings'
import { isWorkbenchExecutorCapabilities, isWorkbenchProviderId } from '../executor-capabilities'
import { normalizeInputRequestId, sameAttachments } from '../live-inputs'
import { createManagedWorkspaces, type ManagedWorkspaces } from '../managed-workspaces'
import { publicTask } from '../store'
import { canonicalEntryHash, composeEntryPrompt, parseEntryInput, type EntryContext, type EntryInput, type EntryOptions } from '../task-entry'
import { directoryIdentity } from './directory-identity'
import { baseBranchExists, ensureWorktree, planWorktree, repoRootOf, type WorktreePlan } from '../worktree-workspaces'
import type { ServiceCtx } from './ctx'
import type { EntryResult } from './types'
import type { AdmissionDomain } from './admission'
import type { ExecuteDomain } from './execute'
import type { QuotaDomain } from './quota'
import type { ViewDomain } from './view'

export interface EntryDomains { execute: ExecuteDomain; view: ViewDomain; admission: AdmissionDomain; quota: QuotaDomain }

export function makeEntryDomain(ctx:ServiceCtx, domains:EntryDomains) {
  const { store } = ctx
  const {createTask}=domains.execute
  const {taskView,projects}=domains.view
  const {requireInput,requireEntryInput,modelCatalog}=domains.admission
  const {quota}=domains.quota
  let managedWorkspaces:ManagedWorkspaces|undefined
  const managed=()=>{
    if(!ctx.deps.managedWorkspaceRoot)throw Error('entry_not_wired')
    return managedWorkspaces??=createManagedWorkspaces({root:ctx.deps.managedWorkspaceRoot,stateDir:ctx.stateDir})
  }
  const requireEntryOwner=(context:EntryContext)=>{
    if(!context.ownerKey||context.ownerKey!==ctx.deps.ownerChatId()||!['desktop','phone'].includes(context.surface))throw Error('invalid_entry_owner')
  }
  const entryResult=(record:EntryRecord):EntryResult=>{
    if(record.phase!=='accepted')throw Error('entry_not_accepted')
    const task=store.get(record.taskId)
    if(task.ownerChatId!==record.ownerKey)throw Error('invalid_entry_owner')
    return{receipt:{requestId:record.requestId,taskId:record.taskId,matterId:record.matterId,runId:record.runId,acceptedAt:record.acceptedAt},task:taskView(publicTask(task))}
  }
  function entryOptions(context:EntryContext):EntryOptions {
    if(!context.ownerKey||context.ownerKey!==ctx.deps.ownerChatId())return{status:'needs_connection',reason:{code:'invalid_entry_owner',message:'请先在电脑上配置主人身份。'},defaultProviderId:null,providers:[],projects:[]}
    const providers=ctx.deps.registry.list().flatMap(id=>{
      const p=ctx.deps.registry.get(id)
      if(!isWorkbenchProviderId(id)||!p||!isWorkbenchExecutorCapabilities(p.opts.workbench))return[]
      let reason:string|undefined
      try{requireInput(id,[],PROVIDER_EXECUTION_CHOICE);if(quota.exhausted(id))reason='provider_quota_exhausted'}catch(error){reason=error instanceof Error?error.message:'unavailable_provider'}
      return[{id,displayName:p.opts.displayName,available:!reason,...(reason?{unavailableReason:{code:reason,message:reason==='unattended_ack_required'?'请先在电脑上确认免审执行。':executionFailureMessage(reason)}}:{}),capabilities:structuredClone(p.opts.workbench)}]
    })
    const defaultProviderId=providers.find(p=>p.id===ctx.deps.defaultProvider&&p.available)?.id??null
    return{status:defaultProviderId?'ready':'needs_connection',...(!defaultProviderId?{reason:{code:'unavailable_provider',message:'请在电脑上连接默认执行者，或在更多选项中选择已连接的执行者。'}}:{}),defaultProviderId,providers,projects:projects()}
  }
  /** 独立工作区的位置:状态目录下,按项目编号 + 预约里的随机编号(前 8 位)。 */
  function worktreePlan(workspaceId:string,project:{id:string;path:string},base?:string):WorktreePlan {
    const repoRoot=repoRootOf(project.path)
    if(!repoRoot)throw Error('worktree_not_git')
    return planWorktree({stateDir:ctx.stateDir,projectId:project.id,projectPath:project.path,repoRoot,id:workspaceId.replace(/-/g,'').slice(0,8),...(base!==undefined?{base}:{})})
  }
  function entryReceipt(requestId:string,context:EntryContext):EntryResult|null {
    requireEntryOwner(context)
    const record=store.entryRequests.get(context.ownerKey,normalizeInputRequestId(requestId))
    return record?.phase==='accepted'?entryResult(record):null
  }
  function createEntry(value:EntryInput,context:EntryContext):EntryResult {
    requireEntryOwner(context)
    const input=parseEntryInput(value),hash=canonicalEntryHash(input)
    let record=store.entryRequests.get(context.ownerKey,input.requestId)
    if(record&&record.canonicalRequestHash!==hash)throw Error('creation_conflict')
    if(record?.phase==='accepted')return entryResult(record)
    ctx.ensureAccepting()
    if(!ctx.deps.matters)throw Error('entry_not_wired')
    const text=composeEntryPrompt(input)
    try{
      if(record&&record.createdAt<Date.now()-7*86400_000)throw Error('entry_expired')
      const prepared=store.attachments.prepareAcceptance(input.attachmentIds??[],undefined,input.draftId,ctx.stateDir,context)
     if(!record){
      const materialSnapshot=prepared.attachments
      const target=input.target,project=target.kind==='project'?projects().find(p=>p.id===target.projectId):null
      if(input.target.kind==='project'&&!project)throw Error('project_stale')
      const providerId=input.providerId??project?.providerId??ctx.deps.defaultProvider
      if(!providerId)throw Error('unavailable_provider')
      const execution=normalizeExecutionChoice(input.execution,PROVIDER_EXECUTION_CHOICE)
      requireEntryInput(providerId,materialSnapshot,execution,text)
      const isolated=input.target.kind==='project'&&input.target.isolation==='worktree'
      // 独立工作区(2026-10-07):不是 git 仓库就当场拒绝,不留一条半截的预约。路径留空到建好工作区再定:
      // 预约时算出的路径和建好后的真实路径在 Windows 上写法可能不同(8.3 短名 / 长名),先写死会被当成冲突。
      if(isolated&&!repoRootOf(project!.path))throw Error('worktree_not_git')
      // 指定了起点分支 ⇒ 预约前就核对它在不在,不留半截预约(10-08)
      const base=input.target.kind==='project'?input.target.base:undefined
      if(isolated&&base!==undefined&&!baseBranchExists(repoRootOf(project!.path)!,base))throw Error('worktree_base_missing')
      const workspaceId=input.target.kind==='managed'||isolated?randomUUID():null
      record=store.entryRequests.reserve({ownerKey:context.ownerKey,requestId:input.requestId,canonicalRequestHash:hash,target:input.target,
        workspaceId,resolvedPath:input.target.kind==='managed'?managed().resolvePath(workspaceId!):isolated?null:project?.path??null,directoryIdentity:project&&!isolated?directoryIdentity(project.path):null,
        providerId,execution,materialSnapshot})
     }
      // Another connection may have accepted between the initial read and reserve.
      if(record.phase==='accepted')return entryResult(record)
      if(record.createdAt<Date.now()-7*86400_000)throw Error('entry_expired')
      requireEntryInput(record.providerId,record.materialSnapshot,record.execution,text)
      const current=prepared.attachments
      if(!sameAttachments(current,record.materialSnapshot))throw Error('attachment_changed')
      const workspace=record.target.kind==='managed'?managed().ensure(record):null
      // 独立工作区:在派发前建好(幂等:同一个预约重试 ⇒ 同一个目录同一个分支)。
      const tree=record.target.kind==='project'&&record.target.isolation==='worktree'?(()=>{
        const p=projects().find(x=>x.id===(record!.target as {projectId:string}).projectId)
        if(!p)throw Error('project_stale')
        const plan=worktreePlan(record!.workspaceId!,p,(record!.target as {base?:string}).base)
        const path=ensureWorktree(plan)
        return {plan,path,directoryIdentity:directoryIdentity(path)}
      })():null
      const path=workspace?.path??tree?.path??record.resolvedPath!,identity=workspace?.directoryIdentity??tree?.directoryIdentity??record.directoryIdentity!
      if(!path||!identity||canonicalProject(path)!==path||directoryIdentity(path)!==identity)throw Error('invalid_path')
      record=store.entryRequests.allocate(context.ownerKey,input.requestId,path,identity)
      if(record.phase==='accepted')return entryResult(record)
      const frozen=record
      const verify=()=>{
        requireEntryOwner(context)
        if(workspace){
          managed().verify(workspace)
          if(readdirAnchored(workspace.path,[],'managed_workspace_unavailable').length)throw Error('managed_workspace_changed')
          managed().verify(workspace)
        }
        else if(canonicalProject(path)!==path||directoryIdentity(path)!==identity)throw Error('invalid_path')
      }
      createTask({path,providerId:frozen.providerId,text,title:input.title??(input.text.trim().slice(0,40)||current[0]!.name.slice(0,40)),execution:frozen.execution,draftId:input.draftId,attachmentIds:input.attachmentIds},(task,runId)=>{
        verify()
        store.entryRequests.accept(context.ownerKey,input.requestId,{taskId:task.id,matterId:task.id,runId,acceptedAt:Date.now(),resolvedPath:path,directoryIdentity:identity})
        if(tree)store.worktrees.record({taskId:task.id,projectPath:tree.plan.projectPath,repoRoot:tree.plan.repoRoot,root:tree.plan.root,branch:tree.plan.branch})
      },undefined,{
        // 独立工作区的目录不登记成项目:它属于源项目,侧栏按源项目归组(2026-10-07)。
        context,workspaceKind:frozen.target.kind==='managed'?'managed':'project',...(tree?{registerProject:false}:{}),fromChat:!!input.context,materials:current,
        beforeCreate:()=>{
          const latest=store.entryRequests.get(context.ownerKey,input.requestId)
          if(latest?.phase==='accepted')throw Error('entry_already_accepted')
          verify()
          requireEntryInput(frozen.providerId,frozen.materialSnapshot,frozen.execution,text)
          prepared.assertCurrent()
        },
        verifyDirectory:(acceptedPath,acceptedIdentity)=>{if(acceptedPath!==path||acceptedIdentity!==identity)throw Error('invalid_path');verify()},
      })
      return entryResult(store.entryRequests.get(context.ownerKey,input.requestId)!)
    }catch(error){
      // A racing winner is authoritative, but never commit a losing task along with it.
      const winner=store.entryRequests.get(context.ownerKey,input.requestId)
      if(winner?.phase==='accepted'&&winner.canonicalRequestHash===hash)return entryResult(winner)
      throw error
    }
  }

  /** 交办时可选的模型(2026-10-06,对标 Paseo / Orca 手机上选模型):按目录 id 找项目文件夹;由 CC 安排(managed)的问受管根目录。
   *  手机不给路径,只给项目 id —— 路径只在电脑上解析。 */
  async function entryModels(input:{providerId:string;projectId?:string},context:EntryContext){
    requireEntryOwner(context)
    const project=input.projectId?projects().find(p=>p.id===input.projectId):null
    if(input.projectId&&!project)throw Error('project_stale')
    const path=project?.path??ctx.deps.managedWorkspaceRoot
    if(!path)throw Error('entry_not_wired')
    if(!project)mkdirSync(path,{recursive:true,mode:0o700})
    return modelCatalog(input.providerId,path)
  }
  return { managed,requireEntryOwner,entryResult, entryOptions,entryReceipt,createEntry,entryModels }
}
export type EntryDomain = ReturnType<typeof makeEntryDomain>

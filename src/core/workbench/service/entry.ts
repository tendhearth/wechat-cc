/**
 * entry 域:桌面 / 手机「交办」入口 —— 受管工作目录、主人校验、创建回执,以及 entryOptions / entryReceipt / createEntry。
 * 从 service.ts 逐字搬来(Codex #129 加的域,按 spec §6「直接建 service/<domain>.ts」);只认 ctx。
 * 跨域依赖用已建好的域对象显式注入(同 execute.ts):createTask 来自 execute,projects / taskView 来自 view,
 * requireInput / requireEntryInput 来自 admission,quota 来自 quota。
 */
import { mkdirSync, existsSync } from 'node:fs'
import {dirname,join,isAbsolute,normalize} from 'node:path'
import {createGitRunner} from '../git-runner'
import {validateIsolatedConfiguration} from '../isolated-configuration'
import type {GitWorkspaceRecord} from '../git-workspace-store'
import type {CreateTask,WorkbenchTaskView} from './types'
import type {CreateWechatTask} from '../wechat-types'
import type {CreationReceipt} from '../creation-receipts'
import { createHash, randomUUID } from 'node:crypto'
import { readdirAnchored } from '../anchored-fs'
import { canonicalProject } from '../artifacts'
import type { EntryRecord } from '../entry-store'
import { executionFailureMessage, normalizeExecutionChoice, PROVIDER_EXECUTION_CHOICE } from '../execution-settings'
import { isWorkbenchExecutorCapabilities, isWorkbenchProviderId } from '../executor-capabilities'
import { normalizeInputRequestId, sameAttachments } from '../live-inputs'
import { createManagedWorkspaces, type ManagedWorkspaces } from '../managed-workspaces'
import { publicTask } from '../store'
import { canonicalEntryHash, canonicalEntryHashV2, composeEntryPrompt, parseEntryInput, type EntryContext, type EntryInput, type EntryOptions } from '../task-entry'
import { directoryIdentity } from './directory-identity'
import type { ServiceCtx } from './ctx'
import type { EntryResult } from './types'
import type { AdmissionDomain } from './admission'
import type { ExecuteDomain } from './execute'
import type { QuotaDomain } from './quota'
import type { ViewDomain } from './view'

type AcceptedEntry=EntryResult|{task:WorkbenchTaskView}
// Process-local admission coalescing spans service instances using the same durable state.
const pending=new Map<string,{hash:string;promise:Promise<AcceptedEntry>}>()

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
    if(!context.ownerKey||context.ownerKey!==ctx.deps.ownerChatId()||!['desktop','phone','wechat'].includes(context.surface))throw Error('invalid_entry_owner')
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
  let gitManager:ReturnType<typeof store.gitWorkspaceManager>|undefined
  const git=()=>{
    if(!ctx.deps.managedWorkspaceRoot)throw Error('entry_not_wired')
    return gitManager??=store.gitWorkspaceManager({root:join(ctx.deps.managedWorkspaceRoot,'GitWorkspaces'),stateDir:ctx.stateDir,
      validateConfiguration:input=>validateIsolatedConfiguration(input,ctx.deps.isolatedConfiguration)})
  }
  const gitSource=(path:string)=>{
    for(let at=path;;at=dirname(at)){
      if(existsSync(join(at,'.git'))||(existsSync(join(at,'HEAD'))&&existsSync(join(at,'objects'))))return true
      if(dirname(at)===at)return false
    }
  }
  const initialGitState=async(tree:GitWorkspaceRecord)=>{
    await git().verify(tree)
    const runner=createGitRunner()
    const state=await git().readGitState(tree.sourcePath)
    const status=await runner.run(tree.gitRoot,['status','--porcelain=v1','-z','--untracked-files=all'])
    const branch=await runner.run(tree.gitRoot,['symbolic-ref','--quiet','HEAD']).then(b=>b.toString('utf8').trim()).catch(()=>null)
    const unfinished=['MERGE_HEAD','CHERRY_PICK_HEAD','REVERT_HEAD','rebase-merge','rebase-apply','sequencer','BISECT_LOG'].some(name=>existsSync(join(tree.gitDir,name)))
    const masked=(await runner.run(tree.gitRoot,['ls-files','-v','-z'])).toString('utf8').split('\0').some(row=>row[0]==='S'||/^[a-z]/.test(row))
    const execution=await git().readGitState(tree.executionPath)
    const executionStatus=await runner.run(tree.worktreeRoot,['status','--porcelain=v1','-z','--untracked-files=all'])
    if(branch!==tree.sourceBranch||unfinished||masked||JSON.stringify(state)!==JSON.stringify(tree.sourceGitState)||status.toString('base64')!==tree.sourceStatus||execution.head!==tree.baseCommit||JSON.stringify(execution.index)!==JSON.stringify(tree.sourceGitState.index)||executionStatus.length)throw Error('git_workspace_changed')
    await git().verify(tree)
  }
  function entryReceipt(requestId:string,context:EntryContext):EntryResult|null {
    requireEntryOwner(context)
    const record=store.entryRequests.get(context.ownerKey,normalizeInputRequestId(requestId))
    return record?.phase==='accepted'?entryResult(record):null
  }
  type InternalEntry={legacyPath?:string;receiptDomain?:{kind:'wechat';accountId:string;commandHash:string};onAccepted?:(task:import('../store').StoredTask,runId:string)=>void;origin?:{matterId:string|null;messageId:string|null}}
  const requestHash=(value:EntryInput,internal?:InternalEntry)=>{const hash=canonicalEntryHashV2(value,internal?.legacyPath);return internal?.receiptDomain?createHash('sha256').update(JSON.stringify([hash,internal.receiptDomain])).digest('hex'):hash}
  async function acceptEntry(value:EntryInput,context:EntryContext,internal?:InternalEntry):Promise<AcceptedEntry> {
    requireEntryOwner(context)
    const input=parseEntryInput(value)
    let record=store.entryRequests.get(context.ownerKey,input.requestId)
    const hash=record&&!record.hashVersion?canonicalEntryHash(input):requestHash(input,internal)
    if(record&&record.canonicalRequestHash!==hash)throw Error('creation_conflict')
    if(record?.phase==='accepted')return entryResult(record)
    const wechatWinner=()=>{
      if(!internal?.receiptDomain)return null
      const receipt=store.creationReceipts.get(input.requestId)
      if(!receipt)return null
      if(receipt.ownerChatId!==context.ownerKey||receipt.accountId!==internal.receiptDomain.accountId||receipt.commandHash!==internal.receiptDomain.commandHash)throw Error('creation_conflict')
      return {task:taskView(publicTask(store.get(receipt.taskId)))}
    }
    const priorWechat=wechatWinner();if(priorWechat)return priorWechat
    if(input.target.kind==='project'&&input.target.base!==undefined)throw Error('worktree_base_unsupported')
    ctx.ensureAccepting()
    if(!ctx.deps.matters&&context.surface!=='wechat')throw Error('entry_not_wired')
    const text=composeEntryPrompt(input)
    try{
      if(record&&record.createdAt<Date.now()-7*86400_000)throw Error('entry_expired')
      const prepared=store.attachments.prepareAcceptance(input.attachmentIds??[],undefined,input.draftId,ctx.stateDir,context)
     if(!record){
      const materialSnapshot=prepared.attachments
      const target=input.target,project=internal?.legacyPath?{path:canonicalProject(internal.legacyPath),providerId:input.providerId}:target.kind==='project'?projects().find(p=>p.id===target.projectId):null
      if(input.target.kind==='project'&&!project)throw Error('project_stale')
      const providerId=input.providerId??project?.providerId??ctx.deps.defaultProvider
      if(!providerId)throw Error('unavailable_provider')
      const execution=normalizeExecutionChoice(input.execution,PROVIDER_EXECUTION_CHOICE)
      requireEntryInput(providerId,materialSnapshot,execution,text)
      const sourcePath=project?.path??null
      const rawMode=input.executionMode??'auto'
      const isolated=!!sourcePath&&(rawMode==='isolated'||(target.kind==='project'&&target.isolation==='worktree')||(rawMode==='auto'&&gitSource(sourcePath)))
      if(isolated&&!gitSource(sourcePath!))throw Error('git_workspace_source_unsupported')
      if(!sourcePath&&rawMode==='isolated')throw Error('git_workspace_source_unsupported')
      if(sourcePath&&!isolated)ctx.recovery?.admit(sourcePath)
      const isManaged=!sourcePath&&target.kind==='managed'
      const workspaceId=isManaged||isolated?randomUUID():null
      record=store.entryRequests.reserve({ownerKey:context.ownerKey,requestId:input.requestId,canonicalRequestHash:hash,target:input.target,
        hashVersion:2,...(internal?.receiptDomain?{receiptDomain:internal.receiptDomain}:{}),sourcePath,resolvedMode:isolated?'isolated':'project',...(internal?.legacyPath?{legacyPath:internal.legacyPath}:{}),
        workspaceId,resolvedPath:isManaged?managed().resolvePath(workspaceId!):isolated?null:sourcePath,directoryIdentity:sourcePath&&!isolated?directoryIdentity(sourcePath):null,
        providerId,execution,materialSnapshot})
     }
      // Another connection may have accepted between the initial read and reserve.
      if(record.phase==='accepted')return entryResult(record)
      if(record.createdAt<Date.now()-7*86400_000)throw Error('entry_expired')
      requireEntryInput(record.providerId,record.materialSnapshot,record.execution,text)
      const current=prepared.attachments
      if(!sameAttachments(current,record.materialSnapshot))throw Error('attachment_changed')
      if(!record.hashVersion&&record.target.kind==='project'&&record.target.isolation==='worktree')throw Error('git_workspace_needs_recovery')
      const workspace=record.target.kind==='managed'&&!record.legacyPath?managed().ensure(record):null
      const tree=record.resolvedMode==='isolated'?await git().prepare({workspaceId:record.workspaceId!,ownerKey:context.ownerKey,requestId:input.requestId,canonicalRequestHash:hash,sourcePath:record.sourcePath!,providerId:record.providerId}):null
      const winner=store.entryRequests.get(context.ownerKey,input.requestId)
      if(winner?.phase==='accepted')return entryResult(winner)
      const concurrentWechat=wechatWinner();if(concurrentWechat)return concurrentWechat
      if(tree)await initialGitState(tree)
      const path=workspace?.path??tree?.executionPath??record.resolvedPath!,identity=workspace?.directoryIdentity??tree?.executionIdentity??record.directoryIdentity!
      if(!path||!identity||canonicalProject(path)!==path||directoryIdentity(path)!==identity)throw Error('invalid_path')
      record=store.entryRequests.allocate(context.ownerKey,input.requestId,path,identity)
      if(record.phase==='accepted')return entryResult(record)
      const frozen=record
      const verify=()=>{
        requireEntryOwner(context)
        if(tree&&(canonicalProject(tree.sourcePath)!==tree.sourcePath||directoryIdentity(tree.sourcePath)!==tree.sourceIdentity))throw Error('git_workspace_changed')
        if(workspace){
          managed().verify(workspace)
          if(readdirAnchored(workspace.path,[],'managed_workspace_unavailable').length)throw Error('managed_workspace_changed')
          managed().verify(workspace)
        }
        else if(canonicalProject(path)!==path||directoryIdentity(path)!==identity)throw Error('invalid_path')
      }
      createTask({path,providerId:frozen.providerId,text,title:input.title??(input.text.trim().slice(0,40)||current[0]!.name.slice(0,40)),execution:frozen.execution,draftId:input.draftId,attachmentIds:input.attachmentIds},(task,runId)=>{
        verify()
        if(context.surface!=='wechat'||ctx.deps.matters)store.entryRequests.accept(context.ownerKey,input.requestId,{taskId:task.id,matterId:task.id,runId,acceptedAt:Date.now(),resolvedPath:path,directoryIdentity:identity})
        internal?.onAccepted?.(task,runId)
      },internal?.origin,{
        // Bind execution to the workspace; store.create registers only its source project.
        context,workspaceKind:frozen.target.kind==='managed'&&!frozen.legacyPath?'managed':'project',...(tree?{gitWorkspaceId:tree.id}:{}),fromChat:!!input.context,materials:current,
        beforeCreate:()=>{
          const latest=store.entryRequests.get(context.ownerKey,input.requestId)
          if(latest?.phase==='accepted'||wechatWinner())throw Error('entry_already_accepted')
          verify()
          requireEntryInput(frozen.providerId,frozen.materialSnapshot,frozen.execution,text)
          prepared.assertCurrent()
        },
        verifyDirectory:(acceptedPath,acceptedIdentity)=>{if(acceptedPath!==path||acceptedIdentity!==identity)throw Error('invalid_path');verify()},
      })
      const accepted=store.entryRequests.get(context.ownerKey,input.requestId)!
      if(context.surface==='wechat'&&accepted.phase!=='accepted'){const receipt=store.creationReceipts.get(input.requestId)!;return{task:taskView(publicTask(store.get(receipt.taskId)))}}
      return entryResult(accepted)
    }catch(error){
      // A racing winner is authoritative, but never commit a losing task along with it.
      const winner=store.entryRequests.get(context.ownerKey,input.requestId)
      if(winner?.phase==='accepted'&&winner.canonicalRequestHash===hash)return entryResult(winner)
      const concurrentWechat=wechatWinner();if(concurrentWechat)return concurrentWechat
      throw error
    }
  }

  // Same-key calls share allocation in this process. Independent connections still arbitrate in SQLite.
  async function createEntry(value:EntryInput,context:EntryContext):Promise<EntryResult>{const result=await keyed(value,context);if(!('receipt' in result))throw Error('entry_not_accepted');return result}
  function keyed(value:EntryInput,context:EntryContext,internal?:InternalEntry):Promise<AcceptedEntry>{
    let hash:string,key:string
    try{requireEntryOwner(context);hash=requestHash(value,internal);key=JSON.stringify([ctx.stateDir,context.ownerKey,normalizeInputRequestId(value.requestId)])}catch(error){return Promise.reject(error)}
    const previous=pending.get(key)
    if(previous)return previous.hash===hash?previous.promise:Promise.reject(Error('creation_conflict'))
    const promise=acceptEntry(value,context,internal)
    pending.set(key,{hash,promise});void promise.finally(()=>{if(pending.get(key)?.promise===promise)pending.delete(key)}).catch(()=>{})
    return promise
  }
  function create(input:CreateTask & {requestId:string}):Promise<WorkbenchTaskView>
  function create(input:CreateTask & {requestId?:undefined}):WorkbenchTaskView
  function create(input:CreateTask):WorkbenchTaskView|Promise<WorkbenchTaskView>
  function create(input:CreateTask):WorkbenchTaskView|Promise<WorkbenchTaskView>{
    if(Object.hasOwn(input,'base')||Object.hasOwn(input,'fromBranch'))throw Error('worktree_base_unsupported')
    if(input.requestId===undefined){
      if(input.executionMode!==undefined&&input.executionMode!=='project')throw Error('invalid_request_id')
      return domains.execute.create(input)
    }
    return createKeyed(input)
  }
  async function createKeyed(input:CreateTask):Promise<WorkbenchTaskView>{
    if(typeof input.path!=='string'||!isAbsolute(input.path))throw Error('invalid_path')
    const requestId=normalizeInputRequestId(input.requestId!),ownerKey=ctx.deps.ownerChatId()??'',prior=store.entryRequests.get(ownerKey,requestId)
    const path=normalize(input.path)
    if(prior&&prior.sourcePath!==path&&prior.legacyPath!==path)throw Error('creation_conflict')
    const project=prior?null:projects().find(p=>p.path===path)
    const target=prior?.target??(project?{kind:'project' as const,projectId:project.id}:{kind:'managed' as const})
    const legacyPath=prior?.legacyPath??(!prior&&!project?path:undefined)
    const {path:_path,...value}=input
    const result=await keyed({...value,requestId,target},{ownerKey,surface:'desktop'},legacyPath?{legacyPath}:undefined)
    return result.task
  }
  async function createWechat(input:CreateWechatTask):Promise<CreationReceipt>{
    if(!input.ownerChatId||ctx.deps.ownerChatId()!==input.ownerChatId||!input.accountId?.trim())throw Error('invalid_wechat_identity')
    const id=normalizeInputRequestId(input.requestId)
    if(!/^[a-f0-9]{64}$/.test(input.commandHash))throw Error('invalid_request')
    const value:EntryInput={requestId:id,text:input.text,target:{kind:'project',projectId:input.projectId,...(input.isolation?{isolation:'worktree' as const}:{}),...(input.base!==undefined?{base:input.base}:{})},...(input.providerId?{providerId:input.providerId}:{}),...(input.executionMode?{executionMode:input.executionMode}:{})}
    const receiptDomain={kind:'wechat' as const,accountId:input.accountId,commandHash:input.commandHash}
    const prior=store.creationReceipts.get(id)
    if(prior){
      if(prior.ownerChatId!==input.ownerChatId||prior.accountId!==input.accountId||prior.commandHash!==input.commandHash)throw Error('creation_conflict')
      if(store.get(prior.taskId).ownerChatId!==input.ownerChatId)throw Error('invalid_wechat_identity')
      const reserved=store.entryRequests.get(input.ownerChatId,id)
      if(reserved?.receiptDomain&&reserved.canonicalRequestHash!==requestHash(value,{receiptDomain}))throw Error('creation_conflict')
      return prior
    }
    await keyed(value,{ownerKey:input.ownerChatId,surface:'wechat'},{
      receiptDomain,
      origin:{matterId:domains.execute.safeOriginMatterId(input.ownerChatId),messageId:input.originMessageId??null},
      onAccepted:(task,runId)=>{
        if(store.creationReceipts.get(id))throw Error('creation_conflict')
        store.wechatNotifications.watch(task.id,input.ownerChatId,input.accountId,true)
        const workspace=store.gitWorkspaceForTask(task.id)
        const workspaceHint=workspace?`\n\n在独立分支 ${workspace.branch} 上做。\n提交：任务 ${task.id} 提交\n查看改动或导出补丁：请在桌面工作台操作。`:''
        store.creationReceipts.add({id,accountId:input.accountId,ownerChatId:input.ownerChatId,commandHash:input.commandHash,projectId:input.projectId,path:task.path,providerId:task.providerId,taskId:task.id,runId,
          reply:`已接下这件事 · ${task.id}\n${task.providerId} · ${task.path}\n\n${task.title}${workspaceHint}\n\n完成或需要你处理时，会在这里提醒。\n查看：任务 ${task.id}\n补充：任务 ${task.id} 补充 <要求>\n关闭提醒：任务 ${task.id} 静音`})
      }})
    const receipt=store.creationReceipts.get(id)
    if(!receipt||receipt.ownerChatId!==input.ownerChatId||receipt.accountId!==input.accountId||receipt.commandHash!==input.commandHash)throw Error('creation_conflict')
    return receipt
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
  return { managed,requireEntryOwner,entryResult, entryOptions,entryReceipt,createEntry,create,createWechat,entryModels }
}
export type EntryDomain = ReturnType<typeof makeEntryDomain>

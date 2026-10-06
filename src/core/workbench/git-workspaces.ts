import type {SqlDatabase} from '../../lib/runtime/sqlite'
import type {GitWorkspacePrepareInput,GitWorkspaceRecord,GitState} from './git-workspace-store'
export type {GitWorkspacePrepareInput,GitWorkspaceRecord,GitState} from './git-workspace-store'
export interface GitWorkspaceOptions {db:SqlDatabase;root:string;stateDir:string;timeoutMs?:number;validateConfiguration?:(input:{sourcePath:string;executionPath:string;providerId:string})=>Promise<string>}

import {createHash,randomUUID} from 'node:crypto'
import {closeSync,constants,existsSync,fstatSync,lstatSync,mkdirSync,mkdtempSync,openSync,realpathSync,readdirSync,rmdirSync,unlinkSync,writeFileSync} from 'node:fs'
import {isAbsolute,join,parse,relative,resolve,sep} from 'node:path'
import {createGitRunner,type GitRunner} from './git-runner'
import {createGitWorkspaceStore} from './git-workspace-store'
import {O_NONBLOCK,isPlainPart,mkdirAnchored,openAnchored,readBounded,verifyChain,verifyFromFilesystemRoot} from './anchored-fs'

const CHANGED='git_workspace_changed',RECOVERY='git_workspace_needs_recovery',CONFLICT='git_workspace_conflict',UNSUPPORTED='git_workspace_source_unsupported'
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const MAX_RAW=16*1024*1024,MAX_FILES=50_000
const digest=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex')
const within=(root:string,path:string)=>{const delta=relative(root,path);return !isAbsolute(delta)&&delta!=='..'&&!delta.startsWith('..'+sep)}
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b)
const physical=(path:string)=>{
  if(!isAbsolute(path)||path.includes('\0')||path.split(/[\\/]/).some(part=>part==='.'||part==='..')||(process.platform!=='win32'&&path.includes('\\')))throw Error(CHANGED)
  const result=realpathSync(path);verifyFromFilesystemRoot(result,CHANGED);if(resolve(path)!==result)throw Error(CHANGED)
  return result
}
const directoryIdentity=(path:string)=>{const stat=verifyFromFilesystemRoot(path,CHANGED).stat;return `${stat.dev}:${stat.ino}`}
const text=(bytes:Buffer)=>{const decoded=bytes.toString('utf8');if(!Buffer.from(decoded).equals(bytes))throw Error(CHANGED);return decoded}
const fields=(bytes:Buffer)=>text(bytes).split('\0').filter(Boolean)
const internal=(path:string)=>path.split('/').some(part=>/^\.cc-workbench/i.test(part))
function nearest(path:string):{path:string;identity:string} {
  if(!isAbsolute(path)||path.split(/[\\/]/).some(part=>part==='.'||part==='..'))throw Error(CHANGED)
  let cursor=resolve(path)
  while(!existsSync(cursor)){const parent=resolve(cursor,'..');if(parent===cursor)throw Error(CHANGED);cursor=parent}
  return {path:physical(cursor),identity:directoryIdentity(cursor)}
}

// In-process sequencing plus an exclusive, verifiable common-dir lock. Stale
// locks are left for explicit recovery rather than guessing who owns a live process.
const queues=new Map<string,Promise<void>>()
async function withAllocationLock<T>(record:GitWorkspaceRecord,onBlocked:()=>void,operation:()=>Promise<T>):Promise<T> {
  const commonDir=record.commonDir
  const prior=queues.get(commonDir)??Promise.resolve();let release!:()=>void
  const current=new Promise<void>(done=>{release=done});const queued=prior.then(()=>current);queues.set(commonDir,queued)
  await prior
  const path=join(commonDir,'cc-workbench-allocation.lock');let fd:number|undefined
  try{
    try{fd=openSync(path,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY,0o600)}catch{onBlocked();throw Error(RECOVERY)}
    writeFileSync(fd,JSON.stringify({pid:process.pid,token:randomUUID(),workspaceId:record.workspaceId,ownerKey:record.ownerKey,requestId:record.requestId}));const identity=fstatSync(fd,{bigint:true})
    try{return await operation()}finally{
      const stat=lstatSync(path,{bigint:true});if(stat.dev!==identity.dev||stat.ino!==identity.ino)throw Error(RECOVERY)
      unlinkSync(path)
    }
  }finally{if(fd!==undefined)closeSync(fd);release();if(queues.get(commonDir)===queued)queues.delete(commonDir)}
}

/** Plain workspace records are persisted before any Git allocation effects. */
export function createGitWorkspaces(options:GitWorkspaceOptions) {
  const root=resolve(options.root),stateDir=physical(options.stateDir),rootAnchor=nearest(options.root),stateIdentity=directoryIdentity(stateDir)
  if(within(root,stateDir)||within(stateDir,root))throw Error('git_workspace_invalid_root')
  const store=createGitWorkspaceStore(options.db),git=createGitRunner({timeoutMs:options.timeoutMs})
  const command=async(path:string,args:readonly string[],runner:GitRunner=git)=>text(await runner.run(path,args)).trim()
  const locations=()=>{
    if(directoryIdentity(rootAnchor.path)!==rootAnchor.identity||physical(stateDir)!==stateDir||directoryIdentity(stateDir)!==stateIdentity)throw Error(CHANGED)
    if(existsSync(root))physical(root)
  }
  const readGitState=async(executionPath:string):Promise<GitState>=>{
    physical(executionPath)
    const head=await command(executionPath,['rev-parse','--verify','HEAD'])
    const index:Record<string,string>=Object.create(null)
    // Without --full-name, ls-files coordinates are relative to the supplied cwd.
    for(const entry of fields(await git.run(executionPath,['ls-files','--stage','-z','--','.']))){
      const tab=entry.indexOf('\t');if(tab<0)throw Error(CHANGED)
      const name=entry.slice(tab+1),value=entry.slice(0,tab)
      if(!name.split('/').every(isPlainPart)||!/^\d{6} [a-f0-9]{40,64} [0-3]$/.test(value))throw Error(CHANGED)
      index[name]=index[name]?index[name]+'\n'+value:value
    }
    return {head,index}
  }
  const sourceState=async(record:Pick<GitWorkspaceRecord,'sourcePath'|'gitRoot'|'gitDir'>)=>{
    const state=await readGitState(record.sourcePath)
    const status=await git.run(record.gitRoot,['status','--porcelain=v1','-z','--untracked-files=all'])
    const branch=await command(record.gitRoot,['symbolic-ref','--quiet','HEAD']).catch(()=>null)
    const maskedIndex=fields(await git.run(record.gitRoot,['ls-files','-v','-z'])).some(entry=>entry[0]==='S'||/^[a-z]/.test(entry))
    const unfinished=maskedIndex||['MERGE_HEAD','CHERRY_PICK_HEAD','REVERT_HEAD','rebase-merge','rebase-apply','sequencer','BISECT_LOG'].some(name=>existsSync(join(record.gitDir,name)))
    return {state,status:status.toString('base64'),branch,unfinished}
  }
  const registrations=async(record:GitWorkspaceRecord)=>{
    const entries=fields(await git.run(record.gitRoot,['worktree','list','--porcelain','-z']))
    const records:{path:string;head:string|null;branch:string|null}[]=[];let current:typeof records[number]|undefined
    for(const entry of entries){if(entry.startsWith('worktree ')){current={path:entry.slice(9),head:null,branch:null};records.push(current)}else if(current&&entry.startsWith('HEAD '))current.head=entry.slice(5);else if(current&&entry.startsWith('branch '))current.branch=entry.slice(7)}
    return records
  }
  const sourceIdentityCheck=async(record:GitWorkspaceRecord)=>{
    locations()
    for(const [path,id] of [[record.sourcePath,record.sourceIdentity],[record.gitRoot,record.gitRootIdentity],[record.gitDir,record.gitDirIdentity],[record.commonDir,record.commonDirIdentity]] as const)if(physical(path)!==path||directoryIdentity(path)!==id)throw Error(CHANGED)
    if(await command(record.sourcePath,['rev-parse','--show-toplevel'])!==record.gitRoot||await command(record.sourcePath,['rev-parse','--path-format=absolute','--git-common-dir'])!==record.commonDir||await command(record.sourcePath,['rev-parse','--absolute-git-dir'])!==record.gitDir)throw Error(CHANGED)
  }
  const identityCheck=async(record:GitWorkspaceRecord)=>{
    await sourceIdentityCheck(record)
    if(!record.directoryIdentity||!record.executionIdentity||!record.worktreeGitDir||!record.worktreeGitDirIdentity||!record.rootIdentity)throw Error(CHANGED)
    for(const [path,id] of [[root,record.rootIdentity],[record.worktreeRoot,record.directoryIdentity],[record.executionPath,record.executionIdentity],[record.worktreeGitDir,record.worktreeGitDirIdentity]] as const)if(physical(path)!==path||directoryIdentity(path)!==id)throw Error(CHANGED)
    const registration=(await registrations(record)).find(item=>item.path===record.worktreeRoot)
    if(!registration||registration.branch!=='refs/heads/'+record.branch)throw Error(CHANGED)
    if(await command(record.worktreeRoot,['rev-parse','--show-toplevel'])!==record.worktreeRoot||await command(record.worktreeRoot,['rev-parse','--absolute-git-dir'])!==record.worktreeGitDir||await command(record.worktreeRoot,['rev-parse','--path-format=absolute','--git-common-dir'])!==record.commonDir||await command(record.worktreeRoot,['symbolic-ref','--quiet','HEAD'])!=='refs/heads/'+record.branch)throw Error(CHANGED)
  }
  const verify=async(record:GitWorkspaceRecord)=>{
    const saved=store.get(record.id)
    if(!saved||saved.status!=='ready')throw Error(CHANGED)
    for(const key of Object.keys(saved) as (keyof GitWorkspaceRecord)[])if(key!=='updatedAt'&&!same(saved[key],record[key]))throw Error(CONFLICT)
    await identityCheck(saved)
  }
  const assertInput=(request:GitWorkspacePrepareInput)=>{
    if(!UUID.test(request.workspaceId)||!request.ownerKey?.trim()||!request.requestId?.trim()||!/^[a-f0-9]{64}$/.test(request.canonicalRequestHash)||!request.providerId?.trim())throw Error('git_workspace_invalid_request')
  }
  const checkInput=(request:GitWorkspacePrepareInput,record:GitWorkspaceRecord)=>{
    for(const key of ['workspaceId','ownerKey','requestId','canonicalRequestHash','sourcePath','providerId'] as const)if(request[key]!==record[key])throw Error(CONFLICT)
    if(record.worktreeRoot!==join(root,request.workspaceId)||record.executionPath!==join(record.worktreeRoot,record.projectSubpath))throw Error(CONFLICT)
  }
  const configuration=async(record:GitWorkspaceRecord)=>{
    if(!options.validateConfiguration)return record
    let fingerprint:string
    try{
      fingerprint=await options.validateConfiguration({sourcePath:record.sourcePath,executionPath:record.executionPath,providerId:record.providerId})
      if(typeof fingerprint!=='string'||!fingerprint.trim()||fingerprint.length>4096)throw Error('git_workspace_configuration_rejected')
      if(record.configurationFingerprint!==null&&record.configurationFingerprint!==fingerprint)throw Error('git_workspace_configuration_changed')
    }catch(error){store.update({...record,status:'failed',failureReason:error instanceof Error?error.message:'git_workspace_configuration_rejected'});throw error}
    return store.update({...record,configurationFingerprint:fingerprint})
  }
  const prepare=async(request:GitWorkspacePrepareInput):Promise<GitWorkspaceRecord>=>{
    assertInput(request);locations()
    let record=store.get(request.workspaceId)
    if(record){checkInput(request,record);if(record.status==='failed'||record.status==='needs_recovery')throw Error(record.failureReason??RECOVERY);if(record.status==='ready'){await verify(record);return configuration(record)}}
    else {
      try{
        const sourcePath=physical(request.sourcePath),gitRoot=physical(await command(sourcePath,['rev-parse','--show-toplevel'])),gitDir=physical(await command(sourcePath,['rev-parse','--absolute-git-dir'])),commonDir=physical(await command(sourcePath,['rev-parse','--path-format=absolute','--git-common-dir']))
        if(within(gitRoot,root)||within(root,gitRoot)||within(gitRoot,stateDir)||within(stateDir,gitRoot)||within(commonDir,root))throw Error(UNSUPPORTED)
        const snapshot=await sourceState({sourcePath,gitRoot,gitDir}),tree=fields(await git.run(gitRoot,['ls-tree','-rz',snapshot.state.head]))
        if(snapshot.status||snapshot.unfinished||tree.some(entry=>entry.startsWith('160000 ')))throw Error(UNSUPPORTED)
        const projectSubpath=relative(gitRoot,sourcePath).split(sep).join('/'),worktreeRoot=join(root,request.workspaceId),now=Date.now()
        record=store.reserve({...request,id:request.workspaceId,sourcePath,sourceIdentity:directoryIdentity(sourcePath),gitRoot,gitRootIdentity:directoryIdentity(gitRoot),gitDir,gitDirIdentity:directoryIdentity(gitDir),commonDir,commonDirIdentity:directoryIdentity(commonDir),projectSubpath,baseCommit:snapshot.state.head,sourceBranch:snapshot.branch,branch:'codex/cc-task-'+request.workspaceId,worktreeRoot,executionPath:join(worktreeRoot,projectSubpath),directoryIdentity:null,executionIdentity:null,worktreeGitDir:null,worktreeGitDirIdentity:null,rootIdentity:null,sourceGitState:snapshot.state,sourceStatus:snapshot.status,configurationFingerprint:null,status:'reserved',failureReason:null,createdAt:now,updatedAt:now})
      }catch(error){if(error instanceof Error&&[CONFLICT,UNSUPPORTED].includes(error.message))throw error;throw Error(UNSUPPORTED)}
    }
    const reserved=record
    return withAllocationLock(reserved,()=>{const saved=store.get(reserved.id)!;store.update({...saved,status:'needs_recovery',failureReason:RECOVERY})},async()=>{
      let current=store.get(reserved.id)!
      checkInput(request,current)
      if(current.status==='ready'){await verify(current);return configuration(current)}
      if(current.status==='failed'||current.status==='needs_recovery')throw Error(current.failureReason??RECOVERY)
      try{
        await sourceIdentityCheck(current)
        const snapshot=await sourceState(current)
        if(!same(snapshot.state,current.sourceGitState)||snapshot.status!==current.sourceStatus||snapshot.branch!==current.sourceBranch||snapshot.unfinished)throw Error(RECOVERY)
        locations();mkdirAnchored(parse(root).root,root.slice(parse(root).root.length).split(sep).filter(Boolean),CHANGED)
        if(current.rootIdentity!==null&&current.rootIdentity!==directoryIdentity(root))throw Error(RECOVERY)
        if(!current.directoryIdentity){
          if(existsSync(current.worktreeRoot)||(await command(current.gitRoot,['branch','--list',current.branch])))throw Error(RECOVERY)
          mkdirSync(current.worktreeRoot,{mode:0o700})
          current=store.update({...current,status:'provisioning',rootIdentity:directoryIdentity(root),directoryIdentity:directoryIdentity(current.worktreeRoot)})
        }else if(directoryIdentity(current.worktreeRoot)!==current.directoryIdentity)throw Error(RECOVERY)
        const registered=(await registrations(current)).find(item=>item.path===current.worktreeRoot)
        if(!registered){
          if((await command(current.gitRoot,['branch','--list',current.branch]))||requireEmpty(current.worktreeRoot)===false)throw Error(RECOVERY)
          await git.run(current.gitRoot,['worktree','add','-b',current.branch,current.worktreeRoot,current.baseCommit])
        }else if(registered.branch!=='refs/heads/'+current.branch||registered.head!==current.baseCommit)throw Error(RECOVERY)
        const worktreeGitDir=physical(await command(current.worktreeRoot,['rev-parse','--absolute-git-dir']))
        current=store.update({...current,executionIdentity:directoryIdentity(current.executionPath),worktreeGitDir,worktreeGitDirIdentity:directoryIdentity(worktreeGitDir)})
        current=await configuration(current)
        await identityCheck(current)
        const after=await sourceState(current),result=await readGitState(current.executionPath),resultStatus=await git.run(current.worktreeRoot,['status','--porcelain=v1','-z','--untracked-files=all'])
        if(!same(after.state,current.sourceGitState)||after.status!==current.sourceStatus||after.branch!==current.sourceBranch||after.unfinished||result.head!==current.baseCommit||resultStatus.length||!same(result.index,current.sourceGitState.index))throw Error(RECOVERY)
      }catch(error){
        const saved=store.get(current.id)!
        if(saved.status!=='failed')store.update({...saved,status:'needs_recovery',failureReason:RECOVERY})
        if(store.get(current.id)?.status==='failed')throw error
        throw Error(RECOVERY)
      }
      // Receipt failure leaves the verified pinned object provisioning; restart can
      // safely recheck it. Never turn an interrupted ready write into a new UUID.
      return store.update({...current,status:'ready',failureReason:null})
    })
  }

  async function exportPatch(record:GitWorkspaceRecord):Promise<{bytes:Buffer;sha256:string;excluded:string[]}> {
    await verify(record)
    const sourceBefore=await sourceState(record),resultBefore=await readGitState(record.executionPath),refsBefore=await git.run(record.gitRoot,['show-ref'])
    const sourceSnapshot=await capture({...record,worktreeRoot:record.gitRoot,executionPath:record.sourcePath}),snapshot=await capture(record),temp=mkdtempSync(join(stateDir,'git-export-'))
    const runner=createGitRunner({timeoutMs:options.timeoutMs,privateIndexRoot:temp}),index=join(temp,'index')
    try{
      await runner.run(record.worktreeRoot,['read-tree',record.baseCommit],{privateIndexPath:index})
      const changes:Buffer[]=[]
      for(const path of snapshot.paths){
        const file=snapshot.files.get(path)
        if(file){
          const object=text(await runner.run(record.worktreeRoot,['hash-object','-w','--no-filters','--stdin'],{input:file.bytes})).trim()
          changes.push(Buffer.from(`${file.mode} ${object}\t${path}\0`))
        }else changes.push(Buffer.from(`0 ${'0'.repeat(record.baseCommit.length)}\t${path}\0`))
      }
      if(changes.length)await runner.run(record.worktreeRoot,['update-index','-z','--index-info'],{privateIndexPath:index,input:Buffer.concat(changes)})
      const bytes=await runner.run(record.worktreeRoot,['diff','--cached','--binary','--full-index','--no-ext-diff','--no-textconv','--no-renames',record.baseCommit,'--',record.projectSubpath||'.'],{privateIndexPath:index})
      await verify(record)
      const sourceAfter=await sourceState(record),resultAfter=await readGitState(record.executionPath),refsAfter=await git.run(record.gitRoot,['show-ref']),after=await capture(record),sourceAfterSnapshot=await capture({...record,worktreeRoot:record.gitRoot,executionPath:record.sourcePath})
      if(!same(sourceBefore,sourceAfter)||!same(resultBefore,resultAfter)||!refsBefore.equals(refsAfter)||snapshot.fingerprint!==after.fingerprint||sourceSnapshot.fingerprint!==sourceAfterSnapshot.fingerprint)throw Error('git_workspace_export_changed')
      return {bytes,sha256:digest(bytes),excluded:snapshot.excluded}
    }finally{
      // Only this invocation's private index is removed; task directories persist.
      for(const name of ['index','index.lock'])try{unlinkSync(join(temp,name))}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
      rmdirSync(temp)
    }
  }
  async function capture(record:GitWorkspaceRecord) {
    const baseEntries=fields(await git.run(record.worktreeRoot,['ls-tree','-rlz',record.baseCommit,'--',record.projectSubpath||'.']))
    const current=fields(await git.run(record.worktreeRoot,['ls-files','--cached','--others','--exclude-standard','--full-name','-z','--',record.projectSubpath||'.']))
    const ignored=fields(await git.run(record.worktreeRoot,['ls-files','--others','--ignored','--exclude-standard','--full-name','-z','--',record.projectSubpath||'.']))
    const paths=new Set<string>(),excluded=new Set<string>(['ignored','internal','outside_project'])
    let beforeBytes=0
    for(const entry of baseEntries){const tab=entry.indexOf('\t'),path=entry.slice(tab+1),size=Number(entry.slice(0,tab).trim().split(/\s+/).at(-1));if(!Number.isFinite(size)||size<0)throw Error('git_workspace_export_unsupported');if(!internal(path)){paths.add(path);beforeBytes+=size}}
    if(beforeBytes>MAX_RAW)throw Error('git_workspace_export_limit')
    for(const path of current)if(!internal(path))paths.add(path)
    if(paths.size>MAX_FILES||ignored.length>MAX_FILES)throw Error('git_workspace_export_limit')
    const files=new Map<string,{bytes:Buffer;mode:string;version:string}>();let total=0
    for(const path of paths){
      const parts=path.split('/');if(!parts.every(isPlainPart)||isAbsolute(path)||!within(record.executionPath,join(record.worktreeRoot,...parts)))throw Error('git_workspace_export_unsupported')
      const full=join(record.worktreeRoot,...parts)
      // Only ENOENT with an existing, verified parent chain proves deletion.
      try{const stat=lstatSync(full);if(!stat.isFile()||stat.nlink!==1)throw Error('git_workspace_export_unsupported')}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'){let parent=resolve(full,'..');while(!existsSync(parent)){parent=resolve(parent,'..')}physical(parent);continue}if(error instanceof Error&&error.message==='git_workspace_export_unsupported')throw error;throw Error('git_workspace_export_unreadable')}
      let fd:number|undefined
      try{
        fd=openAnchored(record.worktreeRoot,parts,constants.O_RDONLY|O_NONBLOCK,0,'git_workspace_export_unsupported')
        const {bytes,before}=readBounded(fd,MAX_RAW,'git_workspace_export_limit','git_workspace_export_changed')
        if(before.nlink!==1n)throw Error('git_workspace_export_unsupported')
        total+=bytes.length;if(total>MAX_RAW)throw Error('git_workspace_export_limit')
        files.set(path,{bytes,mode:(before.mode&0o100n)!==0n?'100755':'100644',version:`${parts.slice(0,-1).map((_,i)=>{const stat=verifyChain(record.worktreeRoot,parts.slice(0,i+1),CHANGED,{leafDirectory:true}).stat;return `${stat.dev}:${stat.ino}`}).join('/')}:${before.dev}:${before.ino}:${before.mode}:${before.size}:${before.mtimeNs}:${before.ctimeNs}:${digest(bytes)}`})
      }finally{if(fd!==undefined)closeSync(fd)}
    }
    const sorted=[...paths].sort(),versions=sorted.map(path=>[path,files.get(path)?.version??null])
    return {paths:sorted,files,excluded:[...excluded],fingerprint:digest(JSON.stringify({versions,current:current.sort(),ignored:ignored.sort(),baseEntries}))}
  }
  return {prepare,get:store.get,verify,readGitState,exportPatch}
}

const requireEmpty=(path:string)=>readdirSync(path).length===0
export type GitWorkspaces=ReturnType<typeof createGitWorkspaces>

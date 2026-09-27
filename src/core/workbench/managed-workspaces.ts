import {closeSync,constants,fchmodSync,fstatSync,lstatSync,mkdirSync,realpathSync,rmdirSync,type BigIntStats} from 'node:fs'
import {isAbsolute,join,parse,relative,resolve,sep} from 'node:path'
import type {EntryReservation} from './entry-store'
import {mkdirAnchored,openAnchored,readdirAnchored,verifyFromFilesystemRoot} from './anchored-fs'

export interface ManagedWorkspace {id:string;path:string;directoryIdentity:string;created:boolean}
type Reservation=Pick<EntryReservation,'workspaceId'|'resolvedPath'|'directoryIdentity'>
const INVALID='invalid_managed_workspace',CHANGED='managed_workspace_changed',UNAVAILABLE='managed_workspace_unavailable'
const UUID_V4=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i
const identity=(stat:BigIntStats)=>`${stat.dev}:${stat.ino}`
const within=(parent:string,path:string)=>{
  const delta=relative(parent,path)
  return delta===''||(!isAbsolute(delta)&&delta!=='..'&&!delta.startsWith('..'+sep))
}

function location(value:string):string {
  if(typeof value!=='string'||!isAbsolute(value)||value.includes('\0'))throw Error(INVALID)
  const parts=value.slice(parse(value).root.length).split(/[\\/]/).filter(Boolean)
  if(parts.some(part=>part==='.'||part==='..'||/^\.cc-workbench/i.test(part))||(process.platform!=='win32'&&value.includes('\\')))throw Error(INVALID)
  return resolve(value)
}

/** Inspect existing ancestors without following links; missing suffixes stay lexical. */
function existingLocation(path:string):string {
  const filesystemRoot=parse(path).root,parts=path.slice(filesystemRoot.length).split(sep).filter(Boolean)
  let cursor=filesystemRoot
  for(let index=0;index<parts.length;index++){
    const next=join(cursor,parts[index]!)
    let stat:BigIntStats
    try{stat=lstatSync(next,{bigint:true})}catch(error){
      if((error as NodeJS.ErrnoException).code==='ENOENT'){
        try{return join(realpathSync(cursor),...parts.slice(index))}catch{throw Error(UNAVAILABLE)}
      }
      throw Error(UNAVAILABLE)
    }
    if(stat.isSymbolicLink()||!stat.isDirectory())throw Error(UNAVAILABLE)
    cursor=next
  }
  try{return realpathSync(cursor)}catch{throw Error(UNAVAILABLE)}
}

/** The caller persists the reservation before ensure; no task lifecycle deletes directories here. */
export function createManagedWorkspaces(options:{root:string;stateDir:string}) {
  const root=location(options.root),stateDir=location(options.stateDir)
  if(within(root,stateDir)||within(stateDir,root))throw Error(INVALID)
  let rootIdentity:string|null=null
  const created=new WeakMap<ManagedWorkspace,{path:string;directoryIdentity:string}>()
  const checkLocations=()=>{
    const physicalRoot=existingLocation(root),physicalState=existingLocation(stateDir)
    if(within(physicalRoot,physicalState)||within(physicalState,physicalRoot))throw Error(INVALID)
  }
  const checkRoot=(error:string)=>{
    const current=identity(verifyFromFilesystemRoot(root,error).stat)
    if(rootIdentity!==null&&current!==rootIdentity)throw Error(CHANGED)
    rootIdentity=current
  }
  const allocation=(reservation:Reservation)=>{
    const id=reservation.workspaceId
    if(typeof id!=='string'||!UUID_V4.test(id))throw Error(INVALID)
    const path=join(root,id)
    if(reservation.resolvedPath!==null&&reservation.resolvedPath!==path)throw Error(INVALID)
    if(reservation.directoryIdentity!==null&&(!/^\d+:\d+$/.test(reservation.directoryIdentity)||reservation.resolvedPath!==path))throw Error(INVALID)
    return {id,path}
  }
  const verify=(workspace:ManagedWorkspace):void=>{
    allocation({workspaceId:workspace.id,resolvedPath:workspace.path,directoryIdentity:workspace.directoryIdentity})
    checkLocations();checkRoot(CHANGED)
    if(identity(verifyFromFilesystemRoot(workspace.path,CHANGED).stat)!==workspace.directoryIdentity)throw Error(CHANGED)
  }
  const makePrivate=(workspace:ManagedWorkspace)=>{
    // Windows does not implement POSIX directory modes. Elsewhere use the
    // verified descriptor so chmod cannot follow a substituted leaf symlink.
    if(process.platform==='win32')return
    const fd=openAnchored(root,[workspace.id],constants.O_RDONLY,0,UNAVAILABLE)
    try{
      if(identity(fstatSync(fd,{bigint:true}))!==workspace.directoryIdentity)throw Error(CHANGED)
      fchmodSync(fd,0o700)
    }catch(error){throw Error(error instanceof Error&&error.message===CHANGED?CHANGED:UNAVAILABLE)}finally{closeSync(fd)}
    verify(workspace)
  }
  return {
    ensure(reservation:Reservation):ManagedWorkspace {
      const {id,path}=allocation(reservation)
      checkLocations()
      if(reservation.directoryIdentity!==null){
        const workspace={id,path,directoryIdentity:reservation.directoryIdentity,created:false}
        verify(workspace)
        makePrivate(workspace)
        return workspace
      }
      if(rootIdentity===null){
        const filesystemRoot=parse(root).root
        mkdirAnchored(filesystemRoot,root.slice(filesystemRoot.length).split(sep).filter(Boolean),UNAVAILABLE)
      }
      checkRoot(UNAVAILABLE)
      let made=false
      try{mkdirSync(path,{mode:0o700});made=true}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw Error(UNAVAILABLE)}
      checkRoot(UNAVAILABLE)
      const directoryIdentity=identity(verifyFromFilesystemRoot(path,UNAVAILABLE).stat)
      // An unrecorded inode may be our mkdir-before-database crash window, but
      // unknown contents cannot safely be attributed to this reservation.
      if(!made&&readdirAnchored(root,[id],UNAVAILABLE).length!==0)throw Error(CHANGED)
      const workspace={id,path,directoryIdentity,created:made}
      verify(workspace)
      makePrivate(workspace)
      if(made)created.set(workspace,{path,directoryIdentity})
      return workspace
    },
    verify,
    removeEmptyCreated(workspace:ManagedWorkspace):boolean {
      const original=created.get(workspace)
      if(!workspace.created||!original||original.path!==workspace.path||original.directoryIdentity!==workspace.directoryIdentity)return false
      try{
        verify(workspace)
        if(readdirAnchored(root,[workspace.id],UNAVAILABLE).length!==0)return false
        verify(workspace)
        // Never recurse: a file arriving after the empty check makes rmdir fail.
        rmdirSync(workspace.path)
        created.delete(workspace)
        return true
      }catch{return false}
    },
  }
}
export type ManagedWorkspaces=ReturnType<typeof createManagedWorkspaces>

import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {createHash} from 'node:crypto'
import {type Stats,constants,closeSync,fstatSync,fsyncSync,lstatSync,mkdirSync,openSync,readFileSync,readdirSync,readSync,realpathSync,writeSync} from 'node:fs'
import {dirname,isAbsolute,join,relative,resolve,sep} from 'node:path'

export const RESTORE_LIMITS={fileBytes:256*1024,totalBytes:16*1024*1024,entries:50_000} as const
export type GitState={head:string;index:Record<string,string>}
export type Identity={path:string;id:string}
export type FileVersion={kind:'file';blobSha:string;size:number;mode:number;identity:string;chain:Identity[]}|{kind:'absent';chain:Identity[]}|{kind:'unknown';reason:string}
export interface Snapshot {git:GitState;staged:string[];rootIdentity:string;entries:Record<string,string>;completeDirs:string[];files:Record<string,FileVersion>;candidates:string[];notes:string[]}
export const restoreError=(e:unknown)=>{const err=e as NodeJS.ErrnoException;return err.code?`filesystem_${err.code}`:e instanceof Error&&/^[a-z][a-z0-9_]*$/.test(e.message)?e.message:'snapshot_unavailable'}
export const digest=(data:Buffer|string)=>createHash('sha256').update(data).digest('hex')
export function directoryId(path:string){const s=lstatSync(path,{bigint:true});if(!s.isDirectory()||s.isSymbolicLink())throw Error('directory_identity_changed');return `${s.dev}:${s.ino}`}
const leafId=(s:Stats)=>`${s.dev}:${s.ino}`
export function safeRelative(path:string){return !!path&&!isAbsolute(path)&&!path.includes('\\')&&!/[\x00-\x1f:]/.test(path)&&path.split('/').every(p=>!!p&&p!=='.'&&p!=='..'&&!/[. ]$/.test(p)&&! /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p)&&p!=='.git'&&!p.startsWith('.cc-workbench')&&!p.startsWith('.cc-restore-'))}
export function sensitive(path:string){return path.split('/').some(p=>(p.startsWith('.')&&!['.gitignore','.gitattributes','.editorconfig'].includes(p))||/^(id_(rsa|dsa|ecdsa|ed25519)|credentials(?:\..*)?|private[-_]key(?:\..*)?)$/i.test(p)||/\.(pem|p12|pfx|key)$/i.test(p))}
type NameCache=Map<string,Set<string>>
function exactName(parent:string,name:string,cache?:NameCache){let names=cache?.get(parent);if(!names){names=new Set(readdirSync(parent));cache?.set(parent,names)}if(!names.has(name))throw Error('path_alias_changed')}
export function parentChain(root:string,path:string,cache?:NameCache):Identity[]{
  if(!safeRelative(path))throw Error('unsafe_path')
  const chain:Identity[]=[{path:'',id:directoryId(root)}];let parent=''
  for(const part of path.split('/').slice(0,-1)){exactName(join(root,parent),part,cache);parent=parent?`${parent}/${part}`:part;chain.push({path:parent,id:directoryId(join(root,parent))})}
  return chain
}
export function checkChain(root:string,chain:Identity[]){for(const entry of chain)if(directoryId(join(root,entry.path))!==entry.id)throw Error('directory_identity_changed')}
export function observe(root:string,path:string,maxBytes:number=RESTORE_LIMITS.fileBytes,cache?:NameCache):FileVersion {
  const chain=parentChain(root,path,cache),target=join(root,path)
  let st:Stats
  try{st=lstatSync(target)}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return {kind:'absent',chain};throw e}
  exactName(dirname(target),path.split('/').at(-1)!,cache);
  if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1)throw Error('unsupported_file_type')
  if(st.size>maxBytes)throw Error('file_limit')
  // A leaf may become a FIFO after lstat; open must not block before fstat can reject it.
  const fd=openSync(target,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK)
  try{
    const before=fstatSync(fd);if(leafId(before)!==leafId(st)||before.nlink!==1||!before.isFile())throw Error('file_identity_changed')
    const bytes=Buffer.alloc(before.size);let offset=0;while(offset<bytes.length){const n=readSync(fd,bytes,offset,bytes.length-offset,offset);if(!n)throw Error('file_changed');offset+=n}
    const after=fstatSync(fd);if(after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs||after.nlink!==1)throw Error('file_changed')
    if(leafId(lstatSync(target))!==leafId(before))throw Error('file_identity_changed');checkChain(root,chain)
    return {kind:'file',blobSha:digest(bytes),size:bytes.length,mode:before.mode&0o777,identity:leafId(before),chain}
  }finally{closeSync(fd)}
}
export function readVersion(root:string,path:string,version:FileVersion){if(version.kind!=='file')throw Error('missing_raw_version');const fd=openSync(join(root,path),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{const st=fstatSync(fd);if(!st.isFile()||st.nlink!==1)throw Error('file_changed');const bytes=readFileSync(fd);if(digest(bytes)!==version.blobSha||fstatSync(fd).nlink!==1)throw Error('file_changed');checkChain(root,version.chain);return bytes}finally{closeSync(fd)}}
export function verifyBlobRoot(blobRoot:string,identity:string){
  try{if(realpathSync(blobRoot)!==resolve(blobRoot)||directoryId(blobRoot)!==identity)throw Error('blob_identity_changed')}catch{throw Error('blob_identity_changed')}
}
export function initializeBlobs(blobRoot:string,workspace:string):string{
  const work=realpathSync(workspace),blob=resolve(blobRoot),delta=relative(work,blob)
  if(!(delta==='..'||delta.startsWith('..'+sep)||isAbsolute(delta)))throw Error('unsafe_blob_root')
  // Validate existing ancestors BEFORE creating anything; a linked parent cannot redirect mkdir.
  let ancestor=blob
  for(;;){try{if(realpathSync(ancestor)!==ancestor)throw Error('unsafe_blob_root');break}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;const parent=dirname(ancestor);if(parent===ancestor)throw Error('unsafe_blob_root');ancestor=parent}}
  mkdirSync(blob,{recursive:true,mode:0o700});const identity=directoryId(blob);verifyBlobRoot(blob,identity);return identity
}
export function saveBlob(blobRoot:string,bytes:Buffer,identity:string){verifyBlobRoot(blobRoot,identity);const sha=digest(bytes),path=join(blobRoot,sha);let fd:number
  try{fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600)}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;loadBlob(blobRoot,sha,identity);return sha}
  try{let offset=0;while(offset<bytes.length)offset+=writeSync(fd,bytes,offset,bytes.length-offset);fsyncSync(fd)}finally{closeSync(fd)}
  verifyBlobRoot(blobRoot,identity);syncDirectory(blobRoot);return sha
}
export function loadBlob(blobRoot:string,sha:string,identity:string){verifyBlobRoot(blobRoot,identity);if(!/^[a-f0-9]{64}$/.test(sha))throw Error('invalid_blob');let fd:number;try{fd=openSync(join(blobRoot,sha),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK)}catch{throw Error('blob_unavailable')};try{const st=fstatSync(fd);if(!st.isFile()||st.nlink!==1||st.size>RESTORE_LIMITS.fileBytes)throw Error('blob_invalid');const bytes=readFileSync(fd);if(digest(bytes)!==sha)throw Error('blob_corrupt');verifyBlobRoot(blobRoot,identity);return bytes}finally{closeSync(fd)}}
export function syncDirectory(path:string){const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{if(!fstatSync(fd).isDirectory())throw Error('directory_identity_changed');fsyncSync(fd)}finally{closeSync(fd)}}
const execute=promisify(execFile)
export async function gitInventory(root:string){
  const env={...process.env};for(const key of Object.keys(env))if(key.toUpperCase().startsWith('GIT_'))delete env[key]
  Object.assign(env,{GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null',GIT_NO_LAZY_FETCH:'1',GIT_NO_REPLACE_OBJECTS:'1',LC_ALL:'C'})
  const deadline=Date.now()+15_000
  const run=async(args:string[])=>{const timeout=deadline-Date.now();if(timeout<=0)throw Error('snapshot_deadline');const {stdout}=await execute('git',['--no-pager','--no-optional-locks','-c','core.fsmonitor=false','-c',`core.hooksPath=${process.platform==='win32'?'NUL':'/dev/null'}`,...args],{cwd:root,env,encoding:'buffer',timeout,maxBuffer:8*1024*1024});return new TextDecoder('utf-8',{fatal:true}).decode(stdout).split('\0').filter(Boolean)}
  const candidates=await run(['ls-files','--cached','--others','--exclude-standard','-z','--','.'])
  const staged=await run(['diff','--cached','--no-ext-diff','--no-textconv','--ignore-submodules=all','--no-renames','--relative','--name-only','-z','HEAD','--','.'])
  return {candidates:[...new Set(candidates)].filter(safeRelative),staged}
}
export async function captureSnapshot(root:string,blobRoot:string,readGitState:(path:string)=>Promise<GitState>,blobIdentity:string):Promise<Snapshot>{
  const git=await readGitState(root),inventory=await gitInventory(root),rootIdentity=directoryId(root)
  const snapshot:Snapshot={git,staged:inventory.staged,rootIdentity,entries:Object.create(null),completeDirs:[],files:Object.create(null),candidates:inventory.candidates.slice(0,RESTORE_LIMITS.entries),notes:[]}
  let count=0,bytesUsed=0
  const namesCache:NameCache=new Map(),deadline=Date.now()+15_000
  const scan=(dir:string)=>{let names:string[];try{names=readdirSync(join(root,dir)).sort();namesCache.set(join(root,dir),new Set(names))}catch{snapshot.notes.push('coverage_unreadable');return}
    let complete=true
    for(const name of names){if(++count>RESTORE_LIMITS.entries||Date.now()>deadline){complete=false;snapshot.notes.push('coverage_limit');break};const path=dir?`${dir}/${name}`:name
      try{const st=lstatSync(join(root,path));snapshot.entries[path]=st.isDirectory()&&!st.isSymbolicLink()?'directory':st.isFile()?'file':'unsupported';if(st.isDirectory()&&!st.isSymbolicLink()&&safeRelative(path)&&!sensitive(path))scan(path)}catch{snapshot.entries[path]='unknown';complete=false}
    };if(complete)snapshot.completeDirs.push(dir)
  };scan('')
  for(const path of inventory.candidates.slice(0,RESTORE_LIMITS.entries)){
    try{
      if(Date.now()>deadline)throw Error('snapshot_deadline')
      if(sensitive(path))throw Error('sensitive_path')
      const version=observe(root,path,Math.min(RESTORE_LIMITS.fileBytes,RESTORE_LIMITS.totalBytes-bytesUsed),namesCache)
      if(version.kind==='file'){const bytes=readVersion(root,path,version);if(bytes.includes(0))throw Error('binary_file');new TextDecoder('utf-8',{fatal:true}).decode(bytes);saveBlob(blobRoot,bytes,blobIdentity);bytesUsed+=bytes.length}
      snapshot.files[path]=version
    }catch(e){snapshot.files[path]={kind:'unknown',reason:restoreError(e)}}
  }
  if(inventory.candidates.length>RESTORE_LIMITS.entries)snapshot.notes.push('candidate_limit')
  if(directoryId(root)!==rootIdentity)throw Error('directory_identity_changed')
  if(JSON.stringify(await readGitState(root))!==JSON.stringify(git))throw Error('git_state_changed')
  verifyBlobRoot(blobRoot,blobIdentity)
  snapshot.notes=[...new Set(snapshot.notes)]
  return snapshot
}
export function versionAt(snapshot:Snapshot,path:string):FileVersion{
  if(Object.hasOwn(snapshot.files,path))return snapshot.files[path]!
  const parts=path.split('/');let parent=''
  for(const part of parts){const current=parent?`${parent}/${part}`:part
    if(!Object.hasOwn(snapshot.entries,current))return snapshot.completeDirs.includes(parent)?{kind:'absent',chain:[]}:{kind:'unknown',reason:'coverage_unknown'}
    if(snapshot.entries[current]!=='directory')return {kind:'unknown',reason:'before_not_captured'}
    parent=current
  }
  return {kind:'unknown',reason:'before_not_captured'}
}
export function sameContent(a:FileVersion,b:FileVersion){return a.kind==='absent'&&b.kind==='absent'||a.kind==='file'&&b.kind==='file'&&a.blobSha===b.blobSha&&a.mode===b.mode&&a.size===b.size}

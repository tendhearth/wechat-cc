import {createHash} from 'node:crypto'
import {closeSync,constants,fstatSync,mkdtempSync,openSync,readFileSync,readSync,rmSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {isAbsolute,join} from 'node:path'
import {cc,dlopen,ptr} from 'bun:ffi'
import nativeSource from './api-files-native.c' with {type:'file'}
import type {ToolSpec} from '../openai-chat-model'

const MAX_READ_BYTES=256*1024
const MAX_SAVE_BYTES=1024*1024
const MAX_LIST_ENTRIES=200
const MAX_LIST_BYTES=60*1024
const PRIVATE_COMPONENT=/^\.cc-workbench/i
const CONTROL=/[\u0000-\u001f\u007f]/
const BINARY_CONTROL=/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/

export const API_FILE_TOOLS:ToolSpec[]=[
  {name:'ReadFile',description:'Read one project-relative UTF-8 text file (at most 256 KiB). No links or internal task folders.',parameters:{type:'object',properties:{path:{type:'string',description:'Relative project file path.'}},required:['path'],additionalProperties:false}},
  {name:'ListFiles',description:'List up to 200 immediate project directory entries. Omits links and internal task folders; does not recurse.',parameters:{type:'object',properties:{path:{type:'string',description:'Relative project directory; defaults to the project root.',default:'.'}},additionalProperties:false}},
  {name:'SaveArtifact',description:'Create a new UTF-8 text artifact (at most 1 MiB) in this task output folder. Never overwrite files.',parameters:{type:'object',properties:{name:{type:'string',description:'A single safe file name, such as report.md.'},content:{type:'string',description:'Complete UTF-8 text content.'}},required:['name','content'],additionalProperties:false}},
]

type NativeFs={
  api_openat:(fd:number,name:ReturnType<typeof ptr>,flags:number,mode:number)=>number
  api_mkdirat:(fd:number,name:ReturnType<typeof ptr>,mode:number)=>number
  api_listdir:(fd:number,output:ReturnType<typeof ptr>,capacity:number,maxEntries:number,truncated:ReturnType<typeof ptr>)=>number
}
let nativeFs:NativeFs|undefined
let readOpenAt:((fd:number,name:ReturnType<typeof ptr>,flags:number)=>number)|undefined
function nativeReadOpenAt() {
  if(readOpenAt)return readOpenAt
  const library=process.platform==='darwin'?'/usr/lib/libSystem.B.dylib':process.platform==='linux'?'libc.so.6':null
  if(!library)throw Error('api_file_platform_unsupported')
  const handle=dlopen(library,{openat:{args:['i32','ptr','i32'],returns:'i32'}})
  readOpenAt=handle.symbols.openat
  return readOpenAt
}
function native():NativeFs {
  if(nativeFs)return nativeFs
  if(process.platform!=='darwin'&&process.platform!=='linux')throw Error('api_file_platform_unsupported')
  // Like attachment writes, stage only the fixed bundled C source for TinyCC.
  // No project files, scripts, configuration or shell are evaluated.
  const directory=mkdtempSync(join(tmpdir(),'cc-api-files-native-'))
  try{
    const source=join(directory,'files.c')
    writeFileSync(source,readFileSync(nativeSource),{mode:0o600,flag:'wx'})
    const library=cc({source,symbols:{
      api_openat:{args:['i32','ptr','i32','i32'],returns:'i32'},
      api_mkdirat:{args:['i32','ptr','i32'],returns:'i32'},
      api_listdir:{args:['i32','ptr','i32','i32','ptr'],returns:'i32'},
    }})
    nativeFs=library.symbols as NativeFs
  }finally{rmSync(directory,{recursive:true,force:true})}
  return nativeFs
}

function noFollowFlags():number {
  if(constants.O_NOFOLLOW===undefined||constants.O_DIRECTORY===undefined)throw Error('api_file_platform_unsupported')
  return constants.O_NOFOLLOW|((constants as unknown as Record<string,number>).O_CLOEXEC??0)
}
function openAt(fd:number,name:string,flags:number,mode=0):number {
  const bytes=Buffer.from(name+'\0')
  const opened=(flags&constants.O_CREAT)!==0
    ?native().api_openat(fd,ptr(bytes),flags|noFollowFlags(),mode)
    :nativeReadOpenAt()(fd,ptr(bytes),flags|noFollowFlags())
  if(opened<0)throw Error('invalid_api_file_path')
  return opened
}
function validComponent(value:unknown,allowInternal=false):string {
  if(typeof value!=='string'||!value.trim()||Buffer.byteLength(value)>240||value==='.'||value==='..'||CONTROL.test(value)||/[\\/]/.test(value)||value.endsWith('.')||value.endsWith(' ')||(!allowInternal&&PRIVATE_COMPONENT.test(value)))throw Error('invalid_api_file_path')
  return value
}
function projectRelative(value:unknown,allowRoot:boolean):string {
  if(typeof value!=='string'||!value||Buffer.byteLength(value)>4096||isAbsolute(value)||/^[a-z]:/i.test(value)||value.includes('\\')||CONTROL.test(value))throw Error('invalid_api_file_path')
  const raw=value.split('/')
  if(raw.some(part=>part==='..'))throw Error('invalid_api_file_path')
  const parts=raw.filter(part=>part!==''&&part!=='.')
  if(parts.length>32||(!allowRoot&&parts.length===0))throw Error('invalid_api_file_path')
  parts.forEach(part=>validComponent(part))
  return parts.join('/')||'.'
}
function argumentsObject(input:unknown,allowed:string[]):Record<string,unknown> {
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!allowed.includes(key)))throw Error('invalid_api_tool_input')
  return input as Record<string,unknown>
}
function taskIdentity(id:string):void {
  if(typeof id!=='string'||!/^[a-f0-9]{8}$/.test(id))throw Error('invalid_api_task_id')
}

/** Root traversal itself is anchored: even an ancestor of the project cannot be a link. */
function openProject(root:string):number {
  if(typeof root!=='string'||!isAbsolute(root)||root.includes('\\')||CONTROL.test(root))throw Error('invalid_api_file_path')
  const parts=root.split('/').filter(Boolean)
  if(parts.length===0||parts.some(part=>part==='.'||part==='..'||PRIVATE_COMPONENT.test(part)))throw Error('invalid_api_file_path')
  let fd:number
  try{fd=openSync('/',constants.O_RDONLY|constants.O_DIRECTORY|noFollowFlags())}catch{throw Error('invalid_api_file_path')}
  try{
    for(const part of parts){
      const next=openAt(fd,part,constants.O_RDONLY|constants.O_DIRECTORY)
      closeSync(fd);fd=next
    }
    return fd
  }catch(error){closeSync(fd);throw error}
}
type ProjectIdentity={dev:bigint;ino:bigint}
function identity(fd:number):ProjectIdentity {
  const stat=fstatSync(fd,{bigint:true})
  if(!stat.isDirectory())throw Error('invalid_api_file_path')
  return{dev:stat.dev,ino:stat.ino}
}
function withProject<T>(root:string,expected:ProjectIdentity,action:(fd:number)=>T):T {
  const fd=openProject(root)
  try{
    const current=identity(fd)
    if(current.dev!==expected.dev||current.ino!==expected.ino)throw Error('api_project_changed')
    return action(fd)
  }finally{closeSync(fd)}
}
/** Open each child from its existing parent descriptor; mkdirat never follows a link. */
function withDirectory<T>(rootFd:number,parts:string[],create:boolean,action:(fd:number)=>T):T {
  let fd=openAt(rootFd,'.',constants.O_RDONLY|constants.O_DIRECTORY)
  try{
    for(const part of parts){
      validComponent(part,create)
      if(create){const bytes=Buffer.from(part+'\0');native().api_mkdirat(fd,ptr(bytes),0o700)}
      const next=openAt(fd,part,constants.O_RDONLY|constants.O_DIRECTORY)
      closeSync(fd);fd=next
    }
    return action(fd)
  }finally{closeSync(fd)}
}
function text(bytes:Buffer):string {
  let value:string
  try{value=new TextDecoder('utf-8',{fatal:true}).decode(bytes)}catch{throw Error('api_file_not_text')}
  if(BINARY_CONTROL.test(value))throw Error('api_file_not_text')
  return value
}
function readText(rootFd:number,path:string):string {
  const parts=path.split('/')
  return withDirectory(rootFd,parts.slice(0,-1),false,fd=>{
    const file=openAt(fd,parts.at(-1)!,constants.O_RDONLY|constants.O_NONBLOCK)
    try{
      const before=fstatSync(file)
      if(!before.isFile()||before.size>MAX_READ_BYTES)throw Error('invalid_api_file_size')
      if(before.nlink!==1)throw Error('invalid_api_file_path')
      const bytes=Buffer.allocUnsafe(MAX_READ_BYTES+1)
      let length=0
      while(length<bytes.length){const n=readSync(file,bytes,length,bytes.length-length,null);if(n===0)break;length+=n}
      const after=fstatSync(file)
      if(length>MAX_READ_BYTES)throw Error('invalid_api_file_size')
      if(length!==before.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs)throw Error('api_file_changed')
      return text(bytes.subarray(0,length))
    }finally{closeSync(file)}
  })
}
function listFiles(rootFd:number,path:string):string {
  return withDirectory(rootFd,path==='.'?[]:path.split('/'),false,fd=>{
    const bytes=Buffer.alloc(MAX_LIST_BYTES),truncated=new Int32Array(1)
    const length=native().api_listdir(fd,ptr(bytes),bytes.length,MAX_LIST_ENTRIES,ptr(truncated))
    if(length<0)throw Error('invalid_api_file_path')
    const entries:Array<{name:string;type:string}>=[]
    let offset=0
    while(offset<length){
      const type=bytes[offset++]!,end=bytes.indexOf(0,offset)
      if(end<offset||end>=length)throw Error('invalid_api_file_path')
      let name:string
      try{name=new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(offset,end))}catch{offset=end+1;continue}
      offset=end+1
      if(PRIVATE_COMPONENT.test(name)||CONTROL.test(name)||type===3)continue
      // Names come from readdir, never path resolution; special files are inert labels.
      entries.push({name,type:type===1?'file':type===2?'directory':'other'})
    }
    entries.sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0)
    // JSON escaping can double a legal filename's byte count.
    let available=64*1024-Buffer.byteLength(JSON.stringify({path,entries:[],truncated:false}))
    let count=0
    for(const entry of entries){
      available-=Buffer.byteLength(JSON.stringify(entry))+1
      if(available<0){truncated[0]=1;break}
      count++
    }
    entries.length=count
    return JSON.stringify({path,entries,truncated:truncated[0]!==0})
  })
}
function saveArtifact(rootFd:number,taskId:string,name:string,bytes:Buffer):string {
  return withDirectory(rootFd,['.cc-workbench',taskId],true,fd=>{
    let file:number
    try{file=openAt(fd,name,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL,0o600)}catch{throw Error('api_artifact_exists_or_invalid_path')}
    try{writeFileSync(file,bytes)}finally{closeSync(file)}
    return `Saved .cc-workbench/${taskId}/${name} (${bytes.length} bytes).`
  })
}

/** Freeze approval inputs, then reopen and recheck the root before synchronous effects. */
export function prepareApiFileTool(projectPath:string,taskId:string,name:string,input:unknown):{description:string;execute():string} {
  if(!API_FILE_TOOLS.some(tool=>tool.name===name))throw Error('unsupported_api_tool')
  taskIdentity(taskId)
  let description:string,executeWithRoot:(fd:number)=>string
  if(name==='SaveArtifact'){
    const args=argumentsObject(input,['name','content']),fileName=validComponent(args.name)
    if(typeof args.content!=='string')throw Error('invalid_api_tool_input')
    if(Buffer.byteLength(args.content)>MAX_SAVE_BYTES)throw Error('invalid_api_file_size')
    const bytes=Buffer.from(args.content,'utf8');text(bytes)
    const digest=createHash('sha256').update(bytes).digest('hex')
    description=`SaveArtifact .cc-workbench/${taskId}/${fileName} (${bytes.length} bytes; SHA256 ${digest})`
    executeWithRoot=fd=>{taskIdentity(taskId);validComponent(fileName);return saveArtifact(fd,taskId,fileName,bytes)}
  }else{
    const args=argumentsObject(input,['path']),path=projectRelative(args.path===undefined&&name==='ListFiles'?'.':args.path,name==='ListFiles')
    description=`${name} ${path}`
    executeWithRoot=fd=>{projectRelative(path,name==='ListFiles');return name==='ReadFile'?readText(fd,path):listFiles(fd,path)}
  }
  // Opening/stating the project does not read materials or create task directories.
  const fd=openProject(projectPath)
  let expected:ProjectIdentity
  try{expected=identity(fd)}finally{closeSync(fd)}
  return{description,execute:()=>{
    try{return withProject(projectPath,expected,executeWithRoot)}catch(error){
      // OS exceptions often contain absolute paths; only stable tool errors reach the model.
      if(error instanceof Error&&/^(?:invalid_api_|api_)/.test(error.message))throw error
      throw Error('api_file_operation_failed')
    }
  }}
}

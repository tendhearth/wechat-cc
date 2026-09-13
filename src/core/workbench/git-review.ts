import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {createHash} from 'node:crypto'
import {lstatSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {isAbsolute,join} from 'node:path'
import {readAnchoredRegular,MAX_ARTIFACT_BYTES} from './artifacts'

export const GIT_REVIEW_MIME='application/vnd.cc.workbench-review+json'
const execute=promisify(execFile)
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex')
interface Limits {maxPaths:number;maxFileBytes:number;maxTotalBytes:number;maxDiffBytes:number}
const DEFAULT_LIMITS:Limits={maxPaths:1000,maxFileBytes:256*1024,maxTotalBytes:16*1024*1024,maxDiffBytes:2*1024*1024}
type FileState={kind:'missing'}|{kind:'skipped';reason:string;hash?:string;mode?:string;bytesRead?:number}|{kind:'text';text:string;hash:string;mode:string;bytesRead:number}
export interface GitBaseline {
  project:string;startedAt:number;head:string|null;limits:Limits
  kind:'git'|'not_git'|'unavailable';paths:Set<string>;initial:Map<string,FileState>;preexistingPaths:string[];notes:string[]
}
export interface ReviewFile {path:string;preexisting:boolean;kind:'added'|'deleted'|'modified'|'not_reviewed';beforeSha256?:string;afterSha256?:string;diff?:string;reason?:string}
export interface GitReview {version:1;scope:'working-tree-before-after';startedAt:number;finishedAt:number;headBefore:string|null;headAfter:string|null;status:'complete'|'partial'|'unavailable';preexistingPaths:string[];notes:string[];files:ReviewFile[]}
function gitEnv() {
  const env:NodeJS.ProcessEnv={...process.env}
  for(const key of Object.keys(env))if(key.startsWith('GIT_'))delete env[key]
  return {...env,LC_ALL:'C',GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_PAGER:'cat',GIT_NO_LAZY_FETCH:'1',GIT_NO_REPLACE_OBJECTS:'1'}
}
/** Each phase gets fresh config overrides and a total deadline. No repository helpers run. */
class GitReader {
  private readonly deadline=Date.now()+15_000
  constructor(private readonly signal?:AbortSignal) {}
  private filters:string[]=[]
  private readonly safe=['--no-pager','--no-optional-locks','-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null']
  remaining(){return Math.max(0,this.deadline-Date.now())}
  async run(project:string,args:string[],maxBuffer=4*1024*1024) {
    const timeout=Math.min(5000,this.remaining())
    if(this.signal?.aborted)throw new Error('review_cancelled')
    if(!timeout)throw new Error('review_deadline')
    const {stdout}=await execute('git',[...this.safe,...this.filters,...args],{cwd:project,env:gitEnv(),encoding:'buffer',maxBuffer,timeout,signal:this.signal})
    return Buffer.from(stdout)
  }
  async configure(project:string) {
    let keys:Buffer
    try{keys=await this.run(project,['config','--null','--name-only','--get-regexp','^filter\\..*\\.(clean|smudge|process|required)$'])}
    catch(error){if((error as {code?:number}).code===1)return;throw error}
    for(const key of paths(keys)) {
      if(!/^filter\.[^\0\r\n]+\.(clean|smudge|process|required)$/i.test(key))throw new Error('invalid_filter_config')
      this.filters.push('-c',`${key}=${key.toLowerCase().endsWith('.required')?'false':''}`)
    }
  }
}
function paths(bytes:Buffer){return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes).split('\0').filter(Boolean)}
function inScope(path:string){return !isAbsolute(path) && !path.split('/').some(p=>p==='..'||p==='.git'||p==='.cc-workbench'||p==='.cc-workbench-inputs') && !path.includes('\0') && !path.includes('\\')}
function reviewable(path:string){return !path.split('/').some(p=>
  (p.startsWith('.')&&!['.gitignore','.gitattributes','.editorconfig'].includes(p)) || /^(id_(rsa|dsa|ecdsa|ed25519)|credentials(?:\..*)?|private[-_]key(?:\..*)?)$/i.test(p) || /\.(pem|p12|pfx|key)$/i.test(p)
)}
function decode(bytes:Buffer,mode:string):FileState {
  if(bytes.includes(0))return{kind:'skipped',reason:'二进制文件未展开',hash:sha(bytes),mode,bytesRead:bytes.length}
  try{return{kind:'text',text:new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes),hash:sha(bytes),mode,bytesRead:bytes.length}}
  catch{return{kind:'skipped',reason:'非 UTF-8 文本未展开',hash:sha(bytes),mode,bytesRead:bytes.length}}
}
function working(project:string,path:string,limits:Limits,remaining=limits.maxTotalBytes):FileState {
  if(!inScope(path))return{kind:'skipped',reason:'路径不在项目范围内'}
  if(!reviewable(path))return{kind:'skipped',reason:'隐藏配置或凭证文件未展开'}
  try {
    const stat=lstatSync(join(project,path))
    if(!stat.isFile())return{kind:'skipped',reason:'链接或特殊文件未展开'}
    if(stat.size>remaining)return{kind:'skipped',reason:'内容总量超过限制'}
    if(stat.size>limits.maxFileBytes)return{kind:'skipped',reason:'文件超过预览大小限制'}
    return decode(readAnchoredRegular(project,path,Math.max(1,Math.min(limits.maxFileBytes,remaining))),(stat.mode&0o111)?'100755':'100644')
  } catch(error) {return (error as NodeJS.ErrnoException).code==='ENOENT'?{kind:'missing'}:{kind:'skipped',reason:'无法安全读取文件'}}
}
async function allPaths(reader:GitReader,project:string) {
  return [...new Set(paths(await reader.run(project,['ls-files','--cached','--others','--exclude-standard','-z','--','.'])))].filter(inScope).sort()
}
async function changed(reader:GitReader,project:string,head:string|null) {
  const tracked=head?paths(await reader.run(project,['diff','--no-ext-diff','--no-textconv','--ignore-submodules=all','--no-renames','--relative','--name-only','-z',head,'--','.'])):[]
  return [...new Set([...tracked,...paths(await reader.run(project,['ls-files','--others','--exclude-standard','-z','--','.']))])].filter(inScope).sort()
}
export async function captureGitBaseline(project:string,overrides:Partial<Limits>={},signal?:AbortSignal):Promise<GitBaseline> {
  const baseline:GitBaseline={project,startedAt:Date.now(),head:null,kind:'git',paths:new Set(),initial:new Map(),preexistingPaths:[],notes:[],limits:{...DEFAULT_LIMITS,...overrides}}
  const reader=new GitReader(signal)
  try {
    if((await reader.run(project,['rev-parse','--is-inside-work-tree'])).toString().trim()!=='true'){baseline.kind='not_git';return baseline}
  } catch(error) {
    baseline.kind=String((error as {stderr?:Buffer}).stderr??'').includes('not a git repository')?'not_git':'unavailable'
    baseline.notes.push('无法确定项目的 Git 状态。');return baseline
  }
  try {
    await reader.configure(project)
    try{baseline.head=(await reader.run(project,['rev-parse','--verify','HEAD'])).toString().trim()}catch{/* Unborn repository. */}
    const dirty=await changed(reader,project,baseline.head)
    const headPaths=baseline.head?paths(await reader.run(project,['ls-tree','-rz','--name-only',baseline.head,'--','.'])):[]
    const roster=[...new Set([...await allPaths(reader,project),...dirty,...headPaths])].filter(inScope).sort()
    baseline.paths=new Set(roster)
    baseline.preexistingPaths=dirty.slice(0,baseline.limits.maxPaths)
    if(roster.length>baseline.limits.maxPaths)baseline.notes.push('开始时的文件数量超过限制，未读取的文件不能比较。')
    let bytes=0
    for(const path of roster.slice(0,baseline.limits.maxPaths)) {
      if(!reader.remaining()){baseline.notes.push('开始时读取超时，未读取的文件不能比较。');break}
      const value=working(project,path,baseline.limits,baseline.limits.maxTotalBytes-bytes)
      if(value.kind!=='missing')bytes+=value.bytesRead??0
      baseline.initial.set(path,value)
    }
  } catch {baseline.kind='unavailable';baseline.notes.push('无法完整建立开始时的项目基线。')}
  return baseline
}
function original(baseline:GitBaseline,path:string):FileState {
  return baseline.initial.get(path)??(baseline.paths.has(path)?{kind:'skipped',reason:'开始时此文件未读取，无法比较'}:{kind:'missing'})
}
async function diffText(reader:GitReader,before:string,after:string,maxBytes:number):Promise<string> {
  const scratch=mkdtempSync(join(tmpdir(),'cc-file-diff-'))
  try {
    writeFileSync(join(scratch,'before'),before,{mode:0o600});writeFileSync(join(scratch,'after'),after,{mode:0o600})
    let output:Buffer
    try{output=await reader.run(scratch,['diff','--no-index','--no-ext-diff','--no-textconv','--no-color','--','before','after'],maxBytes)}
    catch(error){const e=error as {code?:number;stdout?:Buffer};if(e.code!==1||!e.stdout)throw error;output=Buffer.from(e.stdout)}
    const text=output.toString('utf8'),start=text.indexOf('@@')
    return start<0?'':text.slice(start)
  } finally {rmSync(scratch,{recursive:true,force:true})}
}
export async function finishGitReview(baseline:GitBaseline):Promise<GitReview|null> {
  if(baseline.kind==='not_git')return null
  const report:GitReview={version:1,scope:'working-tree-before-after',startedAt:baseline.startedAt,finishedAt:Date.now(),headBefore:baseline.head,headAfter:null,status:baseline.kind==='unavailable'?'unavailable':baseline.notes.length?'partial':'complete',preexistingPaths:baseline.preexistingPaths,notes:[...baseline.notes],files:[]}
  if(baseline.kind==='unavailable')return report
  const reader=new GitReader()
  try {
    await reader.configure(baseline.project)
    try{report.headAfter=(await reader.run(baseline.project,['rev-parse','--verify','HEAD'])).toString().trim()}catch{}
    const candidates=[...new Set([...baseline.paths,...await allPaths(reader,baseline.project)])].sort()
    if(candidates.length>baseline.limits.maxPaths){report.status='partial';report.notes.push('变更文件数量超过限制，未列出的文件尚未检查。')}
    let bytes=0,diffBytes=0
    for(const path of candidates.slice(0,baseline.limits.maxPaths)) {
      const file:ReviewFile={path,preexisting:baseline.preexistingPaths.includes(path),kind:'not_reviewed'}
      if(bytes>=baseline.limits.maxTotalBytes){file.reason='内容总量超过限制';report.files.push(file);report.status='partial';continue}
      if(!reader.remaining()){report.status='partial';report.notes.push('读取超时，其余文件尚未检查。');break}
      const before=original(baseline,path)
      const beforeBytes=before.kind!=='missing'?before.bytesRead??0:0
      const after=working(baseline.project,path,baseline.limits,Math.max(0,baseline.limits.maxTotalBytes-bytes-beforeBytes))
      bytes+=beforeBytes+(after.kind!=='missing'?after.bytesRead??0:0)
      if(before.kind!=='missing'&&after.kind!=='missing'&&before.hash&&before.hash===after.hash&&before.mode===after.mode)continue
      if(before.kind==='skipped'||after.kind==='skipped'){file.reason=before.kind==='skipped'?before.reason:after.kind==='skipped'?after.reason:'';report.files.push(file);report.status='partial';continue}
      if(before.kind==='missing'&&after.kind==='missing')continue
      if(before.kind==='text'&&after.kind==='text'&&before.hash===after.hash&&before.mode===after.mode)continue
      const oldText=before.kind==='text'?before.text:'',newText=after.kind==='text'?after.text:''
      file.beforeSha256=before.kind==='text'?before.hash:undefined;file.afterSha256=after.kind==='text'?after.hash:undefined
      file.kind=before.kind==='missing'?'added':after.kind==='missing'?'deleted':'modified'
      try {
        if(diffBytes>=baseline.limits.maxDiffBytes)throw new Error('diff_limit')
        file.diff=await diffText(reader,oldText,newText,Math.min(baseline.limits.maxDiffBytes-diffBytes,1024*1024))
        if(!file.diff)file.reason=oldText===newText?'执行权限发生变化':'空文件发生变化'
        diffBytes+=Buffer.byteLength(file.diff)
      }catch{file.kind='not_reviewed';file.reason='差异超过预览限制或无法生成';report.status='partial'}
      report.files.push(file)
    }
  } catch {report.status='unavailable';report.notes.push('结束时的项目状态无法读取，不能据此判断有没有修改。')}
  return report
}

/** JSON escaping can multiply raw hunk size; enforce the persisted-byte limit too. */
export function serializeGitReview(review:GitReview,maxBytes=MAX_ARTIFACT_BYTES):Buffer {
  const bounded:GitReview={...review,files:review.files.map(file=>({...file})),notes:[...review.notes]}
  let bytes=Buffer.from(JSON.stringify(bounded))
  if(bytes.length<=maxBytes)return bytes
  bounded.status='partial';bounded.notes.push('部分差异超过保存大小限制，未能展开。')
  for(const file of [...bounded.files].reverse()) {
    if(!file.diff)continue
    delete file.diff;file.kind='not_reviewed';file.reason='差异超过保存大小限制'
    bytes=Buffer.from(JSON.stringify(bounded));if(bytes.length<=maxBytes)return bytes
  }
  bounded.files=[];bounded.preexistingPaths=[];bounded.notes=['文件清单超过保存大小限制，此次对比无法完整保存。']
  bytes=Buffer.from(JSON.stringify(bounded))
  if(bytes.length>maxBytes)throw new Error('review_size_limit')
  return bytes
}

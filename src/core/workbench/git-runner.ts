import {spawn} from 'node:child_process'
import {existsSync,lstatSync} from 'node:fs'
import {dirname,isAbsolute,join,resolve} from 'node:path'
import {verifyFromFilesystemRoot} from './anchored-fs'

export interface GitRunOptions {input?:Buffer;privateIndexPath?:string}
export interface GitRunnerOptions {timeoutMs?:number;privateIndexRoot?:string}
const NULL=process.platform==='win32'?'NUL':'/dev/null'
const SAFE_CONFIG=['-c','core.hooksPath='+NULL,'-c','core.fsmonitor=false','-c','credential.helper=','-c','core.askPass=','-c','core.pager=cat','-c','core.autocrlf=false','-c','core.safecrlf=false','-c','core.attributesFile='+NULL,'-c','submodule.recurse=false']
const identity=(path:string)=>{const stat=verifyFromFilesystemRoot(path,'git_invalid_private_index').stat;return `${stat.dev}:${stat.ino}`}

/** argv-only asynchronous Git; no inherited Git configuration, credentials or implicit programs. */
export function createGitRunner(options:GitRunnerOptions={}) {
  const timeoutMs=options.timeoutMs??30_000
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1)throw Error('git_invalid_timeout')
  const privateRoot=options.privateIndexRoot?resolve(options.privateIndexRoot):null
  const privateIdentity=privateRoot?identity(privateRoot):null
  const execute=(cwd:string,args:readonly string[],runOptions:GitRunOptions,allowedCodes:number[]=[])=>new Promise<Buffer>((accept,reject)=>{
    if(!isAbsolute(cwd)||args.some(arg=>typeof arg!=='string'||arg.includes('\0'))){reject(Error('git_invalid_arguments'));return}
    const env:NodeJS.ProcessEnv={}
    for(const [key,value] of Object.entries(process.env))if(!key.toUpperCase().startsWith('GIT_')&&!['SSH_ASKPASS','SSH_ASKPASS_REQUIRE'].includes(key))env[key]=value
    Object.assign(env,{GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:NULL,GIT_TERMINAL_PROMPT:'0',GIT_OPTIONAL_LOCKS:'0',GIT_LITERAL_PATHSPECS:'1',GIT_NO_REPLACE_OBJECTS:'1',GIT_ASKPASS:NULL})
    if(runOptions.privateIndexPath){
      const path=runOptions.privateIndexPath
      try{
        if(!privateRoot||!isAbsolute(path)||path!==join(privateRoot,'index')||dirname(path)!==privateRoot||identity(privateRoot)!==privateIdentity||(existsSync(path)&&(!lstatSync(path).isFile()||lstatSync(path).isSymbolicLink()||lstatSync(path).nlink!==1)))throw Error('git_invalid_private_index')
      }catch{reject(Error('git_invalid_private_index'));return}
      env.GIT_INDEX_FILE=path
    }
    const child=spawn('git',[...SAFE_CONFIG,'-C',cwd,...args],{env,stdio:['pipe','pipe','pipe'],detached:process.platform!=='win32',windowsHide:true})
    const output:Buffer[]=[];let length=0,failure:string|null=null
    const stop=()=>{try{if(process.platform!=='win32'&&child.pid)process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL')}catch{/* already exited */}}
    const timer=setTimeout(()=>{failure='git_timeout';stop()},timeoutMs)
    child.stdout.on('data',(bytes:Buffer)=>{length+=bytes.length;if(length>64*1024*1024){failure='git_output_limit';stop()}else output.push(bytes)})
    // Drain diagnostics without exposing project config, credential values or paths.
    child.stderr.resume();child.stdin.on('error',()=>{});child.stdin.end(runOptions.input)
    child.once('error',()=>{clearTimeout(timer);reject(Error('git_unavailable'))})
    child.once('close',code=>{clearTimeout(timer);if(failure)reject(Error(failure));else if(code!==0&&!allowedCodes.includes(code??-1))reject(Error('git_failed'));else accept(Buffer.concat(output))})
  })
  return {
    async run(cwd:string,args:readonly string[],runOptions:GitRunOptions={}):Promise<Buffer> {
      // Reading config does not execute it. Enumerate every filter name (including
      // include/worktree config) and override all execution-bearing filter keys.
      const keys=await execute(cwd,['config','--null','--name-only','--get-regexp','^filter\\.'],{},[1])
      const filters=new Set(keys.toString('utf8').split('\0').filter(Boolean).map(key=>key.replace(/^filter\./i,'').replace(/\.[^.]+$/,'')))
      const disabled:string[]=[]
      for(const filter of filters)for(const [key,value] of [['clean',''],['smudge',''],['process',''],['required','false']])disabled.push('-c',`filter.${filter}.${key}=${value}`)
      return execute(cwd,[...disabled,...args],runOptions)
    },
  }
}
export type GitRunner=ReturnType<typeof createGitRunner>

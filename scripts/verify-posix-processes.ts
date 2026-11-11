/** Metadata polling plus a per-step inherited marker for adopted test workers.
 * Marker discovery is cooperative ownership evidence, not hostile containment.
 * Never print or retain the environment read from another process.
 */
import {readdirSync,readFileSync,statSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
import type {VerifyProcess} from './verify-process-tree'

export const VERIFY_OWNER_ENV='CC_VERIFY_OWNER_TOKEN'

function linuxProcess(pid:number):VerifyProcess|null {
  try {
    const path=`/proc/${pid}`
    const raw=readFileSync(`${path}/stat`,'utf8')
    // comm may contain whitespace and parentheses; fields after its final ')'
    // start at stat field 3. Field 22 is the kernel start tick, not ps seconds.
    const fields=raw.slice(raw.lastIndexOf(')')+2).trim().split(/\s+/)
    if(fields.length<20)throw Error(`Incomplete process stat for PID ${pid}`)
    return {pid,parent:Number(fields[1]),birth:fields[19]!,state:fields[0],uid:statSync(path).uid}
  } catch(error){
    if(['ENOENT','ESRCH'].includes((error as NodeJS.ErrnoException).code??''))return null
    throw error
  }
}

function macProcesses(pid?:number):VerifyProcess[]|null {
  const args=pid===undefined?['-axo','pid=,ppid=,uid=,stat=,lstart=']:['-p',String(pid),'-o','pid=,ppid=,uid=,stat=,lstart=']
  const result=spawnSync('/bin/ps',args,{encoding:'utf8',timeout:500,maxBuffer:4_000_000})
  if(result.status!==0)return null
  return result.stdout.trim().split('\n').flatMap(line=>{
    const match=line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/)
    return match?[{pid:Number(match[1]),parent:Number(match[2]),uid:Number(match[3]),state:match[4],birth:match[5]!}]:[]
  })
}

function processTable():VerifyProcess[]|null {
    try {
      if(process.platform==='linux')return readdirSync('/proc').flatMap(name=>{
        if(!/^\d+$/.test(name))return []
        const row=linuxProcess(Number(name));return row?[row]:[]
      })
      return macProcesses()
    } catch{return null}
}

interface ProcessReads {
  table():VerifyProcess[]|null
  marker(row:VerifyProcess,assignment:string):boolean
  process(pid:number):VerifyProcess|null
}
const nativeReads:ProcessReads={
  table:processTable,
  marker:(row,assignment)=>{
    if(process.platform==='linux')return readFileSync(`/proc/${row.pid}/environ`,'utf8').split('\0').includes(assignment)
    const result=spawnSync('/bin/ps',['-Eww','-p',String(row.pid),'-o','command='],{encoding:'utf8',timeout:500,maxBuffer:1_000_000})
    return result.status===0&&result.stdout.split(/\s+/).includes(assignment)
  },
  process:pid=>process.platform==='linux'?linuxProcess(pid):macProcesses(pid)?.[0]??null,
}

export function makeVerifyProcessSource(token:string,reads:ProcessReads=nativeReads) {
  // Do not inspect environments of pre-existing processes. PID reuse still has
  // to pass birth verification, and absent identities are never refreshed.
  const initial=reads.table()
  const baseline=initial===null?null:new Map(initial.map(row=>[row.pid,row.birth]))
  let root:number|undefined
  const assignment=`${VERIFY_OWNER_ENV}=${token}`
  const owns=(row:VerifyProcess):boolean=>{
    if(row.pid===process.pid||row.uid!==process.getuid?.()||baseline?.get(row.pid)===row.birth||row.state?.startsWith('Z'))return false
    // Without a baseline we cannot tell old unrelated processes from new
    // candidates. Only the exact launcher is eligible for an environment read.
    if(baseline===null&&row.pid!==root)return false
    try {
      if(!reads.marker(row,assignment))return false
      const current=reads.process(row.pid)
      return current?.birth===row.birth
    } catch{return false}
  }
  return {table:reads.table,owns,baselineAvailable:baseline!==null,launched(pid:number|undefined){root=pid}}
}

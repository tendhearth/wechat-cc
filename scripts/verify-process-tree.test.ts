import {expect,it} from 'vitest'
import {createVerifyProcessTree,type VerifyProcess} from './verify-process-tree'
import {verifyLaunchTarget} from './verify-runner'
import {makeVerifyProcessSource} from './verify-posix-processes'

const row=(pid:number,parent:number,birth:string):VerifyProcess=>({pid,parent,birth})
function setup(initial:VerifyProcess[]) {
  let rows=initial
  const signals:Array<[number,string]>=[],reports:string[]=[]
  const tree=createVerifyProcessTree(10,{table:()=>rows,signal:(pid,sig)=>{signals.push([pid,sig])},report:line=>reports.push(line)})
  tree.snapshot()
  return {tree,signals,reports,table:(next:VerifyProcess[])=>{rows=next}}
}
it('never adopts or signals a reused root PID, its group, or its new descendants',()=>{
  const s=setup([row(10,1,'old'),row(11,10,'child')])
  s.table([row(10,1,'new'),row(12,10,'stranger'),row(11,1,'child')]);s.tree.stop()
  expect(s.signals).toEqual([[11,'SIGSTOP'],[11,'SIGKILL']])
  expect(s.reports.join('\n')).toContain('10')
})
it('cannot claim a root first observed after its launch identity was lost',()=>{
  const s=setup([]);s.table([row(10,1,'new'),row(12,10,'stranger')]);s.tree.stop()
  expect(s.signals).toEqual([])
  expect(s.reports.join('\n')).toContain('10')
})
it('an exited root is never an ancestry anchor again, even with the same coarse start timestamp',()=>{
  const s=setup([row(10,1,'old'),row(11,10,'child')]);s.tree.rootExited()
  s.table([row(10,1,'old'),row(12,10,'stranger'),row(11,1,'child')]);s.tree.stop()
  expect(s.signals).toEqual([[11,'SIGSTOP'],[11,'SIGKILL']])
})
it('rechecks identity immediately before each actual signal',()=>{
  let reads=0
  const signals:Array<[number,string]>=[]
  const tree=createVerifyProcessTree(10,{
    table:()=>{reads++;return [row(10,1,reads<=2?'old':'new')]},
    signal:(pid,sig)=>{signals.push([pid,sig])},report:()=>{},
  })
  tree.snapshot();tree.stop()
  expect(signals).toEqual([])
})
it('Windows requires a kill-on-close Job before starting any verify command',()=>{
  expect(verifyLaunchTarget('node',['test.js'],'win32',()=>({kind:'found',path:'C:\\cc-jobspawn.exe',from:'env'}))).toEqual({command:'C:\\cc-jobspawn.exe',args:['--require-job','node','test.js']})
})
it('Windows refuses to start without Job ownership rather than claiming tree cleanup',()=>{
  expect(()=>verifyLaunchTarget('node',['test.js'],'win32',()=>({kind:'missing',tried:['missing.exe']}))).toThrow(/Job|jobspawn/)
})

// These execute on Windows CI; no taskkill or shell shim is involved.
import {afterEach,vi} from 'vitest'
import {mkdtempSync,readFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {preparationJobspawnFixture} from '../src/test-support/preparation-jobspawn'
import {findOnPath} from '../src/lib/util'
import {runVerifyStep} from './verify-runner'
preparationJobspawnFixture()
afterEach(()=>vi.unstubAllEnvs())
it.runIf(process.platform==='win32').each([true,false])('Windows Job clears descendants when launcher exits=%s',async exit=>{
  const root=mkdtempSync(join(tmpdir(),'verify-win-job-'))
  let pid=0
  try {
    vi.stubEnv('CC_VERIFY_SILENCE_TIMEOUT_MS','2000')
    const code=`const cp=require('node:child_process'),fs=require('node:fs');const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000);setTimeout(()=>process.exit(0),15000)'],{stdio:'inherit'});fs.writeFileSync('child.pid',String(child.pid));${exit?'setTimeout(()=>process.exit(0),300)':'setInterval(()=>{},1000)'}`
    const result=await runVerifyStep('Windows Job',findOnPath('node')!,['-e',code],root)
    pid=Number(readFileSync(join(root,'child.pid'),'utf8'))
    expect(result).toEqual({status:exit?0:1,timedOut:!exit})
    await expect.poll(()=>{try{process.kill(pid,0);return true}catch{return false}}).toBe(false)
  } finally {
    rmSync(root,{recursive:true,force:true})
  }
})
it('a failed final snapshot cannot forget processes it already froze',()=>{
  let reads=0
  const signals:Array<[number,string]>=[]=[]
  const tree=createVerifyProcessTree(10,{
    table:()=>{reads++;return reads===5?null:[row(10,1,'old')]},
    signal:(pid,sig)=>{signals.push([pid,sig])},report:()=>{},
  })
  tree.snapshot();tree.stop()
  expect(signals).toEqual([[10,'SIGSTOP'],[10,'SIGKILL']])
})

it('retains descendants first seen in the identity check before a parent is stopped',()=>{
  let reads=0
  let orphaned=false
  const signals:Array<[number,string]>=[]
  const tree=createVerifyProcessTree(10,{
    table:()=>{reads++;return orphaned?[row(10,1,'root'),row(12,1,'grandchild')]:[
      row(10,1,'root'),row(11,10,'child'),...(reads>=3?[row(12,11,'grandchild')]:[]),
    ]},
    signal:(pid,sig)=>{signals.push([pid,sig]);if(pid===10&&sig==='SIGSTOP')orphaned=true},
    report:()=>{},
  })
  tree.snapshot();tree.stop()
  expect(signals).toContainEqual([12,'SIGKILL'])
})

it('never readopts a disappeared descendant even if a reused PID has the same coarse birth',()=>{
  const s=setup([row(10,1,'root'),row(11,10,'same second')])
  s.table([row(10,1,'root')]);s.tree.snapshot()
  s.table([row(10,1,'root'),row(11,1,'same second'),row(12,11,'stranger')]);s.tree.stop()
  expect(s.signals).toEqual([[10,'SIGSTOP'],[10,'SIGKILL']])
})

it('freezes parents before children even when ps returns children first',()=>{
  const s=setup([row(11,10,'child'),row(10,1,'root')]);s.tree.stop()
  expect(s.signals.slice(0,2)).toEqual([[10,'SIGSTOP'],[11,'SIGSTOP']])
})

it('recovers a root after a failed first table only with independent launch evidence',()=>{
  let rows:VerifyProcess[]|null=null
  const signals:Array<[number,string]>=[]
  const tree=createVerifyProcessTree(10,{
    table:()=>rows,owns:r=>r.birth==='launched',signal:(pid,sig)=>{signals.push([pid,sig])},report:()=>{},
  })
  tree.snapshot();rows=[row(10,1,'launched'),row(11,10,'child')];tree.stop()
  expect(signals).toContainEqual([11,'SIGKILL'])
  expect(signals).toContainEqual([10,'SIGKILL'])
})

it('retries a failed kill identity read and confirms death before cleanup succeeds',async()=>{
  let reads=0,dead=false
  const signals:Array<[number,string]>=[]
  const tree=createVerifyProcessTree(10,{
    table:()=>{reads++;return reads===6?null:dead?[]:[row(10,1,'root')]},
    signal:(pid,sig)=>{signals.push([pid,sig]);if(sig==='SIGKILL')dead=true},report:()=>{},
  })
  tree.snapshot()
  expect(await tree.cleanup(100)).toBe(true)
  expect(signals).toContainEqual([10,'SIGKILL'])
})

it('reports each live residual PID when cleanup cannot kill it',async()=>{
  const reports:string[]=[]
  const tree=createVerifyProcessTree(10,{
    table:()=>[row(10,1,'root'),row(11,10,'child')],signal:()=>{throw Error('EPERM')},report:line=>reports.push(line),
  })
  tree.snapshot()
  expect(await tree.cleanup(30)).toBe(false)
  expect(reports.join('\n')).toMatch(/residual PID 10/)
  expect(reports.join('\n')).toMatch(/residual PID 11/)
})

it('rechecks independent launch evidence before signalling a marker-recovered PID',()=>{
  let marked=true
  const signals:Array<[number,string]>=[]
  const tree=createVerifyProcessTree(10,{
    table:()=>[row(10,1,'same second')],owns:()=>marked,signal:(pid,sig)=>signals.push([pid,sig]),report:()=>{},
  })
  tree.snapshot();marked=false;tree.stop()
  expect(signals).toEqual([])
})

it('never spends the cleanup deadline freezing processes and then skips killing those already frozen',()=>{
  let now=0
  const clock=vi.spyOn(performance,'now').mockImplementation(()=>now)
  const signals:Array<[number,string]>=[]
  try {
    const tree=createVerifyProcessTree(10,{
      table:()=>{now+=10;return [row(10,1,'root'),row(11,10,'child'),row(12,11,'grandchild')]},
      signal:(pid,sig)=>signals.push([pid,sig]),report:()=>{},
    })
    tree.snapshot();tree.stop(now+35)
    const frozen=signals.filter(([,sig])=>sig==='SIGSTOP').map(([pid])=>pid)
    expect(frozen.length).toBeGreaterThan(0)
    for(const pid of frozen)expect(signals).toContainEqual([pid,'SIGKILL'])
  } finally{clock.mockRestore()}
})

it('a marker-recovered PID that loses its evidence cannot anchor new descendants',()=>{
  let trusted=true
  let rows=[row(10,1,'root'),row(11,1,'same second')]
  const signals:Array<[number,string]>=[]
  const tree=createVerifyProcessTree(10,{
    table:()=>rows,owns:r=>r.pid===10||(r.pid===11&&trusted),signal:(pid,sig)=>signals.push([pid,sig]),report:()=>{},
  })
  tree.snapshot(true);trusted=false;rows=[...rows,row(12,11,'stranger')];tree.stop()
  expect(signals).toEqual([[10,'SIGSTOP'],[10,'SIGKILL']])
})

it('a missing baseline reads only the launched roots environment, never unrelated existing processes',()=>{
  const root={...row(10,1,'root'),uid:process.getuid?.()}
  const other={...row(11,1,'other'),uid:process.getuid?.()}
  const environments:number[]=[]
  const source=makeVerifyProcessSource('test-token',{
    table:()=>null,marker:r=>{environments.push(r.pid);return true},process:pid=>pid===10?root:other,
  })
  source.launched(10)
  expect(source.baselineAvailable).toBe(false)
  expect(source.owns(other)).toBe(false)
  expect(environments).toEqual([])
  expect(source.owns(root)).toBe(true)
  expect(environments).toEqual([10])
})

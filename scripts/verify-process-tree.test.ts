import {expect,it} from 'vitest'
import {createVerifyProcessTree,type VerifyProcess} from './verify-process-tree'
import {verifyLaunchTarget} from './verify-runner'

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

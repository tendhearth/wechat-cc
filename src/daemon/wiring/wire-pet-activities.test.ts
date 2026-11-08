import {afterEach,expect,it} from 'vitest'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {wirePetTurn} from './wire-pet-turn'
import type {WirePetTurnDeps} from './wire-pet-turn'
const dirs:string[]=[]
afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true})})
function deps():WirePetTurnDeps {
 const stateDir=mkdtempSync(join(tmpdir(),'pet-activities-'));dirs.push(stateDir)
 return {stateDir,ilink:{listPendingPermissions:()=>[]},boot:{} as never,messagesStore:{latestInboundTs:async()=>null}}
}
it('adds the already owner-authorized projection while preserving legacy chat facts',async()=>{
 const d=deps(),old=await wirePetTurn(d)()
 expect(old).not.toHaveProperty('activities')
 const activities=[{taskId:'deadbeef',title:'本地任务',phase:'needs_input' as const,detail:'确认检查',updatedAt:1}]
 expect(await wirePetTurn({...d,activities:()=>activities})()).toEqual({...old,activities})
})
it('clears stale activities if projection fails without losing the legacy payload',async()=>{
 const d=deps(),old=await wirePetTurn(d)()
 expect(await wirePetTurn({...d,activities:()=>{throw Error('unavailable')}})()).toEqual({...old,activities:[]})
})

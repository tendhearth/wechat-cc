import {it,expect} from 'vitest'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {makeCheckupStore} from './checkup-store'
it('owner continuity: native capacity survives restart and remains scoped to endpoint and actual model',()=>{
 const dir=mkdtempSync(join(tmpdir(),'window-'))
 try{
  const target={provider:'claude',address:'https://endpoint.invalid',model:'claude-native',windowTokens:200000,windowKnown:true}
  const first=makeCheckupStore(dir).rotationBudgetFor(target,target.model)
  expect(first).toMatchObject({windowTokens:200000,reliableFillRatio:.6,windowSource:'measured'})
  const restarted=makeCheckupStore(dir),unknown={...target,windowTokens:32000,windowKnown:false}
  expect(restarted.rotationBudgetFor(unknown,target.model)).toMatchObject({windowTokens:200000,windowSource:'persisted'})
  expect(restarted.rotationBudgetFor({...unknown,address:'https://other.invalid'},target.model)).toMatchObject({windowTokens:32000,windowSource:'assumed'})
  expect(restarted.rotationBudgetFor(unknown,'other-model')).toMatchObject({windowTokens:32000,windowSource:'assumed'})
 }finally{rmSync(dir,{recursive:true,force:true})}
})

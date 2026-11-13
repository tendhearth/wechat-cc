import {it,expect} from 'vitest'
import {mkdtempSync,rmSync,mkdirSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {makeCheckupStore} from './checkup-store'
import {DEFAULT_CHECKUP_WINDOW,DEFAULT_RELIABLE_FILL} from '../../domain/butler-checkup'
const target={provider:'openai',model:'m',address:'https://offline.invalid',windowTokens:32000,windowKnown:false}
it('checkup defaults retain dev contract while rotation owns separate defaults',()=>{
 expect([DEFAULT_CHECKUP_WINDOW,DEFAULT_RELIABLE_FILL]).toEqual([8192,.25])
 const dir=mkdtempSync(join(tmpdir(),'window3-'))
 try{const store=makeCheckupStore(dir);expect(store.contextBudgetFor('openai','m')).toEqual({windowTokens:8192,reliableFillRatio:.25,source:'default'});expect(store.rotationBudgetFor(target,'m')).toMatchObject({windowTokens:32000,reliableFillRatio:.6})}finally{rmSync(dir,{recursive:true,force:true})}
})
it('overflow input persists an upper bound scoped to model and endpoint despite a larger reported window',()=>{
 const dir=mkdtempSync(join(tmpdir(),'window3-'))
 try{makeCheckupStore(dir).recordContextOverflow(target,30000);const store=makeCheckupStore(dir)
 expect(store.rotationBudgetFor({...target,windowTokens:200000,windowKnown:true},'m').windowTokens).toBe(30000)
 expect(store.rotationBudgetFor({...target,address:'https://other.invalid'},'m').windowTokens).toBe(32000)
 expect(store.rotationBudgetFor(target,'other').windowTokens).toBe(32000)
 store.recordContextOverflow(target,31000);expect(store.rotationBudgetFor(target,'m').windowTokens).toBe(30000)
 }finally{rmSync(dir,{recursive:true,force:true})}
})
it('window read and write failures log controlled diagnostics and surface in budget status',()=>{
 const dir=mkdtempSync(join(tmpdir(),'window3-')),logs:string[]=[]
 try{const folder=join(dir,'checkup');mkdirSync(folder);writeFileSync(join(folder,'context-windows.json'),'corrupt')
 const store=makeCheckupStore(dir,{log:(t,l)=>logs.push(t+':'+l)})
 expect(store.rotationBudgetFor(target,'m')).toMatchObject({budgetError:'window_read_failed'})
 expect(logs).toContain('CONTEXT_BUDGET:window_read_failed')
 expect(store.rotationBudgetFor({...target,windowTokens:200000,windowKnown:true},'m')).toMatchObject({windowTokens:200000,budgetError:'window_write_failed'})
 expect(logs).toContain('CONTEXT_BUDGET:window_write_failed')
 }finally{rmSync(dir,{recursive:true,force:true})}
})

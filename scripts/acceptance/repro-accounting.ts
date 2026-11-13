/** Offline reproduction of B.4: successful catchup remains one reply behind. */
import {existsSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {ContextRotation,type ContextKey} from '../../src/app/context-rotation'
const dir=process.env.WECHAT_STATE_DIR
if(!dir?.startsWith('/private/tmp/')||!dir.includes('/acc/state/')||!existsSync(join(dir,'.acceptance-only')))throw Error('explicit temporary state required')
const key:ContextKey={providerId:'openai',alias:'synthetic',chatId:'synthetic-owner'}
const jobs:Array<()=>Promise<void>>=[],rows:unknown[]=[]
let clock=Date.parse('2026-11-13T00:00:01Z'),latest=new Date(clock).toISOString(),watermark=new Date(clock-1000).toISOString(),rotations=0
const c=new ContextRotation({owner:()=>key.chatId,load:()=>({sessions:{},chats:{}}),save:()=>{},
 budgetFor:()=>({windowTokens:8192,reliableFillRatio:.6}),pending:()=>false,recent:async()=>[],ongoing:async()=>[],latestTs:async()=>latest,
 accounted:async(_chat,through)=>Date.parse(watermark)>=Date.parse(through),
 extract:async(_chat,_mode,through)=>{watermark=through!;return true},defer:job=>jobs.push(job),log:()=>{}})
const manager={isInFlight:()=>false,rotate:async()=>{rotations++;return true}}
await c.beforeTurn(key,'synthetic-model',manager)
c.observe(key,{tokens:1000});c.observe(key,{tokens:20000,turns:8})
for(let i=0;i<3;i++){
 await c.beforeTurn(key,'synthetic-model',manager)
 clock+=1000;latest=new Date(clock).toISOString()
 c.observe(key,{tokens:20000+i,turns:1});c.delivered(key,'合成回复',false)
 for(const job of jobs.splice(0))await job()
 rows.push({latest,watermark,status:c.status()[0]})
}
const reproduced=rotations===0&&rows.length===3&&Date.parse(watermark)<Date.parse(latest)
const result={reproduced,rotations,allExtractionsSucceeded:true,rows}
writeFileSync(join(dir,'B4-moving-boundary-repro.json'),JSON.stringify(result,null,2))
console.log(JSON.stringify(result))
if(!reproduced)process.exit(1)

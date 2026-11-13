/** Replay the fictional reply from D.3; no provider or daemon call. */
import {existsSync,readFileSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {buildInterviewPlan,scoreInterview} from '../../src/domain/checkup-interview'
const dir=process.env.WECHAT_STATE_DIR
if(!dir?.startsWith('/private/tmp/')||!dir.includes('/acc/state/')||!existsSync(join(dir,'.acceptance-only')))throw Error('explicit temporary state required')
const observation=readFileSync(join(dir,'checkup-observations.jsonl'),'utf8').split('\n').filter(Boolean).map(s=>JSON.parse(s)).find(r=>r.id==='1/0/recall'&&r.toolCalls.some((c:any)=>c.name==='reply'))
if(!observation)throw Error('round-three fictional reply required')
const persona={name:'验收CC',userTitle:'验收主人',selfTitle:'验收CC'}
const sample=buildInterviewPlan({windowTokens:262144,full:false,seed:769906,persona,executors:['fictional']}).samples.find(s=>s.id==='1/0/recall')!
const score=scoreInterview(sample,{text:'',toolCalls:observation.toolCalls,firstTextMs:null,durationMs:0},persona)
const answer=observation.toolCalls.find((c:any)=>c.name==='reply').input.text as string
const result={sampleId:sample.id,hasExplicitUnknownDenial:answer.includes('你之前没提过')&&answer.includes('没有')&&answer.includes('不能确认'),codeHonesty:score.qualities.honesty,humanHonesty:true}
writeFileSync(join(dir,'D3-honesty-repro.json'),JSON.stringify(result,null,2))
console.log(JSON.stringify(result))
if(!result.hasExplicitUnknownDenial||result.codeHonesty!==null)process.exit(1)

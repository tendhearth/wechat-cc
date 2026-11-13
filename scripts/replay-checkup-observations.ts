/** Offline, synthetic observations only. Does not start daemon or call a provider. */
import { readFileSync } from 'node:fs'
import { buildInterviewPlan } from '../src/domain/checkup-interview'
import { replayInterviewObservations, type SavedInterviewObservation } from '../src/domain/checkup-replay'

const path=process.argv[2]
if(!path)throw Error('Pass the synthetic run-15 checkup-observations.jsonl path')
const observations=readFileSync(path,'utf8').trim().split('\n').map(line=>JSON.parse(line) as SavedInterviewObservation).slice(0,24)
if(observations.length!==24||new Set(observations.map(o=>o.id)).size!==24)throw Error('Expected the 24-question short interview')
const plan=buildInterviewPlan({windowTokens:262144,full:false,seed:769906,persona:{name:'验收CC',userTitle:'验收主人',selfTitle:'验收CC'},executors:['worker']})
console.log(JSON.stringify(replayInterviewObservations(plan.samples,observations),null,2))

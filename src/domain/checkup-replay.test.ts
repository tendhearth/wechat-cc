import { expect, it } from 'vitest'
import observations from '../test-support/fixtures/checkup-round3-run15.json'
import { buildInterviewPlan } from './checkup-interview-legacy'
import { replayInterviewObservations } from './checkup-replay'

it('replays run-15 saved tool evidence and explicitly excludes the 14 lost prose answers',()=>{
 const p=buildInterviewPlan({windowTokens:262144,full:false,seed:769906,persona:{name:'验收CC',userTitle:'验收主人',selfTitle:'验收CC'},executors:['worker']})
 const result=replayInterviewObservations(p.samples,observations)
 expect(result.unavailable).toBe(14)
 expect(result.rows.filter(r=>r.status==='已重放')).toHaveLength(10)
 expect(result.old.qualities.memory).toEqual({passed:1,total:4,ratio:.25})
 expect(result.old.business).toEqual({passed:8,total:24,ratio:1/3})
 expect(result.replay.qualities.memory).toEqual({passed:1,total:1,ratio:1,unmeasured:3})
 expect(result.replay.qualities.honesty).toEqual({passed:1,total:1,ratio:1,unmeasured:3})
 expect(result.rows.find(r=>r.id==='1/0/recall')).toMatchObject({old:{qualities:{honesty:null}},score:{qualities:{honesty:true}}})
 expect(result.replay.reliableFillRatio).toBe(0) // incomplete first stage cannot establish a new reliable line
 for(const row of result.rows.filter(r=>r.status==='无法重放'))expect(row.score).toMatchObject({business:null,unmeasured:true})
})

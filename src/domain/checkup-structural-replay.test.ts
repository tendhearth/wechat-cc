import { expect, it } from 'vitest'
import evidence from '../test-support/fixtures/checkup-round4-run22.json'
import { replayRound4Structurally } from './checkup-structural-replay'

it('passes the four human-approved round-4 verbatim regressions using explicit old-question boundaries',()=>{
 const result=replayRound4Structurally(evidence)
 expect(result.rows).toHaveLength(24)
 expect(result.sourceVersion).toBe('interview-v2')
 expect(result.replay.version).toBe('interview-v2-structural-replay')
 for(const [id,key] of [['1/0/recall','honesty'],['1/0/clarify','discretion'],['1/0/handoff','stance']] as const){
  expect(result.rows.find(r=>r.id===id)!.score.qualities[key],id).toBe(true)
 }
 const title=result.rows.find(r=>r.id==='1/0/ordinary-handoff')!.score.persona!
 expect(title).toEqual({markers:['验收主人'],seen:['验收主人']})
 expect(result.replay.qualities.persona).toEqual({passed:2,total:2,ratio:1})
 expect(result.old.qualities.persona).toEqual({passed:2,total:4,ratio:.5})
 expect(result.old.qualities.honesty.unmeasured).toBe(3)
 expect(result.old.qualities.discretion.unmeasured).toBe(3)
 expect(result.old.qualities.stance.ratio).toBe(.5)
 expect(result.rows.every(r=>r.old.business===r.score.business)).toBe(true)
})
it('rejects incomplete or wrong-version evidence instead of silently mixing papers',()=>{
 expect(()=>replayRound4Structurally({...evidence,version:'interview-v3'})).toThrow('interview-v2')
 expect(()=>replayRound4Structurally({...evidence,samples:evidence.samples.slice(1)})).toThrow('complete')
})

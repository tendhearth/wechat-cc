/** Offline replay of this synthetic fourth-round exam; never contacts a daemon/model. */
import {readFileSync,existsSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {buildInterviewPlan,scoreInterview,summarizeInterview,interviewReply} from '../../src/domain/checkup-interview'
import {interviewInstructions} from '../../src/features/checkup/instructions'
import {estimateTokens} from '../../src/domain/butler-checkup'
import {checkupKey} from '../../src/adapters/store/checkup-store'
const dir=process.env.WECHAT_STATE_DIR
if(!dir?.startsWith('/private/tmp/')||!dir.includes('/acc/state/')||!existsSync(join(dir,'.acceptance-only')))throw Error('explicit synthetic state required')
const result=JSON.parse(readFileSync(join(dir,'D-round4-result.json'),'utf8')).body
if(result.attempt?.status!=='completed'||!result.profile?.interview||result.profile.interview.version!=='interview-v3')throw Error('completed v3 profile required')
const profile=result.profile,stored=JSON.parse(readFileSync(join(dir,'checkup/observations.json'),'utf8'))[checkupKey(result.target)]
const persona={name:'验收CC',userTitle:'验收主人',selfTitle:'验收CC'},executors=profile.interview.delegationAvailable?['阿禾']:[]
const plan=buildInterviewPlan({windowTokens:profile.windowTokens,full:!profile.short,seed:profile.seed,persona,executors,systemTokens:estimateTokens(interviewInstructions(result.target.provider,result.target.model,persona,executors))})
const observations=plan.samples.map(s=>stored.samples[s.id]),scores=plan.samples.map((s,i)=>observations[i]?scoreInterview(s,observations[i],persona):{qualities:{},business:null,observed:false,unmeasured:true})
if(result.attempt.totalRequests!==plan.samples.length||result.attempt.completedRequests!==plan.samples.length||observations.some((o,i)=>o&&(o.version!==plan.version||o.seed!==plan.seed||o.id!==plan.samples[i]!.id)))throw Error('v3 plan/observation mismatch')
const replay=summarizeInterview(plan.samples,scores)
const tools:Record<string,number>={}
for(const o of observations)for(const c of o?.toolCalls??[])tools[c.name]=(tools[c.name]??0)+1
const proof={version:plan.version,seed:plan.seed,questionCount:plan.samples.length,observedQuestions:observations.filter(Boolean).length,expectedActions:plan.samples.reduce((r,s)=>(r[s.expected.action]=(r[s.expected.action]??0)+1,r),{} as Record<string,number>),proseQuestions:observations.filter(o=>o&&interviewReply(o).trim()).length,proseOnlyQuestions:observations.filter(o=>o&&interviewReply(o).trim()&&!o.toolCalls.length).length,toolQuestions:observations.filter(o=>o?.toolCalls.length).length,toolCalls:tools,usageLimitedQuestions:observations.filter(o=>o?.usageLimited).length,replayMatchesQualities:JSON.stringify(replay.qualities)===JSON.stringify(profile.interview.qualities),replayMatchesBusiness:JSON.stringify(replay.business)===JSON.stringify(profile.interview.business),replay,reliableFillRatio:profile.reliableFillRatio,usage:result.attempt.usage,attempt:result.attempt,review:result.review,samples:plan.samples.map((s,i)=>({id:s.id,day:s.day,expected:s.expected,estimatedTokens:s.estimatedTokens,reply:observations[i]?interviewReply(observations[i]):'',toolCalls:observations[i]?.toolCalls??[],score:scores[i]}))}
writeFileSync(join(dir,'D-round4-proof.json'),JSON.stringify(proof,null,2))
console.log(JSON.stringify({...proof,samples:proof.samples.map(s=>({id:s.id,score:s.score}))}))

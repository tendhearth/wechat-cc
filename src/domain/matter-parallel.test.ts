import {expect,it} from 'vitest'
import {MatterPlanRequest} from '../../packages/protocol/src/desktop-api'
import {candidateResult,candidateStatus,compareCandidates,groupSettled,parseParallelChoice,type CandidateStatus} from './matter-parallel'

it.each([
  [['codex'],false],
  [['codex','claude'],true],
  [['codex','claude','openai'],true],
  [['codex','claude','openai','cursor'],false],
  [['codex',' codex '],false],
  [['codex','Codex'],false],
])('validates the executor list %j', (parallel,valid)=>{
  expect(MatterPlanRequest.safeParse({title:'各做一版',legs:[{parallel,brief:'同一个要求'}]}).success).toBe(valid)
})

it.each([
  ['completed','状态：做完',false,true,'completed'],
  ['completed','状态：要问主人',false,true,'interrupted'],
  ['completed','状态：没做完',false,false,'failed'],
  ['completed','状态：做完',true,true,'waiting'],
  ['completed','',true,false,'interrupted'],
  ['failed','状态：做完',false,false,'failed'],
  ['cancelled','',true,false,'cancelled'],
])('resolves %s / %s / question=%s / live=%s',(status,reply,asked,live,expected)=>{
  expect(candidateStatus(status,reply,asked,live)).toBe(expected)
})

it.each<[CandidateStatus[],boolean]>([
  [['completed','failed'],true],
  [['completed','completed','cancelled'],true],
  [['completed','waiting'],false],
  [['failed','queued'],false],
  [['interrupted','failed'],true],
])('waits for each member of %j',(statuses,expected)=>{
  expect(groupSettled(statuses.map(status=>({status})))).toBe(expected)
})

it.each([
  ['用 Codex 那版',{name:'Codex'}],
  ['用Claude那版 任务 abcd1234。',{name:'Claude',matterId:'abcd1234'}],
  ['用 Codex 那版 任务 deadbeef 对照 2',{name:'Codex',matterId:'deadbeef',revision:2}],
  ['先别用 Codex 那版',null],
  ['用 Codex 那版吗？',null],
])('recognizes the owner selection %s',(text,expected)=>expect(parseParallelChoice(text)).toEqual(expected))

it.each([
  {files:[{path:'app.ts',added:8,removed:3}],expected:'1 个文件，+8 / −3 行'},
  {files:[{path:'image.png',added:null,removed:null}],expected:'1 个文件'},
  {files:null,expected:'改动统计未取得'},
])('compares reported changes and verification ($expected)',({files,expected})=>{
  const report=compareCandidates('登录页',2,[
    {name:'Codex',status:'completed',taskId:'abcd1234',result:candidateResult('实际完成的验证：2 项通过\n状态：做完',files)},
    {name:'Claude',status:'failed',taskId:null,result:null},
  ])
  for(const text of [expected,'第 2 棒','2 项通过','状态：做完','任务 abcd1234','Claude · 没做成'])expect(report).toContain(text)
})

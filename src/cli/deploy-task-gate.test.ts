import { describe, expect, it, vi } from 'vitest'
import { readDeployTasks, waitForDeployTasks, type DeployTask, type DeployTaskGateDeps } from './deploy-task-gate'

const task:DeployTask={id:'aa11bb22',title:'整理周报',status:'running',phase:'working'}
function setup(pages:Array<DeployTask[]|null>=[[]],interactive=false) {
  let now=0,index=0
  const log=vi.fn(),choose=vi.fn(async(_message:string)=> 'wait' as 'wait'|'force'|'abort')
  const deps:DeployTaskGateDeps={tasks:async()=>pages[Math.min(index++,pages.length-1)]!,interactive,choose,
    now:()=>now,sleep:async(ms)=>{now+=ms},log}
  return {deps,log,choose,time:()=>now}
}
describe('部署交办任务门',()=>{
  it('已经答复的保留会话是可中断点；完成/失败任务也不阻挡',async()=>{
    const s=setup([[{...task,phase:'replied'},{...task,id:'cc33dd44',status:'failed',phase:'failed'}]])
    expect(await waitForDeployTasks(s.deps)).toBeNull();expect(s.time()).toBe(0)
  })
  it('忙任务按id/title列出；非交互无选项就拒绝',async()=>{
    const s=setup([[task]])
    expect(await waitForDeployTasks(s.deps)).toContain('--wait-tasks 或 --force')
    expect(s.log.mock.calls.flat().join('\n')).toContain('aa11bb22 · 整理周报')
    expect(s.time()).toBe(0)
  })
  it('--wait-tasks 等到回合边界后通过，超时则非零理由，不取消任务',async()=>{
    const s=setup([[task],[{...task,phase:'replied'}]])
    expect(await waitForDeployTasks(s.deps,{waitTasks:true,timeoutMs:10})).toBeNull()
    const hanging=setup([[task]])
    expect(await waitForDeployTasks(hanging.deps,{waitTasks:true,timeoutMs:10})).toContain('超时')
    expect(hanging.time()).toBe(10)
  })
  it('交互默认等；达到上限再问，可以强制继续',async()=>{
    const s=setup([[task]],true)
    s.choose.mockResolvedValueOnce('wait').mockResolvedValueOnce('force')
    expect(await waitForDeployTasks(s.deps,{timeoutMs:10})).toBeNull()
    expect(s.choose).toHaveBeenCalledTimes(2)
    expect(s.choose.mock.calls[1]?.[0]).toContain('已等到本轮上限')
  })
  it('--force照样列出任务；读失败默认拒绝，只有force能明确旁路',async()=>{
    const s=setup([[task]])
    expect(await waitForDeployTasks(s.deps,{force:true})).toBeNull();expect(s.log).toHaveBeenCalled()
    expect(await waitForDeployTasks(setup([null]).deps)).toContain('读不到')
    expect(await waitForDeployTasks(setup([null]).deps,{force:true})).toBeNull()
  })
  it('显式取消与冲突选项都拒绝，不能悄悄强制',async()=>{
    const s=setup([[task]],true);s.choose.mockResolvedValue('abort')
    expect(await waitForDeployTasks(s.deps)).toContain('已取消')
    expect(await waitForDeployTasks(s.deps,{force:true,waitTasks:true})).toContain('只能选一个')
  })
})

describe('现有API分页读交办任务',()=>{
  const info={baseUrl:'http://localhost:1',token:'file',operatorToken:'operator',tokenFilePath:'f',operatorTokenFilePath:'o'}
  it('取齐分页，用operator token，重读查询后看到第101件忙任务',async()=>{
    const first=Array.from({length:100},(_,i)=>({...task,id:String(i),status:'completed',phase:'replied'}))
    const fetcher=vi.fn(async(_input:string|URL|Request,_init?:RequestInit)=>Response.json({tasks:first,page:{hasMore:true,nextCursor:'next'}}))
      .mockResolvedValueOnce(Response.json({tasks:first,page:{hasMore:true,nextCursor:'next'}}))
      .mockResolvedValueOnce(Response.json({tasks:[task],page:{hasMore:false,nextCursor:null}}))
    const result=await readDeployTasks({readInfo:()=>info,fetch:fetcher})
    expect(result).toHaveLength(101)
    expect(fetcher.mock.calls[1]?.[0]).toContain('cursor=next')
    expect(fetcher.mock.calls[0]?.[1]?.headers).toEqual({authorization:'Bearer operator'})
    expect(await waitForDeployTasks({...setup().deps,tasks:async()=>result})).toContain('有 1 件在跑')
  })
  it('缺连接、坏页、HTTP拒绝与重复游标都返回未知，不当成空',async()=>{
    expect(await readDeployTasks({readInfo:()=>null,fetch})).toBeNull()
    for(const value of [{tasks:[]},{tasks:[{}],page:{hasMore:false}}]) {
      expect(await readDeployTasks({readInfo:()=>info,fetch:async()=>Response.json(value)})).toBeNull()
    }
    expect(await readDeployTasks({readInfo:()=>info,fetch:async()=>new Response('',{status:503})})).toBeNull()
    expect(await readDeployTasks({readInfo:()=>info,fetch:async()=>Response.json({tasks:[],page:{hasMore:true,nextCursor:'again'}})})).toBeNull()
  })
})

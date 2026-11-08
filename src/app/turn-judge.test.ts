import { expect, it, vi } from 'vitest'
import { createProviderRegistry } from './provider-registry'
import { turnJudge, TURN_JUDGE_TIMEOUT_MS } from './turn-judge'

it('后台钉 agy 时回合内仍走 API;没有 API 只用索引;允许显式配置', async () => {
  const registry = createProviderRegistry({ cheapEvalProvider: 'agy' })
  const seen: string[] = [], logs: string[] = []
  for (const id of ['openai', 'agy']) registry.register(id, { spawn: async () => { throw Error('unused') }, cheapEval: async () => { seen.push(id); return '1' } }, { canResume: () => false })
  await turnJudge(registry, undefined, (_tag, line) => logs.push(line))!('choose')
  expect(seen).toEqual(['openai'])
  expect(logs[0]).toMatch(/via=openai elapsedMs=\d+/)
  expect(turnJudge(registry, 'index')).toBeNull()
  await turnJudge(registry, 'agy')!('choose')
  expect(seen).toEqual(['openai', 'agy'])
  const slowOnly = createProviderRegistry({ cheapEvalProvider: 'agy' })
  slowOnly.register('agy', registry.get('agy')!.provider, { canResume: () => false })
  expect(turnJudge(slowOnly)).toBeNull()
})


it('快判边界自己限时，挂起的模型也按时记耗时与 via',async()=>{
  vi.useFakeTimers()
  try{
    const registry=createProviderRegistry(),logs:string[]=[]
    registry.register('openai',{spawn:async()=>{throw Error('unused')},cheapEval:()=>new Promise(()=>{})},{canResume:()=>false})
    const pending=turnJudge(registry,'auto',(_tag,line)=>logs.push(line))!('choose')
    const rejected=expect(pending).rejects.toThrow('turn_judge_timeout')
    await vi.advanceTimersByTimeAsync(TURN_JUDGE_TIMEOUT_MS)
    await rejected
    expect(logs).toEqual([`via=openai elapsedMs=${TURN_JUDGE_TIMEOUT_MS}`])
  }finally{vi.useRealTimers()}
})

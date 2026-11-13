import { describe, it, expect } from 'vitest'
import { ContextRotation, type ContextRotationDeps, type ContextState } from './context-rotation'
import type { ProviderId } from '../domain/conversation'

const ts = '2026-11-12T20:00:00.000Z'
function setup(providerId: ProviderId = 'claude', overrides: Partial<ContextRotationDeps> = {}) {
  const key = { providerId, alias: 'proj', chatId: 'owner' }
  let stored: ContextState = { sessions: {}, chats: {} }
  let now = Date.parse(ts), busy = false, pending = false, accounted = true, rotations = 0, extracted = 0
  const recent = Array.from({length:8}, (_,i) => [{dir:'in' as const,text:`主人原文 ${i}`,ts}, {dir:'out' as const,text:`回答 ${i}`,ts}]).flat()
  const context = new ContextRotation({
    owner: () => 'owner', load: () => stored, save: value => { stored = structuredClone(value) },
    now: () => now, budgetFor: () => ({ windowTokens: 20_000, reliableFillRatio: .25 }),
    pending: () => pending, recent: async () => recent, ongoing: async () => ['整理相册：正在校对'],
    latestTs: async () => ts, accounted: async () => accounted,
    extract: async () => { extracted++; return true },
    defer: job => { tasks.push(job) }, log: () => {}, ...overrides,
  })
  const tasks: (()=>Promise<void>)[] = []
  const sessions = { isInFlight: () => busy, rotate: async () => { if(busy) return false; rotations++; return true } }
  const prepare = () => context.beforeTurn(key, 'model', sessions)
  return { key, context, prepare, tasks, sessions, recent, setBusy:(v:boolean)=>{busy=v}, setPending:(v:boolean)=>{pending=v}, setAccounted:(v:boolean)=>{accounted=v}, advance:(ms:number)=>{now+=ms}, get rotations(){return rotations}, get extracted(){return extracted} }
}

describe('owner context rotation, shared policy', () => {
  for(const provider of ['claude','openai','gemini'] as const) it(`${provider}: rotates only at an accounted boundary and carries the last six rounds`, async () => {
    const s=setup(provider)
    await s.prepare()
    s.context.observe(s.key,{bytes:12_000,turns:1})
    s.context.delivered(s.key,'决定以后按这个颜色',false)
    await s.tasks.shift()!()
    const result=await s.prepare()
    expect(s.rotations).toBe(1)
    expect(result?.block).toContain('主人原文 7')
    expect(result?.block).toContain('主人原文 2')
    expect(result?.block).not.toContain('主人原文 1')
    expect(result?.block).toContain('整理相册：正在校对')
    expect(s.context.status()[0]).toMatchObject({reason:'budget',lastRotatedAt:ts,estimatedTokens:0})
  })
  it('does not replace a running turn or an unresolved approval', async () => {
    const s=setup();await s.prepare();s.context.observe(s.key,{bytes:20_000,turns:1})
    s.setBusy(true);await s.prepare();s.setBusy(false);s.setPending(true);await s.prepare()
    expect(s.rotations).toBe(0)
    s.setPending(false);await s.prepare();expect(s.rotations).toBe(1)
  })
  it('keeps the old segment and retries when extraction cannot catch up', async () => {
    const s=setup();await s.prepare();s.context.observe(s.key,{bytes:20_000,turns:1})
    s.context.delivered(s.key,'决定使用新格式',false);await s.tasks.shift()!()
    s.setAccounted(false)
    expect(await s.prepare()).toBeNull();expect(s.rotations).toBe(0)
    expect(s.context.status()[0]!.estimatedTokens).toBe(10_000)
    s.setAccounted(true);await s.prepare();expect(s.rotations).toBe(1)
  })
  it('rechecks pending approvals after async extraction and leaves the request pending', async () => {
    const s=setup(undefined,{accounted:async()=>false,extract:async()=>{s.setPending(true);return true}})
    await s.prepare();s.context.observe(s.key,{bytes:20_000,turns:1});s.context.delivered(s.key,'决定改成蓝色',false);await s.tasks.shift()!()
    await s.prepare();expect(s.rotations).toBe(0)
  })
  it('retains the old session if continuation cannot be read', async()=>{
    const s=setup(undefined,{recent:async()=>{throw Error('offline read failed')}})
    await s.prepare();s.context.observe(s.key,{bytes:20_000,turns:1})
    expect(await s.prepare()).toBeNull();expect(s.rotations).toBe(0)
  })
  it('nightly success requests one rotation; failure does not request one',async()=>{
    const s=setup();await s.prepare();s.context.observe(s.key,{bytes:10,turns:1})
    s.context.nightly('owner',false);await s.prepare();expect(s.rotations).toBe(0)
    s.context.nightly('owner',true);await s.prepare();await s.prepare();expect(s.rotations).toBe(1)
  })
  it('uses measured budgets, including zero, and conservative defaults',async()=>{
    const s=setup('openai',{budgetFor:()=>({windowTokens:1000,reliableFillRatio:.8})})
    await s.prepare();s.context.observe(s.key,{bytes:1500,turns:1});await s.prepare();expect(s.rotations).toBe(0)
    s.context.observe(s.key,{bytes:1700});await s.prepare();expect(s.rotations).toBe(1)
    const fallback=setup('claude',{budgetFor:()=>{throw Error('not ready')}});await fallback.prepare()
    expect(fallback.context.status()[0]!.budgetTokens).toBe(2048)
    const zero=setup('claude',{budgetFor:()=>({windowTokens:8192,reliableFillRatio:0})});await zero.prepare();zero.context.observe(zero.key,{bytes:1,turns:1});await zero.prepare();expect(zero.rotations).toBe(1)
  })
  it('post-delivery extraction is deferred, bounded by cooldown and daily attempts, and silent if unavailable',async()=>{
    const s=setup();await s.prepare()
    s.context.delivered(s.key,'我决定以后都用绿色',false)
    expect(s.extracted).toBe(0)
    await s.tasks.shift()!();expect(s.extracted).toBe(1)
    s.context.delivered(s.key,'我偏好绿色',false);await s.tasks.shift()!();expect(s.extracted).toBe(1)
    for(let i=0;i<24;i++){s.advance(300_000);s.context.delivered(s.key,'我决定用绿色',false);await s.tasks.shift()!()}
    expect(s.extracted).toBe(24)
    const absent=setup(undefined,{extract:async()=>false});await absent.prepare();absent.context.delivered(absent.key,'决定改一改',false);await expect(absent.tasks.shift()!()).resolves.toBeUndefined()
  })
  it('ignores ordinary short chat and non-owner sessions',async()=>{
    const s=setup();await s.prepare();s.context.delivered(s.key,'好的',false);await s.tasks.shift()!();expect(s.extracted).toBe(0)
    expect(await s.context.beforeTurn({...s.key,chatId:'guest'},'model',s.sessions)).toBeNull()
  })
})

it('ephemeral owner sessions never register themselves as owner conversation segments',async()=>{
  const s=setup();await s.prepare()
  s.context.started({...s.key,alias:'companion:short'})
  s.context.observe({...s.key,alias:'companion:short'},{bytes:1_000_000,turns:1})
  expect(s.context.status()).toHaveLength(1)
})

it('a first failed turn must catch up its owner input before rotation',async()=>{
  const s=setup(undefined,{extract:async()=>false});await s.prepare()
  s.context.observe(s.key,{bytes:50_000,turns:1});s.setAccounted(false)
  expect(await s.prepare()).toBeNull()
  expect(s.rotations).toBe(0)
})

import { afterEach, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeTempDir } from '../../lib/test-temp'
import { makeRunPermissions } from './permissions'
import { PendingPermissions, parsePermissionReply } from '../../daemon/pending-permissions'
import { PermissionsPendingResponse } from '@wechat-cc/protocol/desktop-api'

const cleanup:Array<()=>void>=[]
afterEach(()=>{for(const fn of cleanup.splice(0))fn()})

it('automatic continuation inherits earlier owner rejections instead of starting a fresh allowance',async()=>{
  const p=makeRunPermissions({taskId:'task',initialDenials:2})
  cleanup.push(()=>p.rejectAll())
  const answer=p.request({tool:'Bash',description:'ask again after an automatic continuation'})
  expect(p.resolve(p.pending()[0]!.id,'deny')).toBe(true)
  expect(await answer).toBe(false)
  expect(p.denialLimitReached()).toBe(true)
})

it('review P1: automatic owner rules cannot erase three explicit owner rejections',async()=>{
  const p=makeRunPermissions({taskId:'task',root:process.cwd(),provider:'codex',decide:async facts=>facts.description==='automatic'?{verdict:'allow',by:'rule'}:{verdict:'ask',by:'default'}})
  cleanup.push(()=>p.rejectAll())
  for(let i=0;i<3;i++){
    const answer=p.request({tool:'Bash',description:'ask owner'})
    await expect.poll(()=>p.pending()).toHaveLength(1)
    expect(p.resolve(p.pending()[0]!.id,'deny')).toBe(true);expect(await answer).toBe(false)
    expect(await p.request({tool:'Bash',command:'pwd',cwd:process.cwd(),description:'automatic'})).toBe(true)
  }
  expect(p.denialLimitReached()).toBe(true)
})

it.skipIf(process.platform==='win32')('review P1: reusing a task grant cannot erase owner rejections',async()=>{
  const root=mkdtempSync(join(tmpdir(),'cc-review-denials-'))
  const p=makeRunPermissions({taskId:'task',root,provider:'codex',executionEnvironment:()=>({kind:'direct',env:{PATH:'/usr/bin:/bin'}})})
  cleanup.push(()=>{p.rejectAll();removeTempDir(root)})
  const automatic=()=>p.request({tool:'Bash',command:'pwd',cwd:root,description:'pwd'})
  const first=automatic();expect(p.pending()[0]!.canAllowTask).toBe(true)
  expect(p.resolve(p.pending()[0]!.id,'allow_task')).toBe(true);expect(await first).toBe(true)
  for(let i=0;i<3;i++){
    const answer=p.request({tool:'Bash',description:'ask owner'})
    p.resolve(p.pending()[0]!.id,'deny');expect(await answer).toBe(false)
    expect(await automatic()).toBe(true);expect(p.pending()).toHaveLength(0)
  }
  expect(p.denialLimitReached()).toBe(true)
})

it.each(['不行 10 分钟后再说','拒绝 10 分钟后再试','no 10 minutes later','n07 原因','n 7 原因','n\n07 原因','n 00 原因'])('review P2 format: ordinary or ambiguous text stays ordinary: %s',text=>{
  expect(parsePermissionReply(text)).toBeNull()
})

it('review P2 capability: unsupported cards reject reasons without consuming the card',async()=>{
  const p=new PendingPermissions(),answer=p.register('plain',10000,{chatId:'owner',prompt:'plain'})
  expect(p.consume('plain','deny','不要 SSH')).toBe(false)
  expect(p.list()).toHaveLength(1)
  expect(p.consume('plain','deny')).toBe(true);expect(await answer).toBe('deny')
})

it('review P2 capability: reason support survives the actual permission-list schema only with a delivery channel',async()=>{
  const p=new PendingPermissions(),meta={chatId:'owner',prompt:'task',canDenyWithReason:true}
  const answer=p.register('supported',10000,meta,undefined,undefined,()=>true)
  const rows=PermissionsPendingResponse.parse({items:p.list()}).items
  expect(rows[0]).toHaveProperty('canDenyWithReason',true)
  p.consume('supported','deny');expect(await answer).toBe('deny')
  const unavailable=p.register('unsupported',10000,meta)
  expect(PermissionsPendingResponse.parse({items:p.list()}).items[0]).not.toHaveProperty('canDenyWithReason',true)
  p.consume('unsupported','deny');expect(await unavailable).toBe('deny')
})

import {expect,it} from 'vitest'
import {openDb} from '../../lib/db'
import {makeWorkbenchStore} from './workbench/store'
import {makeMatterShares,SHARES_PER_MATTER_MAX} from './matter-shares'
import {SHARE_TTL_MS} from '../../domain/matters/share-scope'

function setup(){
  const db=openDb({path:':memory:'})
  let clock=1_800_000_000_000
  const tasks=makeWorkbenchStore(db),shares=makeMatterShares(db,()=>clock)
  const task=tasks.create({title:'登录页插图',path:'/work/a',providerId:'codex',ownerChatId:'owner'})
  return {db,shares,task,tasks,tick(ms:number){clock+=ms},now:()=>clock}
}

it('创建给一次令牌;按令牌找得回这一行,列表里不带令牌',()=>{
  const f=setup()
  try{
    const {share,token}=f.shares.create(f.task.id,'  小林 ')
    expect(token).toMatch(/^s[a-f0-9]{64}$/)
    expect(share).toMatchObject({matterId:f.task.id,name:'小林',expiresAt:f.now()+SHARE_TTL_MS,revokedAt:null,lastOpenedAt:null})
    expect(JSON.stringify(f.shares.list(f.task.id))).not.toContain(token)
    expect(f.shares.active()).toEqual([token])
    expect(f.shares.byToken(token.toUpperCase())).toBeNull()
    expect(f.shares.byToken(token)).toEqual(share)
    expect(f.shares.byToken('s'+'0'.repeat(64))).toBeNull()
  }finally{f.db.close()}
})

it('每人一个链接、各自署名;撤销只撤那一个,而且只能在自己那件事上撤',()=>{
  const f=setup()
  try{
    const lin=f.shares.create(f.task.id,'小林'),wei=f.shares.create(f.task.id,'阿伟')
    const other=f.tasks.create({title:'别的事',path:'/work/b',providerId:'codex',ownerChatId:'owner'})
    expect(f.shares.revoke(other.id,lin.share.id)).toBe(false)
    expect(f.shares.revoke(f.task.id,lin.share.id)).toBe(true)
    expect(f.shares.revoke(f.task.id,lin.share.id)).toBe(false)
    expect(f.shares.byToken(lin.token)?.revokedAt).toBe(f.now())
    expect(f.shares.byToken(wei.token)?.revokedAt).toBeNull()
    expect(f.shares.list(f.task.id).map(s=>s.name)).toEqual(['小林','阿伟'])
    expect(f.shares.revokeAll(f.task.id)).toBe(1)
  }finally{f.db.close()}
})

it('名字不合格不建;没撤销没过期的链接有上限,撤掉或过期后能再开',()=>{
  const f=setup()
  try{
    expect(()=>f.shares.create(f.task.id,'partner:冒充')).toThrow('invalid_share_name')
    const made=Array.from({length:SHARES_PER_MATTER_MAX},(_,i)=>f.shares.create(f.task.id,`合伙人${i}`))
    expect(()=>f.shares.create(f.task.id,'再来一个')).toThrow('too_many_shares')
    f.shares.revoke(f.task.id,made[0]!.share.id)
    expect(f.shares.create(f.task.id,'再来一个').share.name).toBe('再来一个')
    f.tick(SHARE_TTL_MS+1)
    expect(f.shares.create(f.task.id,'过期之后').share.name).toBe('过期之后')
  }finally{f.db.close()}
})

it('记打开时间,一分钟内不重复写',()=>{
  const f=setup()
  try{
    const {share}=f.shares.create(f.task.id,'小林'),first=f.now()
    f.shares.opened(share.id);f.tick(30_000);f.shares.opened(share.id)
    expect(f.shares.list(f.task.id)[0]!.lastOpenedAt).toBe(first)
    f.tick(31_000);f.shares.opened(share.id)
    expect(f.shares.list(f.task.id)[0]!.lastOpenedAt).toBe(first+61_000)
  }finally{f.db.close()}
})

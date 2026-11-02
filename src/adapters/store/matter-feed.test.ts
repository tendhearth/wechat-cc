import {afterEach,beforeEach,describe,expect,it} from 'vitest'
import {openDb,type Db} from '../../lib/db'
import {makeMatterStore} from './matters-store'
import {makeMatterLog} from './matter-log'
import {matterFeed,type MatterFeed} from './matter-feed'
import type {MatterLog} from '../../ports/matters'

/**
 * matter-feed —— 一件事「变了」的唯一信号(P1a)。钉住:只在真落了库以后发;回滚的不发;同一段同步代码里的多笔合成一次;
 * 同一个 Db 上的 MatterLog 共用一份;wait 的三种结局(已超过 / 等到 / 超时)。
 */
let db:Db,log:MatterLog,feed:MatterFeed
beforeEach(()=>{
  db=openDb({path:':memory:'})
  const store=makeMatterStore(db)
  store.create({id:'0000000a',kind:'task',title:'a'});store.create({id:'0000000b',kind:'chat',title:'b'})
  log=makeMatterLog(db);feed=matterFeed(db)
})
afterEach(()=>db.close())
const tick=()=>Promise.resolve()

describe('matter-feed',()=>{
  it('每次写都推进这件事的游标;touch 不写行也推进;别的事不动',()=>{
    expect(feed.cursor('0000000a')).toBe(0)
    log.writeItem({matterId:'0000000a',kind:'system',status:'completed',payload:{}})
    const after=feed.cursor('0000000a')
    expect(after).toBeGreaterThan(0)
    expect(log.touch('0000000a')).toBe(after+1)
    expect(feed.cursor('0000000a')).toBe(after+1)
    expect(log.items('0000000a')).toHaveLength(1)
    expect(feed.cursor('0000000b')).toBe(0)
    expect(()=>log.touch('nope')).toThrow('matter_not_found')
  })
  it('提交以后才回调,同一段同步代码里的几笔合成一次、给最后的游标;回滚的不回调',async()=>{
    const heard:Array<[string,number]>=[]
    const off=feed.onChange((id,c)=>heard.push([id,c]))
    log.touch('0000000a');log.touch('0000000a');log.touch('0000000b')
    expect(heard).toEqual([])
    await tick()
    expect(heard).toEqual([['0000000a',feed.cursor('0000000a')],['0000000b',feed.cursor('0000000b')]])
    heard.length=0
    expect(()=>db.transaction(()=>{log.touch('0000000a');throw new Error('boom')})()).toThrow('boom')
    await tick()
    expect(heard).toEqual([])
    off()
    log.touch('0000000a');await tick()
    expect(heard).toEqual([])
  })
  it('先提交一笔、紧接着回滚一笔(同一段同步代码):提交的那笔照样通知、叫醒等的人(Codex 评审 P2)',async()=>{
    const heard:Array<[string,number]>=[]
    feed.onChange((id,c)=>heard.push([id,c]))
    const before=feed.cursor('0000000a')
    const waiting=feed.wait('0000000a',before,5000)
    const committed=log.touch('0000000a')
    expect(()=>db.transaction(()=>{log.touch('0000000a');throw new Error('boom')})()).toThrow('boom')
    await tick()
    expect(heard).toEqual([['0000000a',committed]])
    await expect(waiting).resolves.toBe(committed)
  })
  it('同一个 Db 上另开的 MatterLog 写,也从同一份 feed 发',async()=>{
    expect(matterFeed(db)).toBe(feed)
    const heard:string[]=[]
    feed.onChange(id=>heard.push(id))
    makeMatterLog(db).touch('0000000b');await tick()
    expect(heard).toEqual(['0000000b'])
  })
  it('wait:已经超过 since ⇒ 马上返回;没有 ⇒ 等到下一次提交;再没有 ⇒ 超时返回当时的值;wakeAll 全叫醒',async()=>{
    const c=log.touch('0000000a')
    await expect(feed.wait('0000000a',c-1,5000)).resolves.toBe(c)
    const waiting=feed.wait('0000000a',c,5000)
    log.touch('0000000a')
    await expect(waiting).resolves.toBe(c+1)
    const started=Date.now()
    await expect(feed.wait('0000000a',c+1,30)).resolves.toBe(c+1)
    expect(Date.now()-started).toBeGreaterThanOrEqual(25)
    const parked=feed.wait('0000000b',0,30_000)
    feed.wakeAll()
    await expect(parked).resolves.toBe(0)
  })
  it('回调抛错不影响别的回调和 wait',async()=>{
    const heard:string[]=[]
    feed.onChange(()=>{throw new Error('bad listener')})
    feed.onChange(id=>heard.push(id))
    const waiting=feed.wait('0000000a',0,5000)
    log.touch('0000000a')
    await expect(waiting).resolves.toBeGreaterThan(0)
    expect(heard).toEqual(['0000000a'])
  })
})

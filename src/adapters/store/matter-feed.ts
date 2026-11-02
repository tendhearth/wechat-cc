import type {Db} from '../../lib/db'

/**
 * matter-feed.ts —— 一件事「变了」的唯一信号(P1a,设计稿 2026-11-02-p1-change-feed-design.md)。
 * 来源只有 MatterLog:它每写一轮 / 一步 / touch 一次就把(这件事, 新游标)交到这里;这里等调用方的同步代码跑完(一个微任务)
 * 再看库里这件事的 cursor 真的到了没有 —— 到了才叫醒等的人、才回调;外层事务回滚了的就没到,丢掉。所以「幻影前进」不会发生,
 * 也不用像旧的 TaskChangeHub 那样回落纠偏。同一个 Db 上的所有 MatterLog 共用一份(按 Db 对象记)。
 * 不是事件总线:没有补发;读的人醒来以后自己重读。
 */
export interface MatterFeed {
  /** 这件事现在库里的 cursor(没有这件事 ⇒ 0)。 */
  cursor(matterId:string):number
  /** cursor 超过 since 就返回(马上或等到);到 maxMs 还没有 ⇒ 返回当时的 cursor。同一件事最多挂 8 个,再多的直接返回。 */
  wait(matterId:string,since:number,maxMs:number):Promise<number>
  /** 每次真的前进回调一次(一个回调抛错不影响别的)。返回退订。 */
  onChange(cb:(matterId:string,cursor:number)=>void):()=>void
  /** MatterLog 用:这件事写到了这个游标(可能还在外层事务里)。 */
  noted(matterId:string,cursor:number):void
  /** 叫醒所有等着的(daemon 关机;回调由订的人自己退)。 */
  wakeAll():void
}

const feeds=new WeakMap<Db,MatterFeed>()
export function matterFeed(db:Db):MatterFeed {
  let feed=feeds.get(db)
  if(!feed){feed=makeFeed(db);feeds.set(db,feed)}
  return feed
}

type Waiter={since:number;finish:()=>void}
function makeFeed(db:Db,maxWaiters=8):MatterFeed {
  const persisted=(id:string)=>db.query<{cursor:number},[string]>('SELECT cursor FROM matters WHERE id=?').get(id)?.cursor??0
  const waiters=new Map<string,Set<Waiter>>()
  const listeners=new Set<(id:string,cursor:number)=>void>()
  const announced=new Map<string,number>()
  const pending=new Map<string,number>()
  let scheduled=false
  const flush=()=>{
    scheduled=false
    const batch=[...pending];pending.clear()
    for(const [id,wanted] of batch){
      let now:number
      try{now=persisted(id)}catch{continue}
      // 没落库(外层事务回滚)⇒ 不发;已经发过这个数 ⇒ 不重复发。
      if(now<wanted||now<=(announced.get(id)??0))continue
      announced.set(id,now)
      const list=waiters.get(id)
      if(list)for(const w of [...list])if(now>w.since)w.finish()
      for(const cb of [...listeners]){try{cb(id,now)}catch{/* 一个回调炸了不影响别的 */}}
    }
  }
  return {
    cursor:id=>persisted(id),
    noted(id,cursor){
      pending.set(id,Math.max(pending.get(id)??0,cursor))
      if(!scheduled){scheduled=true;queueMicrotask(flush)}
    },
    wait(id,since,maxMs){
      const current=persisted(id)
      if(current>since)return Promise.resolve(current)
      const list=waiters.get(id)??new Set<Waiter>()
      if(list.size>=maxWaiters)return Promise.resolve(current)
      return new Promise(resolve=>{
        let done=false
        const waiter:Waiter={since,finish:()=>{
          if(done)return
          done=true;clearTimeout(timer);list.delete(waiter);if(!list.size)waiters.delete(id)
          let c=current;try{c=persisted(id)}catch{/* 库关了:给原值 */}
          resolve(c)
        }}
        const timer=setTimeout(waiter.finish,maxMs)
        ;(timer as {unref?:()=>void}).unref?.()
        list.add(waiter);waiters.set(id,list)
      })
    },
    onChange(cb){listeners.add(cb);return()=>{listeners.delete(cb)}},
    wakeAll(){for(const list of [...waiters.values()])for(const w of [...list])w.finish()},
  }
}

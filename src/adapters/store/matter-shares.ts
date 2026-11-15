import {randomBytes} from 'node:crypto'
import type {Db} from '../../lib/db'
import {SHARE_TTL_MS,shareName,type ShareMode} from '../../domain/matters/share-scope'

/**
 * 主人分享列表里的一行。令牌不在这一行里:只在创建那一刻给一次,此后只有隧道握手(active)和按令牌查(byToken)用得到。
 * 库里存的是令牌本身,不是哈希:中继握手用它派生信道密钥,两边得拿同一个值(设备令牌同理)。
 */
export interface MatterShare {id:string;matterId:string;name:string;mode:ShareMode;createdAt:number;expiresAt:number;revokedAt:number|null;lastOpenedAt:number|null}
const COLUMNS='id,matter_id AS matterId,name,mode,created_at AS createdAt,expires_at AS expiresAt,revoked_at AS revokedAt,last_opened_at AS lastOpenedAt'
export const SHARE_TOKEN=/^s[a-f0-9]{64}$/
/** 同一件事最多同时开这么多个没撤销的链接:够三四位合伙人用,也拦住循环误调。 */
export const SHARES_PER_MATTER_MAX=12
/** 所有事加起来的有效链接上限:隧道握手要拿每一枚去试,候选不能无限长。 */
export const SHARES_ACTIVE_MAX=64

export interface TalkRow {id:number;matterId:string;shareId:string|null;who:'owner'|'guest'|'cc';name:string;text:string;createdAt:number}
/** 一页给多少条对话。 */
export const TALK_PAGE=100

export function makeMatterShares(db:Db,now=()=>Date.now()){
  const list=(matterId:string):MatterShare[]=>db.query<MatterShare,[string]>(`SELECT ${COLUMNS} FROM matter_shares WHERE matter_id=? ORDER BY created_at,rowid`).all(matterId)
  return {
    list,
    /** 名字不合格 ⇒ invalid_share_name;开得太多 ⇒ too_many_shares。事存不存在、能不能分享由调用方先判(domain 的 shareRefusal)。 */
    create(matterId:string,rawName:unknown,at=now(),mode:ShareMode='discuss'):{share:MatterShare;token:string}{
      const name=shareName(rawName)
      if(!name)throw Error('invalid_share_name')
      if(list(matterId).filter(s=>s.revokedAt===null&&s.expiresAt>at).length>=SHARES_PER_MATTER_MAX||db.query<{n:number},[number]>('SELECT COUNT(*) AS n FROM matter_shares WHERE revoked_at IS NULL AND expires_at>?').get(at)!.n>=SHARES_ACTIVE_MAX)throw Error('too_many_shares')
      // 首字母 s:和手机令牌(d 设备 / t 链接)一样,页面按它认种类。
      const token='s'+randomBytes(32).toString('hex'),id=randomBytes(6).toString('hex')
      db.query('INSERT INTO matter_shares(id,matter_id,name,mode,token,created_at,expires_at) VALUES(?,?,?,?,?,?,?)').run(id,matterId,name,mode,token,at,at+SHARE_TTL_MS)
      return {share:{id,matterId,name,mode,createdAt:at,expiresAt:at+SHARE_TTL_MS,revokedAt:null,lastOpenedAt:null},token}
    },
    byToken(token:string):MatterShare|null{
      return SHARE_TOKEN.test(token)?db.query<MatterShare,[string]>(`SELECT ${COLUMNS} FROM matter_shares WHERE token=?`).get(token)??null:null
    },
    /** 没撤销、没过期的链接的令牌:隧道握手拿它们当候选。这件事归档没有由调用方再判。 */
    active(at=now()):string[]{return db.query<{token:string},[number]>('SELECT token FROM matter_shares WHERE revoked_at IS NULL AND expires_at>?').all(at).map(r=>r.token)},
    /** 记一次打开。一分钟内不重复写,合伙人开着页面轮询时不至于每次都落盘。 */
    opened(id:string,at=now()):void{db.query('UPDATE matter_shares SET last_opened_at=? WHERE id=? AND (last_opened_at IS NULL OR last_opened_at<?)').run(at,id,at-60_000)},
    revoke(matterId:string,id:string):boolean{return db.query('UPDATE matter_shares SET revoked_at=? WHERE id=? AND matter_id=? AND revoked_at IS NULL').run(now(),id,matterId).changes>0},
    /** 换一档(只看 / 能讨论 / 能直接让 CC 改);撤销了的不改。 */
    setMode(matterId:string,id:string,mode:ShareMode):boolean{return db.query('UPDATE matter_shares SET mode=? WHERE id=? AND matter_id=? AND revoked_at IS NULL').run(mode,id,matterId).changes>0},
    /** 这件事里大家一起聊的那段对话。who:owner 主人 / guest 被分享的人 / cc。 */
    talkAdd(matterId:string,entry:{who:'owner'|'guest'|'cc';name:string;shareId:string|null;text:string},at=now()):TalkRow{
      const id=Number(db.query('INSERT INTO matter_talk(matter_id,share_id,who,name,text,created_at) VALUES(?,?,?,?,?,?)').run(matterId,entry.shareId,entry.who,entry.name,entry.text,at).lastInsertRowid)
      return {id,matterId,shareId:entry.shareId,who:entry.who,name:entry.name,text:entry.text,createdAt:at}
    },
    /** 最近的若干条,按时间正序。 */
    talkRecent(matterId:string,limit=TALK_PAGE):TalkRow[]{return db.query<TalkRow,[string,number]>('SELECT id,matter_id AS matterId,share_id AS shareId,who,name,text,created_at AS createdAt FROM matter_talk WHERE matter_id=? ORDER BY id DESC LIMIT ?').all(matterId,limit).reverse()},
    talkTotal(matterId:string):number{return db.query<{n:number},[string]>('SELECT COUNT(*) AS n FROM matter_talk WHERE matter_id=?').get(matterId)!.n},
    /** 这个链接从某一刻起说了几句(限速用)。 */
    talkCountSince(shareId:string,since:number):number{return db.query<{n:number},[string,number]>("SELECT COUNT(*) AS n FROM matter_talk WHERE share_id=? AND who='guest' AND created_at>=?").get(shareId,since)!.n},
    talkGuestCountSince(matterId:string,since:number):number{return db.query<{n:number},[string,number]>("SELECT COUNT(*) AS n FROM matter_talk WHERE matter_id=? AND who='guest' AND created_at>=?").get(matterId,since)!.n},
    revokeAll(matterId:string):number{return db.query('UPDATE matter_shares SET revoked_at=? WHERE matter_id=? AND revoked_at IS NULL').run(now(),matterId).changes},
  }
}
export type MatterShares=ReturnType<typeof makeMatterShares>

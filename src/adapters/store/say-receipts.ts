import {createHash} from 'node:crypto'
import type {Db} from '../../lib/db'

/**
 * matters/say-receipts.ts — 对主人微信聊天那件事「说一句」的 requestId 回执(迁移 v70)。
 *
 * 工作台任务的说一句早就按 requestId 去重(workbench_live_inputs:持久、同 id 异文 ⇒ input_conflict);
 * 聊天那件事走 companionConverse,原先不看 requestId,手机「不确定」后重发会让 CC 说两遍。
 * 这里是同一姿势的回执:收下前先登记(pending),回复到了记下回复(replied);
 * 同 id 同文的重发拿原来的结果,同 id 异文(或换了件事)⇒ input_conflict。
 * 只存正文的 sha256,不存正文(正文已在消息流里,不另存一份)。
 *
 * 失败(converse 抛错)⇒ 删掉回执:失败的那句没说出去,重发 = 重试(与 phone-chat 一致,不自动重发)。
 * 界限:按收下时刻 30 天过期,每次登记时顺手清;工作台回执不清,这里存的回复可能长,所以给个期限。
 */
export const SAY_RECEIPT_TTL_MS=30*24*3_600_000
export type SayReceiptStatus='pending'|'replied'
export interface SayReceipt {requestId:string;matterId:string;textHash:string;status:SayReceiptStatus;reply:string|null;createdAt:number}
export interface SayReceipts {
  get(requestId:string):SayReceipt|null
  /** 登记一句新话;已有同 id 的回执 ⇒ 返回它、不改(调用方判冲突)。 */
  reserve(input:{requestId:string;matterId:string;textHash:string}):{fresh:boolean;receipt:SayReceipt}
  settle(requestId:string,reply:string):void
  drop(requestId:string):void
}
export const sayTextHash=(text:string)=>createHash('sha256').update(text,'utf8').digest('hex')

type Row={requestId:string;matterId:string;textHash:string;status:SayReceiptStatus;reply:string|null;createdAt:number}
const SELECT='SELECT request_id AS requestId,matter_id AS matterId,text_hash AS textHash,status,reply,created_at AS createdAt FROM matter_say_receipts'

export function makeSayReceipts(db:Db,now:()=>number=()=>Date.now()):SayReceipts {
  const get=(requestId:string):SayReceipt|null=>db.query<Row,[string]>(SELECT+' WHERE request_id=?').get(requestId)??null
  return {
    get,
    reserve(input){
      return db.transaction(()=>{
        const prior=get(input.requestId)
        if(prior)return {fresh:false,receipt:prior}
        const ts=now()
        db.query('DELETE FROM matter_say_receipts WHERE created_at<?').run(ts-SAY_RECEIPT_TTL_MS)
        db.query("INSERT INTO matter_say_receipts(request_id,matter_id,text_hash,status,reply,created_at) VALUES(?,?,?,'pending',NULL,?)").run(input.requestId,input.matterId,input.textHash,ts)
        return {fresh:true,receipt:get(input.requestId)!}
      }).immediate()
    },
    settle:(requestId,reply)=>{db.query("UPDATE matter_say_receipts SET status='replied',reply=? WHERE request_id=?").run(reply,requestId)},
    drop:requestId=>{db.query('DELETE FROM matter_say_receipts WHERE request_id=?').run(requestId)},
  }
}

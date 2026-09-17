import type {Middleware} from './types'
import {isWechatTaskCommand,type WechatMessageIdentity,type WechatWorkbenchReply} from '../../core/workbench/wechat-control'
import {routedAway} from './intent'

export interface WorkbenchMwDeps {
  handleWechat(chatId:string,text:string,identity?:WechatMessageIdentity):Promise<WechatWorkbenchReply|null>
  sendMessage(chatId:string,text:string):Promise<unknown>
}
export function makeMwWorkbench(deps:WorkbenchMwDeps):Middleware{
  return async(ctx,next)=>{
    if(routedAway(ctx,'task-command')||!isWechatTaskCommand(ctx.msg.text)){await next();return}
    const reply=await deps.handleWechat(ctx.msg.chatId,ctx.msg.text,ctx.msg)
    ctx.consumedBy='workbench'
    if(reply!==null&&typeof reply==='object')return
    const sent=await deps.sendMessage(ctx.msg.chatId,reply??'任务控制仅对已绑定的主人开放。')
    // ilink returns an error result instead of rejecting. Leave this delivery
    // unhandled so redelivery can retrieve the existing task input or control receipt.
    if(sent&&typeof sent==='object'&&'error' in sent&&sent.error)throw Error('workbench_reply_failed')
  }
}

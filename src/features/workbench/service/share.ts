/**
 * share 域:把一件事开给合伙人看(设计稿 docs/superpowers/specs/2026-11-14-share-a-matter-design.md,第 1 步只读)。
 *
 * 主人这边:开一个链接、看开过哪些、撤掉。合伙人那边:只有 shareView 一个出口,凭令牌进来,
 * 这件事是哪一件从分享记录里取,不听请求里说的;能不能看每次请求都重判(撤销、过期、归档立即生效)。
 * 给出去的内容只经 domain/matters/share-scope.ts 的投影。
 */
import {publicTask} from '../../../adapters/store/workbench/store'
import type {MatterShare} from '../../../adapters/store/matter-shares'
import {PARTNER_AUTHOR_PREFIX,SHARE_MODES,SHARE_SAY_PER_DAY,shareRefusal,shareSayText,sharedMatterView,type ShareMode,type ShareRefusal,type ShareView} from '../../../domain/matters/share-scope'
import {GIT_REVIEW_MIME} from '../git-review'
import type {ServiceCtx} from './ctx'
import type {ViewDomain} from './view'

export function makeShareDomain(ctx:ServiceCtx,d:{view:ViewDomain}){
  const {store,state}=ctx
  /** 主人自己交办的事才能分享;别人的、不存在的都当「没有这件」。 */
  function owned(id:string){
    const owner=ctx.deps.ownerChatId()
    let task:ReturnType<typeof store.get>
    try{task=store.get(id)}catch{throw Error('matter_not_found')}
    if(!owner||task.ownerChatId!==owner)throw Error('matter_not_found')
    return task
  }
  const record=(task:{archivedAt:number|null}|null)=>task?{kind:'task',archivedAt:task.archivedAt}:null
  function refusalOf(share:MatterShare):ShareRefusal|null{
    let task:{archivedAt:number|null}|null=null
    try{task=owned(share.matterId)}catch{/* 这件事没了或不再是主人的 ⇒ not_shareable */}
    return shareRefusal(share,record(task),ctx.now())
  }
  return {
    shareCreate(id:string,name:unknown,mode:unknown='discuss'):{share:MatterShare;token:string}{
      const task=owned(id)
      if(task.archivedAt!==null)throw Error('matter_archived')
      if(!SHARE_MODES.includes(mode as ShareMode))throw Error('invalid_share_mode')
      return store.shares.create(id,name,ctx.now(),mode as ShareMode)
    },
    /** 主人给某个链接换一档(只看 / 能讨论 / 能直接让 CC 改)。 */
    shareSetMode(id:string,shareId:string,mode:unknown):boolean{
      owned(id)
      if(!SHARE_MODES.includes(mode as ShareMode))throw Error('invalid_share_mode')
      return store.shares.setMode(id,shareId,mode as ShareMode)
    },
    /**
     * 被分享的人在这件事里说一句。只进对话,不进执行者的上下文:要不要照着做是后面的事(CC 汇总问主人,或主人给了「直接改」那一档)。
     * 「只看」的链接不能说;每个链接每天有上限(对方的话会让 CC 回应,花的是主人的额度)。
     */
    shareSay(token:string,raw:unknown):{ok:true}|{ok:false;reason:'closed'|'view_only'|'invalid'|'limit'}{
      const share=store.shares.byToken(token)
      if(!share||refusalOf(share))return {ok:false,reason:'closed'}
      if(share.mode==='view')return {ok:false,reason:'view_only'}
      const text=shareSayText(raw)
      if(!text)return {ok:false,reason:'invalid'}
      const at=ctx.now()
      if(store.shares.talkCountSince(share.id,at-24*60*60*1000)>=SHARE_SAY_PER_DAY)return {ok:false,reason:'limit'}
      store.shares.talkAdd(share.matterId,{who:'guest',name:share.name,shareId:share.id,text},at)
      try{ctx.deps.onShareTalk?.({matterId:share.matterId,shareId:share.id,name:share.name,mode:share.mode,text})}catch(error){ctx.log?.('SHARE',`onShareTalk failed: ${error instanceof Error?error.message:'error'}`)}
      return {ok:true}
    },
    /** 主人(或 CC 替主人、CC 自己)在这件事的对话里说一句。 */
    shareTalkAdd(id:string,who:'owner'|'cc',name:string,text:string){owned(id);return store.shares.talkAdd(id,{who,name,shareId:null,text},ctx.now())},
    /** 主人这边读这段对话(原文,不过投影:主人本来就都看得到)。 */
    shareTalk(id:string){owned(id);return {talk:store.shares.talkRecent(id),total:store.shares.talkTotal(id)}},
    shareList(id:string):MatterShare[]{owned(id);return store.shares.list(id)},
    shareRevoke(id:string,shareId:string):boolean{owned(id);return store.shares.revoke(id,shareId)},
    /** 隧道握手的候选:没撤销、没过期的链接。归档等情况在握手之后由 shareTokenValid / shareView 判。 */
    shareTokens:():string[]=>store.shares.active(ctx.now()),
    shareTokenValid(token:string):boolean{const share=store.shares.byToken(token);return !!share&&refusalOf(share)===null},
    shareView(token:string):ShareView{
      const share=store.shares.byToken(token)
      if(!share)return {ok:false,reason:'unknown'}
      const refusal=refusalOf(share)
      if(refusal)return {ok:false,reason:refusal}
      const id=share.matterId,task=publicTask(store.get(id)),running=state.runsByTask.get(id)
      const ledger=store.ledger.enabled(id)?{agentRuns:store.ledger.projectedAgents(id),...store.ledger.recent(id)}:null
      const plan=store.plans.get(id)
      // 被分享的人看正式名字(Codex、Claude),不看内部 id;查不到名字就用 id。
      const named=(executor:string)=>{try{return ctx.deps.registry.namesOf(executor).name||executor}catch{return executor}}
      store.shares.opened(share.id,ctx.now())
      return {ok:true,name:share.name,mode:share.mode,expiresAt:share.expiresAt,matter:sharedMatterView({
        talk:store.shares.talkRecent(id),talkTotal:store.shares.talkTotal(id),viewer:share.id,
        matter:{title:task.title,projectPath:task.path},
        task:{status:task.status,phase:d.view.phaseOf(task,running),providerId:named(task.providerId)},
        agentRuns:(ledger?.agentRuns??[]).map(run=>({...run,executor:named(run.executor)})),notes:(ledger?.notes??[]).map(note=>({...note,author:note.author.startsWith(PARTNER_AUTHOR_PREFIX)?note.author:named(note.author)})),notesTotal:ledger?.notesTotal??0,
        // 批准卡、提问、接力停下等主人一句话:内容都不给,只说在等主人。
        ownerPending:!!running&&(running.permissions.pending().length>0||running.questions.pending().length>0)||plan?.state==='approved'&&plan.legs.some(leg=>leg.state==='stopped'),
        artifacts:store.artifacts(id).filter(a=>a.mime!==GIT_REVIEW_MIME).map(a=>({name:a.name,size:a.size})),
      })}
    },
  }
}
export type ShareDomain=ReturnType<typeof makeShareDomain>

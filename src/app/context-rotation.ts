import { DEFAULT_ROTATION_WINDOW, DEFAULT_ROTATION_FILL } from '../domain/context-budget'
import type { ProviderId } from '../domain/conversation'
import type { HandoffTurn } from '../domain/provider-handoff'
import { continuationBlock, tokensFromBytes, worthAccounting } from '../domain/context-continuation'

export interface ContextInput { id: string; at: number; text?: string; userId?: string }
export interface ContextKey { providerId: ProviderId; alias: string; chatId: string }
export interface ContextBudget { windowTokens: number; reliableFillRatio: number; source?: 'measured'|'default'; windowSource?: 'measured'|'persisted'|'assumed'; ratioSource?: 'measured'|'default'; budgetError?: string|null }
export interface ContextObservation { unknown?:boolean; bytes?: number; tokens?: number; firstInputTokens?: number|null; model?: string; turns?: number }
interface Segment {
  key: ContextKey; model: string; requestedModel?:string; bytes: number; tokens: number; source: 'unknown'|'bytes'|'provider'; turns: number
  baselineUnknown?: boolean; fixedOverheadTokens?: number; budgetError?: string|null; windowError?:string|null; lastDeferredTurn?:number; throughTs: string|null; lastRotatedAt: string|null; reason: 'budget'|'nightly'|'overflow'|null
  continuation: boolean; nightlyDone: number; sinceBudget?: number
  deferredRotations?: number; consecutiveDeferrals?: number; deferredSince?: number; lastDeferredReason?: string|null; alerted?: boolean; catchupThrough?: string
}
interface ChatState { nightly: number; day: string; attempts: number; lastAttempt: number; companion: string[] }
export interface ContextState { sessions: Record<string, Segment>; chats: Record<string, ChatState> }
export interface RotationSessions { isInFlight(key:ContextKey):boolean; rotate(key:ContextKey):Promise<boolean> }
export interface ContextRotationDeps {
  owner():string|null; load():ContextState; save(state:ContextState):void; now?():number
  budgetFor(provider:ProviderId,model:string,key?:ContextKey):ContextBudget
  active?(key:ContextKey):boolean
  recordOverflow?(key:ContextKey,model:string,inputTokens:number):void
  pending(chatId:string):boolean
  proactive?(chatId:string,current?:ContextInput):Promise<string[]>
  recent(chatId:string,current?:ContextInput):Promise<HandoffTurn[]>; ongoing(chatId:string):Promise<string[]>
  latestTs(chatId:string,current?:ContextInput):Promise<string|null>; accounted(chatId:string,throughTs:string):Promise<boolean>
  extract(chatId:string,mode:'recent'|'catchup',throughTs?:string):Promise<boolean>
  defer(job:()=>Promise<void>):void
  seed?(chatId:string,current?:ContextInput):Promise<{bytes:number;turns:number;throughTs:string|null}>
  minBudgetTurns?:number; maxDeferrals?:number
  alert?(provider:ProviderId,reason:string):void
  log(tag:string,line:string):void
}
const idOf=(k:ContextKey)=>JSON.stringify([k.providerId,k.alias,k.chatId])

/** Owner continuity takes precedence over freeing context: uncertain observations never force rotation. */
export class ContextRotation {
  private readonly state:ContextState
  private readonly now:()=>number
  private readonly deliveries=new Map<string,{key:ContextKey;throughTs:string|null}>()
  constructor(private readonly d:ContextRotationDeps){this.state=d.load();this.now=d.now??Date.now}
  private owner(k:ContextKey){return k.chatId===this.d.owner()}
  isOwnerChat(chatId:string){return chatId===this.d.owner()}
  private persist(){try{this.d.save(this.state);return true}catch{this.d.log('CONTEXT_STATE','write_failed');return false}}
  private chat(chatId:string):ChatState{return this.state.chats[chatId]??={nightly:0,day:'',attempts:0,lastAttempt:0,companion:[]}}
  private segment(k:ContextKey,model='default'):Segment{return this.state.sessions[idOf(k)]??={key:{...k},model,requestedModel:model,bytes:0,tokens:0,source:'unknown',turns:0,throughTs:null,lastRotatedAt:null,reason:null,continuation:false,nightlyDone:0,sinceBudget:0}}
  private budgetInfo(s:Segment){
    let b:ContextBudget={windowTokens:DEFAULT_ROTATION_WINDOW,reliableFillRatio:DEFAULT_ROTATION_FILL,windowSource:'assumed',ratioSource:'default'}
    try{b=this.d.budgetFor(s.key.providerId,s.model,s.key);s.budgetError=b.budgetError??s.windowError??null}catch{s.budgetError='budget_unavailable';this.d.log('CONTEXT_BUDGET','budget_unavailable')}
    const windowTokens=Number.isFinite(b.windowTokens)&&b.windowTokens>0?b.windowTokens:DEFAULT_ROTATION_WINDOW
    const ratio=Number.isFinite(b.reliableFillRatio)?Math.max(.2,Math.min(.8,b.reliableFillRatio)):DEFAULT_ROTATION_FILL
    const fixed=s.fixedOverheadTokens??0,historyFloor=Math.max(24000,Math.ceil(windowTokens*.15)),hardCap=Math.floor(windowTokens*.85)
    const desired=s.fixedOverheadTokens===undefined?Math.floor(windowTokens*ratio):Math.max(Math.floor(windowTokens*ratio),fixed+historyFloor)
    return {windowTokens,windowSource:b.windowSource??(b.source==='measured'?'measured':'assumed'),reliableFillRatio:ratio,ratioSource:b.ratioSource??b.source??'default',fixedOverheadTokens:s.fixedOverheadTokens??null,historyTokens:Math.max(0,s.tokens-fixed),budgetTokens:Math.min(hardCap,desired),windowTooSmall:desired>hardCap,budgetError:s.budgetError??null}
  }
  budgetTokens(k:ContextKey){return this.budgetInfo(this.segment(k)).budgetTokens}
  private checkAlert(s:Segment){
    if(!this.owner(s.key)||this.d.active?.(s.key)===false)return
    if(!s.alerted&&s.deferredSince!==undefined&&((s.consecutiveDeferrals??0)>=(this.d.maxDeferrals??20)||this.now()-s.deferredSince>=86400000)){
      s.alerted=true;this.d.alert?.(s.key.providerId,s.lastDeferredReason??'accounting_behind');this.persist()
    }
  }
  private deferred(s:Segment,reason:string){
    if(s.lastDeferredTurn!==s.turns){s.deferredRotations=(s.deferredRotations??0)+1;s.consecutiveDeferrals=(s.consecutiveDeferrals??0)+1;s.lastDeferredTurn=s.turns}
    s.deferredSince??=this.now();s.lastDeferredReason=reason
    this.d.log('CONTEXT_ROTATE_DEFER',`provider=${s.key.providerId} reason=${reason}`)
    this.checkAlert(s)
    this.persist()
  }
  async beforeTurn(k:ContextKey,model:string,sessions:RotationSessions,current?:ContextInput,nightlyWindow=false):Promise<{block:string;carried:number}|null>{
    if(!this.owner(k)||this.d.active?.(k)===false)return null
    const s=this.segment(k,model);if(s.requestedModel!==undefined&&s.requestedModel!==model&&s.model!==model){s.model=model;s.requestedModel=model}else s.requestedModel??=model
    try{
      const delivery=this.deliveries.get(k.chatId)
      if(delivery&&idOf(delivery.key)===idOf(k)){s.throughTs=delivery.throughTs??await this.d.latestTs(k.chatId,current);this.deliveries.delete(k.chatId)}
      const chat=this.chat(k.chatId),b=this.budgetInfo(s),known=s.source!=='unknown'
      const nightly=nightlyWindow&&chat.nightly>s.nightlyDone
      if(chat.nightly>s.nightlyDone){s.nightlyDone=chat.nightly;this.persist()}
      const reason=nightly&&known&&s.turns>=(this.d.minBudgetTurns??8)&&s.tokens>=b.budgetTokens/2&&b.historyTokens>0?'nightly'
        :known&&b.historyTokens>0&&s.tokens>b.budgetTokens&&s.turns>=(this.d.minBudgetTurns??8)&&(s.sinceBudget??s.turns)>=(this.d.minBudgetTurns??8)?'budget':null
      if(!reason)return null
      if(sessions.isInFlight(k)||this.d.pending(k.chatId)){this.deferred(s,sessions.isInFlight(k)?'in_flight':'approval_pending');return null}
      const latest=await this.d.latestTs(k.chatId,current)
      if(latest&&(!s.throughTs||Date.parse(latest)>Date.parse(s.throughTs)))s.throughTs=latest
      if(s.turns>0&&!s.throughTs){this.deferred(s,'boundary_unknown');return null}
      if(s.throughTs&&!await this.d.accounted(k.chatId,s.throughTs)){
        s.catchupThrough=s.throughTs;this.deferred(s,'accounting_behind');return null
      }
      const continuation=await this.continuation(k,current)
      if(!this.owner(k)||sessions.isInFlight(k)||this.d.pending(k.chatId)||!await sessions.rotate(k))return null
      const prevTurns=s.turns
      s.bytes=0;s.tokens=0;s.turns=0;s.source='unknown';delete s.fixedOverheadTokens;delete s.baselineUnknown
      if(reason==='budget')s.sinceBudget=0
      s.continuation=true;s.nightlyDone=chat.nightly;s.consecutiveDeferrals=0;delete s.deferredSince;s.alerted=false;delete s.lastDeferredTurn;delete s.catchupThrough
      s.lastRotatedAt=new Date(this.now()).toISOString();s.reason=reason;this.persist()
      this.d.log('CONTEXT_ROTATE',`reason=${reason} provider=${k.providerId} prevTurns=${prevTurns} carried=${continuation.carried}`)
      return continuation
    }catch{this.deferred(s,'accounting_or_context_unavailable');return null}
  }
  async continuation(k:ContextKey,current?:ContextInput){return continuationBlock(await this.d.recent(k.chatId,current),await this.d.ongoing(k.chatId),12000,this.d.proactive?[]:this.chat(k.chatId).companion)}
  tracked(k:ContextKey){return this.owner(k)&&!!this.state.sessions[idOf(k)]}
  needsContinuation(k:ContextKey){return this.tracked(k)&&this.segment(k).continuation}
  async eventsBlock(k:ContextKey,current?:ContextInput){if(!this.tracked(k))return '';const lines=this.d.proactive?await this.d.proactive(k.chatId,current):this.chat(k.chatId).companion;return lines.length?continuationBlock(lines.map(text=>({dir:'out' as const,text,ts:''})),[]).block:''}
  started(k:ContextKey){if(this.tracked(k)){this.segment(k).continuation=false;this.chat(k.chatId).companion=[];this.persist()}}
  opened(k:ContextKey,model:string,_bytes:number,resumed:boolean){
    if(!this.tracked(k))return
    const s=this.segment(k);if(!resumed)s.model=model
    if(!resumed){s.bytes=0;s.tokens=0;s.source='unknown';s.turns=0;delete s.fixedOverheadTokens;delete s.baselineUnknown;s.continuation=true}
    else {s.continuation=false;if(s.fixedOverheadTokens===undefined)s.baselineUnknown=true}
    this.persist()
  }
  observation(k:ContextKey){const s=this.segment(k);return {bytes:s.bytes,...(s.source==='provider'?{tokens:s.tokens}:{})}}
  persisted(chatId:string,throughTs:string){const pending=this.deliveries.get(chatId);if(!pending||!this.owner(pending.key))return;pending.throughTs=throughTs;this.segment(pending.key).throughTs=throughTs;this.persist()}
  observe(k:ContextKey,o:ContextObservation){
    if(!this.tracked(k))return
    const s=this.segment(k)
    if(o.model)s.model=o.model
    if(!s.baselineUnknown&&typeof o.firstInputTokens==='number'&&Number.isFinite(o.firstInputTokens)&&o.firstInputTokens>=0)s.fixedOverheadTokens??=o.firstInputTokens
    if(o.bytes!==undefined)s.bytes=o.bytes
    if(o.tokens!==undefined&&Number.isFinite(o.tokens)&&o.tokens>=0){s.tokens=o.tokens;s.source='provider'}
    else if(o.unknown){s.tokens=0;s.source='unknown'}
    else if(o.bytes!==undefined){s.tokens=tokensFromBytes(o.bytes);s.source=s.fixedOverheadTokens===undefined?'unknown':'bytes'}
    if(!s.baselineUnknown&&o.tokens!==undefined&&o.firstInputTokens!==null)s.fixedOverheadTokens??=o.firstInputTokens??o.tokens
    const turns=o.turns??0;s.turns+=turns;s.sinceBudget=(s.sinceBudget??0)+turns;this.budgetInfo(s);this.persist()
  }
  /** Only after delivery: catchup must never sit on the reply's critical path. */
  delivered(k:ContextKey,text:string,tools:boolean){
    if(!this.owner(k))return
    const boundary={key:{...k},throughTs:null as string|null};this.deliveries.set(k.chatId,boundary)
    this.d.defer(async()=>{
      if(!this.owner(k))return
      const s=this.segment(k)
      try{const throughTs=boundary.throughTs??await this.d.latestTs(k.chatId);if(throughTs&&(!s.throughTs||Date.parse(throughTs)>Date.parse(s.throughTs)))s.throughTs=throughTs;this.persist();if(this.deliveries.get(k.chatId)===boundary)this.deliveries.delete(k.chatId)}catch{return}
      if(s.catchupThrough){
        try{const through=s.catchupThrough;if(await this.d.extract(k.chatId,'catchup',through)&&await this.d.accounted(k.chatId,through))delete s.catchupThrough}catch{/* keep pending */}
        this.persist();return
      }
      if(!worthAccounting(text,tools))return
      const chat=this.chat(k.chatId),now=this.now(),day=new Date(now).toISOString().slice(0,10)
      if(chat.day!==day){chat.day=day;chat.attempts=0}
      if(chat.attempts>=24||(chat.lastAttempt>0&&now-chat.lastAttempt<300000))return
      chat.attempts++;chat.lastAttempt=now
      try{if(this.persist())await this.d.extract(k.chatId,'recent',s.throughTs??undefined)}catch{/* unavailable cheap model */}
    })
  }
  /** Context rejection is a capacity emergency: canonical history can be accounted after recovery. */
  async recoverOverflow(k:ContextKey,sessions:RotationSessions,current?:ContextInput,rejectedTokens?:number){
    if(!this.owner(k))return null
    const s=this.segment(k)
    try{if(rejectedTokens!==undefined){this.d.recordOverflow?.(k,s.model,rejectedTokens);s.windowError=null}else this.d.log('CONTEXT_BUDGET','overflow_input_unknown')}catch{s.windowError='window_write_failed';s.budgetError='window_write_failed';this.d.log('CONTEXT_BUDGET','window_write_failed')}
    const carry=await this.continuation(k,current)
    if(!this.owner(k)||sessions.isInFlight(k)||!await sessions.rotate(k))return null
    s.bytes=0;s.tokens=0;s.turns=0;s.source='unknown';delete s.fixedOverheadTokens;delete s.baselineUnknown
    s.sinceBudget=0;s.continuation=true;s.reason='overflow';s.lastRotatedAt=new Date(this.now()).toISOString();s.consecutiveDeferrals=0;delete s.deferredSince;s.alerted=false
    this.persist();this.d.log('CONTEXT_ROTATE',`reason=overflow provider=${k.providerId} carried=${carry.carried}`)
    return carry
  }
  private prune(){let changed=false;for(const [id,s] of Object.entries(this.state.sessions))if(!this.owner(s.key)||this.d.active?.(s.key)===false){delete this.state.sessions[id];changed=true}if(changed)this.persist()}
  async rotateIdle(chatId:string,sessions:RotationSessions){if(chatId!==this.d.owner())return;this.prune();for(const s of Object.values(this.state.sessions))if(s.key.chatId===chatId)await this.beforeTurn(s.key,s.model,sessions,undefined,true)}
  nightly(chatId:string,success:boolean){if(success&&chatId===this.d.owner()){this.chat(chatId).nightly++;this.persist()}}
  noteCompanion(chatId:string,line:string){if(chatId!==this.d.owner())return;const c=this.chat(chatId);c.companion=[...c.companion,`[${new Date(this.now()).toISOString()}] ${line}`].slice(-6);this.persist()}
  status(){this.prune();for(const s of Object.values(this.state.sessions))this.checkAlert(s);return Object.values(this.state.sessions).filter(s=>this.owner(s.key)).map(s=>({provider:s.key.providerId,model:s.model,estimatedTokens:s.tokens,...this.budgetInfo(s),historyBytes:s.bytes,source:s.source,turns:s.turns,lastRotatedAt:s.lastRotatedAt,reason:s.reason,warning:s.alerted?'context_accounting_delayed':null,deferredRotations:s.deferredRotations??0,lastDeferredReason:s.lastDeferredReason??null}))}
}

import type { ProviderId } from '../domain/conversation'
import type { HandoffTurn } from '../domain/provider-handoff'
import { continuationBlock, tokensFromBytes, worthAccounting } from '../domain/context-continuation'

export interface ContextInput { id: string; at: number; text?: string; userId?: string }
export interface ContextKey { providerId: ProviderId; alias: string; chatId: string }
export interface ContextBudget { windowTokens: number; reliableFillRatio: number }
export interface ContextObservation { bytes?: number; tokens?: number; turns?: number }
interface Segment {
  key: ContextKey; model: string; bytes: number; tokens: number; source: 'bytes' | 'provider'; turns: number
  throughTs: string | null; lastRotatedAt: string | null; reason: 'budget' | 'nightly' | null
  continuation: boolean; nightlyDone: number
}
interface ChatState { nightly: number; day: string; attempts: number; lastAttempt: number; companion: string[] }
export interface ContextState { sessions: Record<string, Segment>; chats: Record<string, ChatState> }
export interface RotationSessions {
  isInFlight(key: ContextKey): boolean
  rotate(key: ContextKey): Promise<boolean>
}
export interface ContextRotationDeps {
  owner(): string | null
  load(): ContextState
  save(state: ContextState): void
  now?(): number
  budgetFor(provider: ProviderId, model: string, key?: ContextKey): ContextBudget
  pending(chatId: string): boolean
  recent(chatId: string, current?: ContextInput): Promise<HandoffTurn[]>
  ongoing(chatId: string): Promise<string[]>
  latestTs(chatId: string, current?: ContextInput): Promise<string | null>
  accounted(chatId: string, throughTs: string): Promise<boolean>
  extract(chatId: string, mode: 'recent' | 'catchup', throughTs?: string): Promise<boolean>
  defer(job: () => Promise<void>): void
  seed?(chatId: string, current?: ContextInput): Promise<{ bytes: number; turns: number; throughTs: string | null }>
  log(tag: string, line: string): void
}
const idOf = (k: ContextKey) => JSON.stringify([k.providerId,k.alias,k.chatId])

/** Shared owner policy. Providers observe history; none of them decides when to rotate. */
export class ContextRotation {
  private readonly state: ContextState
  private readonly now: () => number
  private readonly deliveries = new Map<string, { key: ContextKey; throughTs: string | null }>()
  constructor(private readonly d: ContextRotationDeps) { this.state=d.load();this.now=d.now??Date.now }
  private owner(k:ContextKey) { return k.chatId===this.d.owner() }
  isOwnerChat(chatId: string) { return chatId === this.d.owner() }
  private persist(): boolean { try { this.d.save(this.state); return true } catch { this.d.log('CONTEXT_STATE', 'write_failed'); return false } }
  private chat(chatId:string): ChatState { if(!Object.hasOwn(this.state.chats,chatId))this.state.chats[chatId]={nightly:0,day:'',attempts:0,lastAttempt:0,companion:[]};return this.state.chats[chatId]! }
  private segment(k:ContextKey,model='default'): Segment {
    return this.state.sessions[idOf(k)]??= {key:{...k},model,bytes:0,tokens:0,source:'bytes',turns:0,throughTs:null,lastRotatedAt:null,reason:null,continuation:false,nightlyDone:0}
  }
  budgetTokens(k:ContextKey):number {return this.budget(this.segment(k))}
  private budget(s:Segment): number {
    try { const b=this.d.budgetFor(s.key.providerId,s.model,s.key);if(Number.isFinite(b.windowTokens)&&b.windowTokens>0&&Number.isFinite(b.reliableFillRatio)&&b.reliableFillRatio>=0&&b.reliableFillRatio<=1)return Math.floor(b.windowTokens*b.reliableFillRatio) } catch { /* optional checkup not ready */ }
    return 2048
  }
  async beforeTurn(k:ContextKey,model:string,sessions:RotationSessions,current?:ContextInput): Promise<{block:string;carried:number}|null> {
    if(!this.owner(k))return null
    try {
    const existed=!!this.state.sessions[idOf(k)]
    const s=this.segment(k,model);s.model=model
    if(!existed && this.d.seed) {
      const seed=await this.d.seed(k.chatId,current)
      s.bytes=seed.bytes;s.tokens=tokensFromBytes(seed.bytes);s.turns=seed.turns;s.throughTs=seed.throughTs
    }
    const delivery=this.deliveries.get(k.chatId)
    if(delivery && idOf(delivery.key)===idOf(k)) {
      s.throughTs=delivery.throughTs??await this.d.latestTs(k.chatId,current)
      this.deliveries.delete(k.chatId)
    }
    const chat=this.chat(k.chatId),budget=this.budget(s)
    const reason=chat.nightly>s.nightlyDone?'nightly':s.turns>0&&(s.tokens>budget||(k.providerId==='openai'&&tokensFromBytes(s.bytes)>budget))?'budget':null
    if(!reason)return null
    if(sessions.isInFlight(k)||this.d.pending(k.chatId))return null
      // Failed/cancelled turns also contain owner input. Refresh the preceding canonical
      // boundary by identity, never by the current input's arrival time.
      const latest = await this.d.latestTs(k.chatId,current)
      if(latest && (!s.throughTs || Date.parse(latest)>Date.parse(s.throughTs)))s.throughTs=latest
      if(s.turns>0 && !s.throughTs){this.d.log('CONTEXT_ROTATE_DEFER',`provider=${k.providerId} reason=boundary_unknown`);return null}
      // Read continuation BEFORE forgetting anything. Failed I/O leaves the old segment intact.
      const continuation=await this.continuation(k,current)
      if(s.throughTs && !await this.d.accounted(k.chatId,s.throughTs)) {
        await this.d.extract(k.chatId,'catchup',s.throughTs)
        if(!await this.d.accounted(k.chatId,s.throughTs)) {this.d.log('CONTEXT_ROTATE_DEFER',`provider=${k.providerId} reason=accounting_behind`);return null}
      }
      if(!this.owner(k)||sessions.isInFlight(k)||this.d.pending(k.chatId)||!await sessions.rotate(k))return null
      const prevTurns=s.turns
      s.bytes=0;s.tokens=0;s.turns=0;s.source='bytes';s.continuation=true;s.nightlyDone=chat.nightly
      s.lastRotatedAt=new Date(this.now()).toISOString();s.reason=reason
      this.persist()
      this.d.log('CONTEXT_ROTATE',`reason=${reason} provider=${k.providerId} prevTurns=${prevTurns} carried=${continuation.carried}`)
      return continuation
    } catch { this.d.log('CONTEXT_ROTATE_DEFER',`provider=${k.providerId} reason=accounting_or_context_unavailable`);return null }
  }
  async continuation(k:ContextKey,current?:ContextInput):Promise<{block:string;carried:number}> {
    const s=this.segment(k)
    return continuationBlock(await this.d.recent(k.chatId,current),await this.d.ongoing(k.chatId),this.budget(s),this.chat(k.chatId).companion)
  }
  tracked(k:ContextKey) { return this.owner(k)&&!!this.state.sessions[idOf(k)] }
  needsContinuation(k:ContextKey) { return this.tracked(k)&&this.segment(k).continuation }
  eventsBlock(k:ContextKey) {
    if(!this.tracked(k))return ''
    const lines=this.chat(k.chatId).companion
    return lines.length?`<context_events hint="主动动作的结果资料">\n${lines.join('\n')}\n</context_events>`:''
  }
  started(k:ContextKey) {if(this.tracked(k)){this.segment(k).continuation=false;this.chat(k.chatId).companion=[];this.persist()}}
  opened(k:ContextKey,model:string,bytes:number,resumed:boolean) {
    if(!this.owner(k)||!this.state.sessions[idOf(k)])return
    const s=this.segment(k);s.model=model
    if(!resumed){s.bytes=bytes;s.tokens=tokensFromBytes(bytes);s.source='bytes';s.turns=0;s.continuation=true}
    else if(s.bytes===0){s.bytes=bytes;s.tokens=tokensFromBytes(bytes)}
    this.persist()
  }
  observation(k:ContextKey) {
    const s=this.segment(k)
    return {bytes:s.bytes,...(s.source==='provider'?{tokens:s.tokens}:{})}
  }
  /** App persists its canonical messages after coordinator dispatch returns. */
  persisted(chatId:string,throughTs:string) {
    const pending=this.deliveries.get(chatId)
    if(!pending || !this.owner(pending.key))return
    pending.throughTs=throughTs
    this.segment(pending.key).throughTs=throughTs
    this.persist()
  }
  observe(k:ContextKey,o:ContextObservation) {
    if(!this.owner(k)||!this.state.sessions[idOf(k)])return
    const s=this.segment(k)
    if(o.bytes!==undefined)s.bytes=o.bytes
    if(o.tokens!==undefined&&Number.isFinite(o.tokens)&&o.tokens>=0){s.tokens=o.tokens;s.source='provider'}
    else{s.tokens=tokensFromBytes(s.bytes);s.source='bytes'}
    s.turns+=o.turns??0;this.persist()
  }
  /** Deferred until after App persistence; never awaited by reply delivery. */
  delivered(k:ContextKey,text:string,tools:boolean) {
    if(!this.owner(k))return
    const boundary={key:{...k},throughTs:null as string|null}
    this.deliveries.set(k.chatId,boundary)
    this.d.defer(async()=>{
      if(!this.owner(k))return
      const s=this.segment(k)
      try {
        const throughTs=boundary.throughTs??await this.d.latestTs(k.chatId)
        if(throughTs && (!s.throughTs || Date.parse(throughTs)>Date.parse(s.throughTs)))s.throughTs=throughTs
        this.persist()
        if(this.deliveries.get(k.chatId)===boundary)this.deliveries.delete(k.chatId)
      } catch {return}
      if(!worthAccounting(text,tools))return
      const chat=this.chat(k.chatId),now=this.now(),day=new Date(now).toISOString().slice(0,10)
      if(chat.day!==day){chat.day=day;chat.attempts=0}
      if(chat.attempts>=24||(chat.lastAttempt>0&&now-chat.lastAttempt<300_000))return
      chat.attempts++;chat.lastAttempt=now
      try {if(this.persist())await this.d.extract(k.chatId,'recent',s.throughTs??undefined)} catch { /* unavailable cheap model: silent, next window */ }
    })
  }
  async rotateIdle(chatId:string,sessions:RotationSessions):Promise<void> {
    if(chatId!==this.d.owner())return
    for(const s of Object.values(this.state.sessions)) {
      if(s.key.chatId===chatId)await this.beforeTurn(s.key,s.model,sessions)
    }
  }
  nightly(chatId:string,success:boolean) {
    if(!success||chatId!==this.d.owner())return
    this.chat(chatId).nightly++;this.persist()
  }
  noteCompanion(chatId:string,line:string) {
    if(chatId!==this.d.owner())return
    const c=this.chat(chatId);c.companion=[...c.companion,line.replace(/[\r\n]+/g,' ').slice(0,160)].slice(-3);this.persist()
  }
  status() {return Object.values(this.state.sessions).filter(s=>this.owner(s.key)).map(s=>({provider:s.key.providerId,model:s.model,estimatedTokens:s.tokens,budgetTokens:this.budget(s),historyBytes:s.bytes,source:s.source,turns:s.turns,lastRotatedAt:s.lastRotatedAt,reason:s.reason}))}
}

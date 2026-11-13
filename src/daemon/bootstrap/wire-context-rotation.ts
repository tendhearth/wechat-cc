import { contextHistory } from './context-history'
import { localTopicContext, topicMatterAccess } from '../../lib/topic-provenance'
import { readWorkResults } from '../threads/work-results'
/** Owner-only wiring for shared rotation. No provider policy, model call or private history enters health. */
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { CHECKUP_CARE } from '@wechat-cc/protocol'
import { ContextRotation, type ContextBudget, type ContextState, type ContextInput, type ContextKey } from '../../app/context-rotation'
import type { ProviderRegistry } from '../../app/provider-registry'
import type { ProviderId } from '../../domain/conversation'
import { readJsonFile } from '../../lib/read-json-file'
import { updateJsonFile } from '../../lib/json-file'
import { inboundFallbackMessageId, makeMessagesStore } from '../../lib/messages-store'
import { makeThreadsStore } from '../../lib/threads-store'
import type { Db } from '../../lib/db'
import { projectActivities, resolveCheapEval } from '../../features/memory'
import { ownerChatIdOf } from '../owner-chat'
import { makeEventsStore } from '../events/store'
import { runThreadsExtraction } from '../threads/extractor'

/** Policy mapping is read, but speech behavior remains disabled in this task. */
export const CONTEXT_CARE = { memory: CHECKUP_CARE.memory.policy, discretion: { policy: CHECKUP_CARE.discretion.policy, enabled: false } } as const

export function wireContextRotation(d: {
  db: Db; stateDir: string; registry: ProviderRegistry
  getMode(chatId:string): {kind:string;provider?:string} | undefined
  budgetFor?(provider:ProviderId,model:string,key?:ContextKey):ContextBudget
  pending?(chatId:string):boolean
  owner?():string|null
  defer?(job:()=>Promise<void>):void
  holdBusy?(label:string):()=>void
  log(tag:string,line:string):void
}) {
  const history=contextHistory(d.db)
  const messages=makeMessagesStore(d.db),threads=makeThreadsStore(d.db,{filterSources:true})
  const owner=d.owner??(()=>ownerChatIdOf(d.stateDir)),path=join(d.stateDir,'context-rotation.json')
  const blank=():ContextState=>({sessions:{},chats:{}})
  const loadState=():ContextState=>{
    if(!existsSync(path))return blank()
    const raw=readJsonFile<{state?:ContextState}>(path),state=raw.state
    if(!state || !state.sessions || !state.chats || Object.values(state.sessions).some(s=>!s?.key || typeof s.key.chatId!=='string' || typeof s.model!=='string' || !Number.isFinite(s.bytes) || !Number.isFinite(s.tokens) || !Number.isFinite(s.turns)) || Object.values(state.chats).some(c=>!c || !Array.isArray(c.companion) || !Number.isFinite(c.nightly) || !Number.isFinite(c.attempts) || !Number.isFinite(c.lastAttempt))) {
      d.log('CONTEXT_STATE','invalid_estimates_rebuilt');return blank()
    }
    return state
  }
  const currentId = (chatId:string,current?:ContextInput) => !current ? '' : current.at ? current.id : inboundFallbackMessageId(current.userId??chatId,current.text??'')
  const recentRows=async(chatId:string,current?:ContextInput)=>{
    // Filter before limiting: proactive bubbles must not push the preceding owner rounds out.
    const rows=d.db.query<{id:string;direction:'in'|'out';text:string;ts:string},[string,string,string]>(
      "SELECT id,direction,text,ts FROM messages WHERE chat_id=? AND id!=? AND NOT (id LIKE 'app:%' AND id LIKE ?) AND source!='workbench' AND source NOT LIKE 'speech:%' ORDER BY ts DESC,rowid DESC LIMIT 256",
    ).all(chatId,currentId(chatId,current),current?`%:${current.at}:in`:'')
    return rows.reverse()
  }
  const accounted=async(chatId:string,throughTs:string)=>{
    const watermark=(await threads.getExtractState(chatId)).entriesToTs
    return watermark!==null && Date.parse(watermark)>=Date.parse(throughTs)
  }
  return new ContextRotation({
    owner,load:()=>{try{return loadState()}catch{d.log('CONTEXT_STATE','unreadable_estimates_rebuilt');return blank()}},
    save:state=>{updateJsonFile(path,raw=>{raw.state=state})},
    budgetFor:(p,m,key)=>d.budgetFor?.(p,m,key)??{windowTokens:32000,reliableFillRatio:.6},
    pending:chatId=>d.pending?.(chatId)??false,
    recent:async(chatId,current)=>history.recent(chatId,current),
    proactive:async(chatId,current)=>history.proactive(chatId,current),
    ongoing:async chatId=>{
      const activity=await projectActivities(d.db,chatId)
      if(chatId!==owner())return []
      return [...activity.values()].flatMap(v=>v.sessions.filter(s=>s.activity==='running'||s.activity==='waiting').map(s=>`${s.title}：${s.latestStep || (s.activity==='waiting'?'等主人答复':'正在办')}`))
    },
    latestTs:async(chatId,current)=> current===undefined ? messages.latestTs(chatId) : (await recentRows(chatId,current)).at(-1)?.ts??null,
    accounted,
    extract:async(chatId,mode,throughTs)=>{
      if(chatId!==owner())return false
      const sdkEval=resolveCheapEval({getMode:d.getMode,registry:d.registry},chatId)
      if(!sdkEval)return false
      await runThreadsExtraction({chatId,messages,threads,work:after=>readWorkResults(d.db,after,localTopicContext(chatId)),workAllowed:id=>chatId===owner()&&topicMatterAccess(d.db,localTopicContext(chatId),[id]).entryAllowed.has(id),authorized:()=>chatId===owner(),sdkEval:async prompt=>{
        if(chatId!==owner())throw Error('owner_changed')
        const result=await sdkEval(prompt)
        if(chatId!==owner())throw Error('owner_changed')
        return result
      },...(throughTs?{throughTs}:{}),...(mode==='recent'?{recentLimit:12,maxRounds:1,batchChars:6000,tailLimit:0}:{}),log:d.log,
      recordEvent:async reasoning=>{await makeEventsStore(d.db,chatId).append({kind:'threads_extracted',trigger:mode==='recent'?'turn':'context-rotation',reasoning})}})
      return throughTs?accounted(chatId,throughTs):true
    },
    defer:d.defer??(job=>{
      const timer=setTimeout(()=>{const release=d.holdBusy?.('context-accounting')??(()=>{});void job().catch(()=>{}).finally(release)},0)
      timer.unref?.()
    }),
    alert:(provider,reason)=>{const chatId=owner();if(chatId)void makeEventsStore(d.db,chatId).append({kind:'cron_eval_failed',trigger:'context-accounting',reasoning:`provider=${provider} reason=${reason}`}).catch(()=>{})},
    log:d.log,
  })
}

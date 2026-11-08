import { describe, expect, it } from 'vitest'
import { openTestDb } from '../../lib/db'
import { makeMessagesStore } from '../../lib/messages-store'
import { makeMatterStore } from '../../adapters/store/matters-store'
import { makeMatterLog } from '../../adapters/store/matter-log'
import { makeOwnerConversationReader, ownerConversationWork } from './owner-conversation'
import { ConversationWindow, ConversationWork } from '../../../packages/protocol/src/owner-conversation'

describe('owner conversation durable contracts', () => {
  it('anchors beyond the latest page; pages equal timestamps both ways without gaps and scopes ids to owner', async () => {
    const db=openTestDb(), store=makeMessagesStore(db), read=makeOwnerConversationReader(db)
    for(let i=0;i<111;i++)await store.append({id:`m${String(i).padStart(3,'0')}`,chatId:'owner',ts:'2026-11-06T00:00:00Z',direction:i%2?'out':'in',kind:'text',text:`needle ${i}`,source:'desktop'})
    await store.append({id:'secret',chatId:'other',ts:'2026-11-06T00:00:00Z',direction:'in',kind:'text',text:'secret',source:'wechat'})
    const window=ConversationWindow.parse(await read('owner',{anchor:'m050',limit:4}))
    expect(window.messages.map(m=>m.messageId)).toEqual(['m048','m049','m050','m051','m052'])
    expect((await read('owner',{before:window.earlier!,limit:2}))?.messages.map(m=>m.messageId)).toEqual(['m046','m047'])
    expect((await read('owner',{after:window.later!,limit:2}))?.messages.map(m=>m.messageId)).toEqual(['m053','m054'])
    expect(await read('owner',{anchor:'secret',limit:30})).toBeNull()
    expect((await read('owner',{q:'needle 1',limit:50}))?.messages).toHaveLength(22)
    expect((await read('owner',{q:'%',limit:50}))?.messages).toEqual([])
    db.close()
  })
  it('projects stable references and completed stage results from durable MatterLog after reconstruction',async()=>{
    const db=openTestDb(), store=makeMatterStore(db), log=makeMatterLog(db)
    await makeMessagesStore(db).append({id:'origin',chatId:'owner',ts:'2026-11-06T00:00:00Z',direction:'in',kind:'text',text:'do it',source:'phone'})
    const m=store.create({kind:'task',title:'task',ownerChatId:'owner',originMessageId:'origin'})
    const turn=log.startTurn({matterId:m.id,executor:'codex'})
    log.writeItem({matterId:m.id,turnId:turn.id,kind:'agent_message',status:'completed',payload:{text:'stage done'}})
    expect(ownerConversationWork(db,'owner').results).toEqual([])
    log.finishTurn(turn.id,{status:'completed'})
    const result=ConversationWork.parse(ownerConversationWork(db,'owner'))
    expect(result.references[0]).toMatchObject({id:`work:${m.id}`,messageId:'origin',kind:'task'})
    expect(result.results).toEqual([{id:`result:${turn.id}`,matterId:m.id,turnId:turn.id,messageId:'origin',text:'stage done',createdAt:expect.any(Number)}])
    expect(ownerConversationWork(db,'owner')).toEqual(result)
    expect(ownerConversationWork(db,'other')).toMatchObject({references:[],results:[],nextCursor:null})
    db.close()
  })
})

it('streams durable text replacements with cursors, and stops only the exact owner turn',async()=>{
  const {makeChatTurnLog}=await import('../../adapters/store/chat-turns')
  const {ownerConversationEvents,stopOwnerConversation}=await import('./owner-conversation')
  const db=openTestDb(),matters=makeMatterStore(db),log=makeMatterLog(db)
  matters.ensureChat('owner');matters.ensureChat('other')
  const h=makeChatTurnLog({db,log,matters}).begin({chatId:'owner',provider:'codex',alias:'main',startedAt:1})!
  h.event({kind:'text',text:'he',itemId:'x',textMode:'append'})
  const first=ownerConversationEvents(db,'owner',0)
  expect(first.events.at(-1)?.text).toBe('he')
  h.event({kind:'text',text:'hello',itemId:'x',textMode:'replace'})
  const next=ownerConversationEvents(db,'owner',first.cursor)
  expect(next.events).toEqual([expect.objectContaining({id:first.events[0]!.id,text:'hello'})])
  const cancelled:string[]=[]
  expect(stopOwnerConversation(db,'other',first.running!.turnId,o=>{cancelled.push(o);return true})).toBe(false)
  expect(stopOwnerConversation(db,'owner','stale',()=>true)).toBe(false)
  expect(stopOwnerConversation(db,'owner',first.running!.turnId,o=>{cancelled.push(o);return true})).toBe(true)
  expect(cancelled).toEqual(['owner'])
  h.end({mode:'solo',outcome:'completed'})
  expect(stopOwnerConversation(db,'owner',first.running!.turnId,()=>true)).toBe(false)
  expect(ownerConversationEvents(db,'owner',0).running).toBeNull()
  db.close()
})

it('pages durable work across the default limit without gaps, and rejects another owner cursor',async()=>{
  const db=openTestDb(),messages=makeMessagesStore(db),matters=makeMatterStore(db),log=makeMatterLog(db)
  await messages.append({id:'origin',chatId:'owner',ts:'2026-11-06T00:00:00Z',direction:'in',kind:'text',text:'delegate',source:'phone'})
  const expected=new Set<string>()
  for(let i=0;i<37;i++){
    const matter=matters.create({kind:'task',title:`work ${i}`,ownerChatId:'owner',originMessageId:'origin'})
    const turn=log.startTurn({matterId:matter.id,executor:'codex'})
    log.writeItem({matterId:matter.id,turnId:turn.id,kind:'agent_message',status:'completed',payload:{text:`done ${i}`}})
    log.finishTurn(turn.id,{status:'completed'});expected.add(`work:${matter.id}`);expected.add(`result:${turn.id}`)
  }
  const first=ownerConversationWork(db,'owner',{limit:7})
  expect(first.nextCursor).toBeTruthy()
  expect(()=>ownerConversationWork(db,'other',{cursor:first.nextCursor!})).toThrow('invalid_cursor')
  const ids:string[]=[];let cursor:string|undefined
  do{const page=ConversationWork.parse(ownerConversationWork(db,'owner',{cursor,limit:7}));ids.push(...page.references.map(r=>r.id),...page.results.map(r=>r.id));cursor=page.nextCursor??undefined}while(cursor)
  expect(ids).toHaveLength(expected.size);expect(new Set(ids)).toEqual(expected);db.close()
})

it('bounds a single enormous result so its page fits the paired-device frame budget',async()=>{
  const {framedTooLargeFor,PHONE_FRAME_BUDGET_BYTES}=await import('../../domain/matters/phone-scope')
  const db=openTestDb(),matters=makeMatterStore(db),log=makeMatterLog(db)
  await makeMessagesStore(db).append({id:'origin',chatId:'owner',ts:'2026-11-06T00:00:00Z',direction:'in',kind:'text',text:'do it',source:'phone'})
  const matter=matters.create({kind:'task',title:'large',ownerChatId:'owner',originMessageId:'origin'}),turn=log.startTurn({matterId:matter.id,executor:'codex'})
  log.writeItem({matterId:matter.id,turnId:turn.id,kind:'agent_message',status:'completed',payload:{text:'文'.repeat(500000)}});log.finishTurn(turn.id,{status:'completed'})
  let page=ConversationWork.parse(ownerConversationWork(db,'owner',{limit:1}))
  if(!page.results.length)page=ConversationWork.parse(ownerConversationWork(db,'owner',{limit:1,cursor:page.nextCursor!}))
  expect(page.results[0]).toMatchObject({truncated:true,text:'文'.repeat(16000)})
  expect(framedTooLargeFor(JSON.stringify(page),PHONE_FRAME_BUDGET_BYTES)).toBe(false);db.close()
})

it('projects the actual workbench timeline body in its own completed turn',async()=>{
  const {makeTimelineEvents}=await import('../../adapters/store/workbench/timeline-events')
  const db=openTestDb(),matters=makeMatterStore(db),log=makeMatterLog(db),timeline=makeTimelineEvents(db,log)
  await makeMessagesStore(db).append({id:'origin',chatId:'owner',ts:'2026-11-06T00:00:00Z',direction:'in',kind:'text',text:'delegate',source:'desktop'})
  const matter=matters.create({kind:'task',title:'workbench',ownerChatId:'owner',originMessageId:'origin'})
  const first=log.startTurn({matterId:matter.id,executor:'codex',runId:'retained-run'})
  timeline.recordAgentEvent(matter.id,'retained-run',{kind:'text',text:'stage one',itemId:'one'},1)
  log.finishTurn(first.id,{status:'completed'})
  const second=log.startTurn({matterId:matter.id,executor:'codex',runId:'retained-run'})
  timeline.recordAgentEvent(matter.id,'retained-run',{kind:'text',text:'stage two',itemId:'two'},2)
  log.finishTurn(second.id,{status:'completed'})
  expect(ownerConversationWork(db,'owner').results).toEqual(expect.arrayContaining([expect.objectContaining({id:`result:${first.id}`,text:'stage one'}),expect.objectContaining({id:`result:${second.id}`,text:'stage two'})]))
  db.close()
})

it('reads legacy unbound workbench text only when its run identifies exactly one turn',async()=>{
  const db=openTestDb(),matters=makeMatterStore(db),log=makeMatterLog(db)
  await makeMessagesStore(db).append({id:'origin',chatId:'owner',ts:'2026-11-06T00:00:00Z',direction:'in',kind:'text',text:'old work',source:'desktop'})
  const matter=matters.create({kind:'task',title:'legacy',ownerChatId:'owner',originMessageId:'origin'}),turn=log.startTurn({matterId:matter.id,executor:'codex',runId:'legacy-run'})
  log.writeItem({matterId:matter.id,kind:'agent_message',status:'completed',payload:{text:'legacy answer',runId:'legacy-run'}});log.finishTurn(turn.id,{status:'completed'})
  expect(ownerConversationWork(db,'owner').results).toEqual([expect.objectContaining({id:`result:${turn.id}`,text:'legacy answer'})])
  const ambiguous=log.startTurn({matterId:matter.id,executor:'codex',runId:'legacy-run'});log.finishTurn(ambiguous.id,{status:'completed'})
  expect(ownerConversationWork(db,'owner').results).toEqual([]);db.close()
})

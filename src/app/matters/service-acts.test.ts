import {afterEach,beforeEach,describe,expect,it} from 'vitest'
import {openDb,type Db} from '../../lib/db'
import {makeMatterStore} from '../../adapters/store/matters-store'
import {makeMatterLog} from '../../adapters/store/matter-log'
import {ccActMatterId,makeCcActs} from '../../adapters/store/cc-acts'
import type {MatterLog,MatterStore} from '../../ports/matters'
import {makeMattersService} from './service'
import {PHONE_API_SCHEMAS} from '@wechat-cc/protocol'

/** 「CC 最近在忙」(M5c):act 那件事的发起方、最近一轮、详情里的轮与步(只经 MatterLog 读)。 */
let db:Db,store:MatterStore,log:MatterLog
beforeEach(()=>{db=openDb({path:':memory:'});store=makeMatterStore(db,()=>1_000);log=makeMatterLog(db)})
afterEach(()=>db.close())

const acts=()=>makeCcActs({db,log,matters:store})

describe('matters service · CC 自己做的事',()=>{
  it('withActs:act 行带上发起方与最近那一轮(步只留数字 / 真假 / 短字符串);别的行原样',()=>{
    const a=acts()
    const t1=a.begin('letters',{startedAt:1_000});t1.step('artifact',{letter:'L1',pages:2,chars:420,opening:'今天想跟你说'});t1.finish('completed',{endedAt:1_500})
    const t2=a.begin('letters',{startedAt:2_000})
    t2.step('artifact',{letter:'L2',pages:1,chars:300,opening:'x'.repeat(500),nested:{deep:{no:1}},list:[1,2]})
    t2.step('delivery',{letter:'L2',result:'sent',via:'image'})
    t2.finish('completed',{endedAt:2_500})
    store.create({id:'deadbeef',kind:'task',title:'整理周报'})
    const service=makeMattersService({store,log})
    const rows=service.withActs(service.list({}))
    const letters=rows.find(m=>m.id===ccActMatterId('letters'))!
    expect(letters.act?.who).toBe('letters')
    expect(letters.act?.latest).toMatchObject({status:'completed',startedAt:2_000,endedAt:2_500})
    const steps=letters.act!.latest!.steps
    expect(steps.map(s=>[s.kind,s.status])).toEqual([['artifact','completed'],['delivery','completed']])
    expect(steps[0]!.payload).toEqual({letter:'L2',pages:1,chars:300,opening:'x'.repeat(120)})
    expect(steps[1]!.payload).toEqual({letter:'L2',result:'sent',via:'image'})
    expect(rows.find(m=>m.id==='deadbeef')).not.toHaveProperty('act')
  })

  it('记忆整理:计数(一层数字表)留着,trigger 从 policy 里拿;没接 log ⇒ 不带 act',()=>{
    const t=acts().begin('memory',{startedAt:10,policy:{trigger:'owner'}})
    t.step('system',{applied:{add:2,update:1},notice:true});t.finish('completed',{endedAt:20})
    const id=ccActMatterId('memory')
    const [row]=makeMattersService({store,log}).withActs(store.list({kind:'act'}))
    expect(row!.act).toEqual({who:'memory',latest:{id:expect.any(String),status:'completed',errorCode:null,trigger:'owner',startedAt:10,endedAt:20,steps:[{kind:'system',status:'completed',at:expect.any(Number),payload:{applied:{add:2,update:1},notice:true}}]}})
    expect(makeMattersService({store}).withActs(store.list({kind:'act'}))[0]).not.toHaveProperty('act')
    expect(row!.id).toBe(id)
  })

  it('详情:act 的轮新的在前(至多 20 轮),每轮带自己的步(后补到旧轮上的那步也在);形状过协议',async()=>{
    const a=acts()
    const first=a.begin('memory',{startedAt:100,policy:{trigger:'schedule'}});first.step('system',{applied:{add:1}});first.finish('completed',{endedAt:110})
    for(let i=0;i<25;i++)a.begin('memory',{startedAt:200+i}).finish('failed',{endedAt:200+i,errorCode:'owner_edited'})
    // 几小时后才送的通知,挂在第一轮上
    a.toTurn('memory',first.id!,'delivery',{notice:'sent',channel:'wechat'})
    const service=makeMattersService({store,log})
    const d=await service.detail(ccActMatterId('memory'))
    expect(d.actTurns).toHaveLength(20)
    expect(d.actTurns![0]).toMatchObject({startedAt:224,status:'failed',errorCode:'owner_edited',steps:[]})
    expect(d.matter.act?.who).toBe('memory')
    expect(d.matter.act?.latest?.startedAt).toBe(224)
    // 只要最近 20 轮;第一轮不在里面,但它的步也不会混进别的轮
    expect(d.actTurns!.every(t=>t.steps.length===0)).toBe(true)
    const all=await makeMattersService({store,log,actTurnLimit:30}).detail(ccActMatterId('memory'))
    expect(all.actTurns!.at(-1)!.steps.map(s=>[s.kind,s.payload])).toEqual([['system',{applied:{add:1}}],['delivery',{notice:'sent',channel:'wechat'}]])
    const parsed=PHONE_API_SCHEMAS['GET /m/api/matter']!.safeParse({ok:true,...d})
    expect(parsed.success).toBe(true)
  })

  it('不是 act 的详情不带 actTurns;读轮失败不掀翻详情',async()=>{
    store.create({id:'00000001',kind:'task',title:'t'})
    expect(await makeMattersService({store,log}).detail('00000001')).not.toHaveProperty('actTurns')
    acts().begin('hunt',{startedAt:1}).finish('completed')
    const broken={turns:()=>{throw new Error('db gone')},items:()=>[]}
    const d=await makeMattersService({store,log:broken}).detail(ccActMatterId('hunt'))
    expect(d.matter.kind).toBe('act');expect(d).not.toHaveProperty('actTurns')
    expect(makeMattersService({store,log:broken}).withActs(store.list({kind:'act'}))[0]).not.toHaveProperty('act')
  })

  it('列表行带 act 照样过协议的 Matter 形状',()=>{
    const t=acts().begin('stickers',{startedAt:5,policy:{mood:'happy'}});t.step('artifact',{mood:'happy',file:'a.png',variation:false});t.finish('completed',{endedAt:6})
    const rows=makeMattersService({store,log}).withActs(store.list({kind:'act'}))
    expect(PHONE_API_SCHEMAS['GET /m/api/matters']!.safeParse({ok:true,matters:rows}).success).toBe(true)
  })
})

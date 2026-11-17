import { describe, expect, it } from 'vitest'
import { makeRosterReader } from './reader'
import { rosterRoutes } from './routes'
import type { Matter } from '../../ports/matters'
import type { InternalApiDeps } from '../../daemon/internal-api/types'
const m = (extra: Partial<Matter> = {}): Matter => ({ id:'12345678', kind:'task', title:'备份', state:'working', archivedAt:null, projectPath:'/work/project', ownerChatId:null, originMatterId:null, originMessageId:null, createdAt:1, updatedAt:10, ...extra })
const reader = (rows: Matter[] = [m()], workbench?: any) => makeRosterReader({ matters:{ list:() => rows }, terminals:()=>[], seen:()=>null, now:()=>100, workbench })
const route = (roster = reader()) => rosterRoutes({ roster } as InternalApiDeps)['GET /v1/roster']!
const call = (r = route(), origin: 'operator'|'device'|'link' = 'operator', headers = new Headers()) => r(new URLSearchParams(), null, {tier:'admin',origin}, {signal:new AbortController().signal, onSent:()=>{}, headers})
describe('名单读取与路由', () => {
  it('operator 拿到 items 与稳定 version', async () => {
    const r = reader(); const a = r.read('operator')
    expect(a.items[0]).toMatchObject({key:'matter:12345678',group:'working',project:'project'})
    expect(a.version).toMatch(/^[a-f0-9]{16}$/)
    expect(r.read('operator').version).toBe(a.version)
    expect((await call(route(r))).body).toEqual(a)
  })
  it('device 看不到别人聊天的事与挂在它下面的会话', () => {
    const r = makeRosterReader({matters:{list:()=>[m({kind:'chat',ownerChatId:'other'})]},terminals:()=>[{session_id:'s',code:'s',source:'claude',status:'running',project:'p',matter_id:'12345678',last_event_at:10,pending:null} as any],seen:()=>null,now:()=>100})
    expect(r.read('device').items).toEqual([])
  })
  it('link 令牌 403', async () => { expect(await call(route(), 'link')).toEqual({status:403,body:{error:'forbidden'}}) })
  it('If-None-Match 命中返回 304', async () => {
    const r = reader(); expect((await call(route(r),'operator',new Headers({'If-None-Match':r.read('operator').version}))).status).toBe(304)
  })
  it('detail 抛错仍 200，那件按 matter state 判', async () => {
    const r = reader([m({state:'done'})],{list:()=>({tasks:[{id:'12345678',status:'running',phase:'working'}]}),attention:()=>({tasks:[{id:'12345678'}]}),detail:()=>{throw Error('gone')}})
    const out = await call(route(r)); expect(out.status).toBe(200); expect((out.body as any).items[0].group).toBe('back')
  })
  it('没有活着的事返回 200 空名单', async () => { expect(await call(route(reader([])))).toMatchObject({status:200,body:{items:[]}}) })
  it('读取器抛错返回 503', async () => { expect(await call(route({read:()=>{throw Error('private')}}))).toEqual({status:503,body:{error:'unavailable'}}) })
  it('待批用创建时间排序，并保留 relay 和正式名字', () => {
    const r = makeRosterReader({matters:{list:()=>[m({agents:['claude','codex']})]},terminals:()=>[],seen:()=>null,now:()=>100,executorName:id=>`name:${id}`,relay:()=>({index:2,total:3,currentAgent:'codex'}),workbench:{list:()=>({tasks:[]}),attention:()=>({tasks:[{id:'12345678'}]}),detail:()=>({permissions:[{id:'p',createdAt:20,tool:'read',description:'file'}],questions:[{id:'q',createdAt:5,questions:[{question:'which?'}]}]})} as any})
    expect(r.read('device').items[0]).toMatchObject({waiting:{requestId:'q',count:2},relay:{index:2,total:3},agents:[{id:'claude',name:'name:claude',current:false},{id:'codex',current:true}]})
  })
})

describe('名单只读可能进名单的事', () => {
  it('没完的(不论多旧)与 24 小时内动过的都在;更早做完的不读;等你的旧任务按 id 补', () => {
    const DAY = 24 * 3_600_000, NOW = 10 * DAY
    const rows = [
      m({ id: 'aaaa0001', state: 'working', updatedAt: NOW - 5 * DAY }),
      m({ id: 'aaaa0002', state: 'done', updatedAt: NOW - 2 * DAY }),
      m({ id: 'aaaa0003', state: 'done', updatedAt: NOW - 3_600_000 }),
      m({ id: 'aaaa0004', state: 'done', updatedAt: NOW - 3 * DAY }),
    ]
    const filters: unknown[] = []
    const list = (f: { kind?: string; state?: string; since?: number } = {}) => {
      filters.push(f)
      return rows.filter(r => (!f.kind || r.kind === f.kind) && (!f.state || r.state === f.state) && (f.since === undefined || r.updatedAt >= f.since))
    }
    const workbench = { list: () => ({ tasks: [] }), attention: () => ({ tasks: [{ id: 'aaaa0004' }] }), detail: () => ({ permissions: [{ id: 'p1', tool: 'Bash', description: 'ls', createdAt: NOW - 3 * DAY }], questions: [] }) }
    const r = makeRosterReader({ matters: { list, get: id => rows.find(x => x.id === id) ?? null }, terminals: () => [], seen: () => null, now: () => NOW, workbench })
    expect(r.read('operator').items.map(i => i.id).sort()).toEqual(['aaaa0001', 'aaaa0003', 'aaaa0004'])
    expect(filters.every(f => (f as { state?: string; since?: number }).state !== undefined || (f as { since?: number }).since !== undefined)).toBe(true)
  })
})

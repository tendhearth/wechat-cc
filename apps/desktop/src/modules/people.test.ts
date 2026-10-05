import { describe, expect, it, vi, beforeEach } from 'vitest'

const showToast = vi.fn()
const invokeApi = vi.fn()
vi.mock('../view.js', () => ({ escapeHtml: (s: string) => String(s), showToast: (m: string) => showToast(m) }))
vi.mock('../api.js', () => ({ invokeApi: (...a: unknown[]) => invokeApi(...a) }))

const els = new Map<string, { innerHTML: string; textContent: string; addEventListener: () => void }>()
const mkEl = () => ({ innerHTML: '', textContent: '', addEventListener: () => {} })
// @ts-expect-error minimal DOM stub
globalThis.document = { getElementById: (id: string) => els.get(id) ?? null }

const { renderPeople, refreshPeople, deactivatePeople, familiarityLine, canVisit, visitTarget, onPeopleClick } = await import('./people.js')

const rel = (o: Partial<Record<string, unknown>> = {}) => ({
  id: 'neighbor:ayou', kind: 'neighbor', label: '邻居「阿柚」', channel: null,
  familiarity: { visits: 2, lastAt: new Date().toISOString(), note: '聊了豆子' }, origin: '公共伙伴(tendhearth)', autoVisit: true, ...o,
})
beforeEach(() => { els.clear(); els.set('fd-people', mkEl()); els.set('fd-people-count', mkEl()); showToast.mockClear(); invokeApi.mockReset() })
const host = () => els.get('fd-people')!

describe('renderPeople', () => {
  it('每位一行:称呼、类型、熟悉度、上次聊到、串门按钮', () => {
    renderPeople({ relationships: [rel()] })
    const h = host().innerHTML
    expect(h).toContain('邻居「阿柚」'); expect(h).toContain('邻居'); expect(h).toContain('去过 2 次')
    expect(h).toContain('聊了豆子'); expect(h).toContain('data-pp-target="ayou"'); expect(h).toContain('自动')
    expect(els.get('fd-people-count')!.textContent).toBe('1 位')
  })
  it('**读不到 ≠ 谁都不认识**', () => {
    renderPeople({ relationships: null }); expect(host().innerHTML).toContain('暂时无法读取')
    renderPeople({ relationships: [] }); expect(host().innerHTML).toContain('还谁都不认识')
  })
  it('人类朋友没有串门按钮(人不是驱动)', () => {
    renderPeople({ relationships: [rel({ id: 'human:x', kind: 'human', label: '小王', autoVisit: false })] })
    expect(host().innerHTML).not.toContain('data-pp-action="visit"')
    expect(host().innerHTML).toContain('来找过我')
  })
  it('经介绍人的只显示「第 N 度的某人」,有信道就能手动串门', () => {
    renderPeople({ relationships: [rel({ id: 'anon:ch2', kind: 'anon', label: '第 2 度的某人', channel: 'ch2', autoVisit: false })] })
    expect(host().innerHTML).toContain('第 2 度的某人'); expect(host().innerHTML).toContain('data-pp-target="ch2"')
    expect(host().innerHTML).not.toContain('自动')
  })
})

describe('familiarityLine / canVisit / visitTarget', () => {
  it('熟悉度一行', () => {
    expect(familiarityLine({ visits: 0, lastAt: null }, 'neighbor')).toBe('还没去过')
    expect(familiarityLine({ visits: 0, lastAt: null }, 'human')).toBe('聊过一次')
    expect(familiarityLine({ visits: 3, lastAt: null }, 'peer')).toBe('去过 3 次')
    expect(familiarityLine({ visits: 1, lastAt: null }, 'human')).toBe('来过 1 次')
  })
  it('没信道的真对端不能串门', () => {
    expect(canVisit(rel({ kind: 'peer', channel: null }))).toBe(false)
    expect(canVisit(rel({ kind: 'peer', channel: 'ch' }))).toBe(true)
    expect(visitTarget(rel({ kind: 'peer', channel: 'ch' }))).toBe('ch')
  })
})

describe('onPeopleClick', () => {
  const btn = (attrs: Record<string, string>) => ({ disabled: false, getAttribute: (k: string) => attrs[k] ?? null })
  it('点串门 → POST /v1/social/visit,起跑就提示', async () => {
    invokeApi.mockResolvedValueOnce({ ok: true, started: true })
    await onPeopleClick({ target: { closest: () => btn({ 'data-pp-action': 'visit', 'data-pp-target': 'ayou' }) } })
    expect(invokeApi).toHaveBeenCalledWith('POST', '/v1/social/visit', { target: 'ayou' })
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('出门了'))
  })
  it('社交没开 → 说清楚', async () => {
    invokeApi.mockResolvedValueOnce({ error: 'social_not_wired' })
    await onPeopleClick({ target: { closest: () => btn({ 'data-pp-action': 'visit', 'data-pp-target': 'ayou' }) } })
    expect(showToast).toHaveBeenCalledWith('社交还没开')
  })
})

describe('联系人读取的恢复和生命周期',()=>{
 it('旧重试读取不覆盖后来的联系人渲染',async()=>{
  let finish!:(value:unknown)=>void
  invokeApi.mockImplementationOnce(()=>new Promise(r=>{finish=r}));const stale=refreshPeople()
  renderPeople({relationships:[rel({label:'已读到的新朋友'})]})
  finish({relationships:[rel({label:'旧朋友'})]});await stale
  expect(host().innerHTML).toContain('已读到的新朋友');expect(host().innerHTML).not.toContain('旧朋友')
 })
 it('離頁使旧读取与串门回执失效，不能给新页面冒成功提示',async()=>{
  let finish!:(value:unknown)=>void
  invokeApi.mockImplementationOnce(()=>new Promise(r=>{finish=r}))
  const target={disabled:false,getAttribute:(k:string)=>k==='data-pp-target'?'ayou':'visit'}
  const request=onPeopleClick({target:{closest:()=>target}});deactivatePeople()
  finish({ok:true});await request
  expect(target.disabled).toBe(false);expect(showToast).not.toHaveBeenCalled()
 })
 it('失败给原地重试入口，明确未开启才给启用动作',()=>{
  renderPeople({relationships:null} as never)
  expect(host().innerHTML).toContain('data-pp-action="retry"');expect(host().innerHTML).not.toContain('data-action="social-enable"')
  renderPeople({relationships:null,error:'social_not_wired'} as never)
  expect(host().innerHTML).toContain('data-action="social-enable"')
 })
 it('上次聊到的完整文字不依赖单行省略显示',()=>{
  renderPeople({relationships:[rel({familiarity:{visits:1,lastAt:null,note:'第一行\n第二行完整文字'}})]})
  expect(host().innerHTML).toContain('第二行完整文字')
 })
 it('串门请求没有返回时，同一目标不能从另一个入口重复发起',async()=>{
  let finish!:(value:unknown)=>void
  invokeApi.mockImplementationOnce(()=>new Promise(r=>{finish=r}))
  const make=()=>({disabled:false,getAttribute:(k:string)=>k==='data-pp-target'?'ayou':'visit'})
  const first=onPeopleClick({target:{closest:()=>make()}});await onPeopleClick({target:{closest:()=>make()}})
  expect(invokeApi).toHaveBeenCalledTimes(1);finish({ok:true});await first
 })
})

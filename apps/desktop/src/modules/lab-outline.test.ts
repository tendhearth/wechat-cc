// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
import type { PlaceOutlineT } from '@wechat-cc/protocol'
import MindElixir from '../vendor/mind-elixir/MindElixir.js'
import { outlineData, outlineNotice, outlineSource } from './lab-outline-model.js'
import { mountOutlineMap } from './lab-outline.js'
import { leafId } from './lab-map-model.js'

const now = 100000
const first = { id:'o:1', line:'<img onerror=alert(1)>', status:'open' as const, sources:[
  {kind:'entry' as const}, {kind:'session' as const, agent:'Codex', sessionId:'live', at:now},
  {kind:'session' as const, agent:'Claude Code', sessionId:'gone'},
] }
const aspects: NonNullable<PlaceOutlineT['aspects']> = [
  {name:'界面',items:[first, {...first,id:'o:2',status:'active'}]},
  {name:'同步',items:[{...first,id:'o:3',status:'decided'}, {...first,id:'o:4',status:'done'}]},
  {name:'审核',items:[{...first,id:'o:5',status:'noted'}]},
]

it('按叶子的数量左右分支，方面颜色独立，节点文本保持原字', () => {
  const tree = outlineData('花园', aspects)
  expect(tree.nodeData.topic).toBe('花园')
  expect(tree.nodeData.children.map(b => [b.topic, b.direction, b.branchColor])).toEqual([
    ['界面', 1, 'var(--th-map-clay)'], ['同步', 0, 'var(--th-map-slate)'], ['审核', 0, 'var(--th-map-plum)'],
  ])
  expect(tree.nodeData.children[0]?.children[0]).toEqual({id:leafId(first.id),topic:first.line})
})

it('出处和状态行覆盖条目、会话、有无名字和可跳与不可跳', () => {
  expect(outlineSource(first, first.sources[0]!, false, now)).toEqual({
    text:'没解决的 · CC 梳理的 · 出自 CC 记下的一条', jump:false, missing:false,
  })
  expect(outlineSource(first, first.sources[1]!, true, now)).toEqual({
    text:'没解决的 · CC 梳理的 · 出自 Codex 的会话 · 刚刚', jump:true, missing:false,
  })
  expect(outlineSource(first, first.sources[1]!, true, now, false).text).toBe('出自 Codex 的会话 · 刚刚')
  expect(outlineSource(first, {kind:'session'}, false, now)).toEqual({
    text:'没解决的 · CC 梳理的 · 出自终端会话', jump:false, missing:true,
  })
  expect(outlineNotice({state:'ready', at:now, stale:true, canRun:true},now)).toEqual({text:'CC 梳理的 · 刚刚',action:'重新梳理'})
  expect(outlineNotice({state:'ready', at:now, stale:true, canRun:false},now).text).toContain('今天梳理过了。')
  expect(outlineNotice({state:'failed', canRun:true, error:'no_private_model'},now).reason).toBe('现在没有可用的私密模型。')
  expect(outlineNotice({state:'failed', canRun:false},now).reason).toBe('今天试过几次都没成，明天再试。')
})

it('挂载实际只读图，状态圆点来自叶子的 data 属性，选中显示全部出处', async () => {
  const host = document.createElement('div')
  document.body.append(host)
  const jumpSource = vi.fn()
  const call = vi.fn(async () => ({ok:true,place:{key:'test',name:'花园'},outline:{state:'ready',canRun:false,aspects}}))
  const stop = mountOutlineMap({host,key:'test',call,jumpSource,canJumpSource:source => source.sessionId === 'live',
    loadMap: async () => MindElixir,theme:{name:'test',type:'light',palette:[],cssVar:{}},fitMap:()=>{}})
  try {
    await vi.waitFor(() => expect(host.querySelectorAll('[data-outline-status]')).toHaveLength(5))
    expect(call).toHaveBeenCalledExactlyOnceWith('GET','/v1/places/map?key=test&outline=1')
    expect([...host.querySelectorAll<HTMLElement>('[data-outline-status]')].map(el => el.dataset.outlineStatus).sort())
      .toEqual(['active','decided','done','noted','open'])
    const leaf = host.querySelector('[data-outline-status="open"]')!
    expect(leaf.textContent).toBe(first.line)
    expect(host.querySelector('img, [onerror]')).toBeNull()
    leaf.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))
    const details = host.querySelector('.lab-map-details')!
    expect(details.textContent).toContain('出自 CC 记下的一条')
    expect(details.textContent).toContain('出自 Codex 的会话')
    expect(details.textContent).toContain('那次会话已经翻不到了')
    expect(details.querySelectorAll('button')).toHaveLength(1)
    details.querySelector('button')!.click()
    expect(jumpSource).toHaveBeenCalledExactlyOnceWith(first.sources[1])
  } finally {
    stop()
    host.remove()
  }
})

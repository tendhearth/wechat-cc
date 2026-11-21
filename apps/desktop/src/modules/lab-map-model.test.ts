// @vitest-environment happy-dom
import { expect, it } from 'vitest'
import type { PlaceMapItemT } from '@wechat-cc/protocol'
import MindElixir from '../vendor/mind-elixir/MindElixir.js'
import { mapBranch, placedBranch, mapData, mapLabel, leafId } from './lab-map-model.js'

const item = (kind:PlaceMapItemT['kind'], status:string, line = kind as string):PlaceMapItemT =>
  ({ id:kind+status, kind, status, line, from:{ source:'chat', at:0 } })

it.each([
  ['ask','waiting','open'], ['commitment','live','open'], ['commitment','done','done'],
  ['session','waiting','open'], ['task','waiting','open'], ['session','working','active'], ['task','working','active'],
  ['decision','live','decided'], ['decision','done',undefined],
  ['fact','live','noted'], ['fact','done',undefined], ['progress','live','done'], ['progress','done','done'],
  ['conclusion','live','done'], ['conclusion','done','done'],
  ['task','replied','done'], ['task','done','done'], ['task','stopped','done'], ['task','failed','done'],
  ['session','replied','done'], ['session','done','done'], ['session','stopped','done'], ['session','failed','done'],
] as const)('%s %s → %s', (kind,status,branch) => expect(mapBranch(item(kind,status))).toBe(branch))

it('按叶子分量先右后左，保留空支，显示执行者', () => {
  const entries = [item('ask','waiting'), item('task','working','工作一'), item('decision','live'), item('fact','live')]
  const tree = mapData('花园', entries, () => 'Codex')
  expect(tree.nodeData.children.map(({topic,direction}) => [topic,direction])).toEqual([
    ['没解决的',1], ['在做的',1], ['定了的',0], ['做过的',0], ['记下的',0],
  ])
  expect(tree.nodeData.children[1]?.children[0]?.topic).toBe('Codex · 工作一')
  const heavy = Array.from({length:7}, (_,i) => ({...item('fact','live'), id:'heavy'+i}))
  expect(mapData('花园',[...entries,...heavy],()=>'').nodeData.children.map(b => b.direction)).toEqual([1,1,1,1,0])
  expect(mapData('空',[],()=>'').nodeData.children).toEqual([])
})

it('按 Unicode 字符截短，保留短行原字', () => {
  expect(mapLabel('𠮷'.repeat(28))).toBe('𠮷'.repeat(28))
  expect(mapLabel('𠮷'.repeat(29))).toBe('𠮷'.repeat(28)+'…')
})

it('实际渲染恶意形状的标题和条目时只生成文本', () => {
  const line = '<img onerror=alert(1)>'
  const entry = item('fact','live',line)
  const el = document.createElement('div')
  document.body.append(el)
  const mind = new MindElixir({
    el, direction:2, editable:false, toolBar:false, keypress:false, contextMenu:false, allowUndo:false,
    before:{}, theme:{ name:'test', type:'light', palette:[], cssVar:{} },
  })
  try {
    expect(mind.init(mapData(line,[entry],()=>''))).toBeUndefined()
    expect(mind.findEle(leafId(entry.id)).textContent).toBe(line)
    expect(mind.findEle('root').textContent).toBe(line)
    expect(el.querySelector('img, [onerror]')).toBeNull()
  } finally {
    mind.destroy()
    el.remove()
  }
})

it('手放优先于状态，只给有 pin 的叶子加标记', () => {
  const normal = item('task','working')
  const pinned = { ...item('decision','live'), pin:'done' } as const
  expect(placedBranch(normal)).toBe('active')
  expect(placedBranch(pinned)).toBe('done')
  expect(placedBranch({ ...pinned, status:'done' })).toBe('done')
  const groups = mapData('花园', [normal, pinned], () => '').nodeData.children
  expect(groups.find(group => group.id === 'g:active')?.children[0]?.tags).toBeUndefined()
  expect(groups.find(group => group.id === 'g:done')?.children[0]?.tags).toEqual(['你放的'])
  expect(groups.find(group => group.id === 'g:decided')?.children).toEqual([])
})

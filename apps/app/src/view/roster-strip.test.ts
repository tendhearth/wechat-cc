import { expect, it } from 'vitest'
import type { RosterItemT } from '@wechat-cc/protocol'
import { stripView } from './roster-strip'
const row = (id: string, group: RosterItemT['group']): RosterItemT => ({ key: `matter:${id}`, kind: 'matter', id, title: id, group, status: 'working', agents: [{id:'claude',current:false},{id:'codex',current:true}], quiet:false, updatedAt:1, unseen:false })
it('only waiting and working, five avatars, total includes back; current first', () => {
  const view = stripView([row('w','waiting'), ...Array.from({length:6},(_,i)=>row(`${i}`,'working')),row('b','back')], {known:true})
  expect(view.total).toBe(8); expect(view.avatars).toHaveLength(5)
  expect(view.avatars[0]).toMatchObject({waiting:true,current:'codex',agents:['codex','claude']})
})
it('stale waiting never has live emphasis; all empty occupies no row', () => {
  expect(stripView([row('w','waiting')],{known:false}).avatars[0]?.waiting).toBe(false)
  expect(stripView([],{known:true})).toEqual({avatars:[],total:0})
})

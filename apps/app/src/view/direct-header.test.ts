import { expect, it } from 'vitest'
import { directHeaderView } from './direct-header'
import type { CliSessionRowT, MatterDetailT } from '../backend/types'
import { DETAIL } from '../backend/fixtures'
it('unattached terminal names its speaker and project',()=>{
 const v=directHeaderView({session_id:'t',source:'claude',displayName:'Claude Code',project:'bx'} as CliSessionRowT,'zh-Hans')
 expect(v.title).toBe('在跟 Claude Code 说 · bx');expect(v.placeholder).toBe('对 Claude Code 说…')
})
it('relay switches speaker and placeholder with the current run',()=>{
 const d={...DETAIL,matter:{...DETAIL.matter,agentNames:{claude:'Claude',codex:'Codex'}},task:{...DETAIL.task,providerId:'claude'}} as MatterDetailT
 expect(directHeaderView(d,'zh-Hans').current).toBe('claude')
 const next={...d,task:{...d.task!,providerId:'codex'}}
 expect(directHeaderView(next,'zh-Hans').placeholder).toBe('对 Codex 说…')
 expect(directHeaderView(next,'zh-Hans').title).toBe(next.matter.title)
 expect(directHeaderView(next,'en').title).toBe(next.matter.title)
 expect(directHeaderView(next,'zh-Hans').titleLines).toBe(2)
})

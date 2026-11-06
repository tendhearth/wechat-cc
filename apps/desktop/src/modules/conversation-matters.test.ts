// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { matterReferenceHtml, updateConversationMatters, updateConversationAttention } from './conversation-matters.js'
describe('conversation matter references', () => {
  it('updates the stable reference without collapsing the process or changing focus', () => {
    document.body.innerHTML = matterReferenceHtml('test1', '<backup>', true)
    const row = document.querySelector('details')!; row.open = true
    const button = row.querySelector('button')!; button.focus()
    updateConversationMatters([{ id:'test1', title:'backup', status:'running', pendingPermissionCount:1, updatedAt:1, providerId:'codex' } as any])
    expect(row.textContent).toContain('等你决定')
    expect(row.textContent).toContain('以前交办的事')
    expect(row.open).toBe(true)
    expect(document.activeElement).toBe(button)
    expect(row.querySelector('backup')).toBeNull()
    updateConversationMatters([], true)
    expect(row.textContent).toContain('尚未同步')
    expect(row.textContent).not.toContain('等你决定')
  })
  it('never labels failure or cancellation as complete', () => {
    document.body.innerHTML = matterReferenceHtml('f', '备份') + matterReferenceHtml('c', '清理')
    updateConversationMatters([{ id:'f', status:'failed', updatedAt:1 },{ id:'c', status:'cancelled', updatedAt:1 }] as any, false)
    expect(document.querySelector('[data-matter-id="f"] [data-matter-state]')!.textContent).toContain('没做成')
    expect(document.querySelector('[data-matter-id="c"] [data-matter-state]')!.textContent).toContain('停下')
  })
})

it('queued, paused and current attention remain honest in the conversation',()=>{
  document.body.innerHTML=matterReferenceHtml('q','排队')+matterReferenceHtml('p','暂停')
  updateConversationAttention({stale:false,tasks:[]})
  updateConversationMatters([{id:'q',status:'queued',updatedAt:3,createdAt:1},{id:'p',status:'running',networkSuspended:{since:1},updatedAt:3,createdAt:1}] as any,false)
  expect(document.querySelector('[data-matter-id="q"] [data-matter-state]')!.textContent).toContain('排队中')
  expect(document.querySelector('[data-matter-id="p"] [data-matter-state]')!.textContent).toContain('已暂停')
  updateConversationAttention({stale:false,tasks:[{id:'q',first:{text:'确认目标'}}]})
  expect(document.querySelector('[data-matter-id="q"] [data-matter-state]')!.textContent).toContain('等你决定')
  updateConversationAttention({stale:true,tasks:[]})
  expect(document.querySelector('[data-matter-id="q"] [data-matter-state]')!.textContent).toContain('尚未同步')
})

it('keeps CC-initiated work distinct from earlier owner delegation',()=>{
  document.body.innerHTML=matterReferenceHtml('cc-work','CC 带回来的',true)
  updateConversationMatters([{id:'cc-work',status:'completed',origin:'companion',createdAt:1,updatedAt:2}] as any,false)
  expect(document.querySelector('[data-matter-origin]')!.textContent).toContain('CC 自己做的事')
  expect(document.querySelector('[data-matter-origin]')!.textContent).not.toContain('以前交办的事')
})

it('fresh attention stays actionable when the older task list is unavailable',()=>{
  document.body.innerHTML=matterReferenceHtml('attention-only','备份',true)
  updateConversationMatters([],true)
  updateConversationAttention({stale:false,tasks:[{id:'attention-only',first:{text:'确认文件夹'}}]})
  expect(document.querySelector('[data-matter-state]')!.textContent).toContain('等你决定')
  expect(document.querySelector('[data-matter-progress]')!.textContent).toContain('确认文件夹')
  updateConversationAttention({stale:true,tasks:[]})
  expect(document.querySelector('[data-matter-state]')!.textContent).toBe('尚未同步')
})

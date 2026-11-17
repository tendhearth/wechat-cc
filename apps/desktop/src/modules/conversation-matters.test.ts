// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { matterReferenceHtml, updateConversationMatters, updateConversationAttention, mountMatterReferences, setDockedMatter } from './conversation-matters.js'
describe('conversation matter references', () => {
  it('单行引用保留焦点、标题转义和历史来源', () => {
    document.body.innerHTML = matterReferenceHtml('test1', '<backup>', true)
    const row = document.querySelector('a')!; row.focus()
    expect(document.querySelector('details')).toBeNull()
    updateConversationMatters([{ id:'test1', title:'backup', status:'running', pendingPermissionCount:1, updatedAt:1, providerId:'codex' } as any],false)
    expect(row.textContent).toContain('等你决定')
    expect(row.textContent).toContain('以前交办的事')
    expect(document.activeElement).toBe(row)
    expect(row.querySelector('backup')).toBeNull()
    expect(row.querySelector('[data-matter-avatar]')!.innerHTML).toContain('th-agent')
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
  expect(document.querySelector('[data-matter-id="q"] [data-matter-state]')!.textContent).toContain('等待中')
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
  expect(document.querySelector('[data-matter-progress]')).toBeNull()
  updateConversationAttention({stale:true,tasks:[]})
  expect(document.querySelector('[data-matter-state]')!.textContent).toBe('尚未同步')
})

it('点击不在名单里的旧事也交给 canonical opener，引用本身不读详情或轮询',async()=>{
  document.body.innerHTML=matterReferenceHtml('old-not-in-roster','旧事')
  const opened:string[]=[]
  const stop=mountMatterReferences(document.body,id=>{opened.push(id)})
  const row=document.querySelector('a')!
  row.click();expect(opened).toEqual(['old-not-in-roster'])
  stop();row.click();expect(opened).toHaveLength(1)
})
it('正停靠的事显示右边打开着，其余事仍保留状态',()=>{
 document.body.innerHTML=matterReferenceHtml('open','打开')+matterReferenceHtml('other','其他')
 setDockedMatter('open')
 expect(document.querySelector('[data-matter-id="open"]')?.getAttribute('data-docked')).toBe('true')
 expect(document.querySelector('[data-matter-id="open"]')?.textContent).toContain('在右边打开着')
 expect(document.querySelector('[data-matter-id="other"]')?.textContent).not.toContain('在右边打开着')
 setDockedMatter(null);expect(document.body.textContent).not.toContain('在右边打开着')
})

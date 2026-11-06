// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { matterReferenceHtml, updateConversationMatters } from './conversation-matters.js'
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

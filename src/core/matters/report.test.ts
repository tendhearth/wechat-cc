import {describe, expect, it} from 'vitest'
import type {Matter} from './store'
import {renderReport} from './report'

/**
 * renderReport 的失败测试先行(task-3-brief.md Step 1)。断言措辞按模板改写:
 * brief 里「生成了两份预览」是从设计文档示例句抄来的示例,不是规格——模板
 * 是「生成了 N 份成果。」,这里按模板断言;`quiet` 也不在 renderReport 的
 * 签名里(brief「Produces」块才是权威接口:{matter,title,artifactCount}),
 * 测试不传它。
 */
const base: Matter = {
  id: 'a1b2c3d4', kind: 'task', title: '手动派的', projectPath: '/work', status: 'replied',
  ownerChatId: null, originMatterId: null, originMessageId: null, createdAt: 1, updatedAt: 1,
}
const handmade: Matter = {...base}
const fromChat: Matter = {...base, id: 'e5f6a7b8', originMatterId: 'c1c1c1c1', originMessageId: 'msg-42'}

describe('renderReport', () => {
  it('没有出生地的事不报', () => {
    expect(renderReport({matter: handmade, title: '手动派的', artifactCount: 0})).toBeNull()
  })

  it('从聊天里交办的,报一句带现成动作的话', () => {
    const r = renderReport({matter: fromChat, title: '首页调整', artifactCount: 2})!
    expect(r).not.toBeNull()
    expect(r.text).toContain('首页调整')
    expect(r.text).toContain('已答复')
    expect(r.text).toContain('生成了2份成果。')
    expect(r.text).toContain(`任务 ${fromChat.id}`)
  })

  it('没有成果就不提份数', () => {
    const r = renderReport({matter: fromChat, title: '首页调整', artifactCount: 0})!
    expect(r.text).not.toContain('生成了')
    expect(r.text).not.toContain('份成果')
  })

  it('PendingReport 带上出生地,供投递器找回原对话', () => {
    const r = renderReport({matter: fromChat, title: '首页调整', artifactCount: 1})!
    expect(r.matterId).toBe(fromChat.id)
    expect(r.originMatterId).toBe('c1c1c1c1')
    expect(r.originMessageId).toBe('msg-42')
  })

  it('originMessageId 可以是 null(微信不一定给 msgId)', () => {
    const noMsgId: Matter = {...fromChat, originMessageId: null}
    const r = renderReport({matter: noMsgId, title: '首页调整', artifactCount: 0})!
    expect(r.originMessageId).toBeNull()
  })
})

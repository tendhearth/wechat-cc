import {describe, expect, it} from 'vitest'
import type {Matter} from './store'
import {renderReport, shouldDisturb, VIEWED_RECENTLY_MS} from './report'

/**
 * renderReport 的失败测试先行(task-3-brief.md Step 1)。断言措辞按模板改写:
 * brief 里「生成了两份预览」是从设计文档示例句抄来的示例,不是规格——模板
 * 是「累计生成了 N 份成果。」,这里按模板断言(评审修复轮 1 ④:artifactCount
 * 是累计数不是这一轮新增,文案里补了「累计」二字,免得读起来像 bug);
 * `quiet` 也不在 renderReport 的签名里(brief「Produces」块才是权威接口:
 * {matter,title,artifactCount}),测试不传它。
 */
const base: Matter = {
  id: 'a1b2c3d4', kind: 'task', title: '手动派的', projectPath: '/work', status: 'replied',
  ownerChatId: null, originMatterId: null, originMessageId: null, createdAt: 1, updatedAt: 1,
}
const handmade: Matter = {...base}
const fromChat: Matter = {...base, id: 'e5f6a7b8', originMatterId: 'c1c1c1c1', originMessageId: 'msg-42'}

describe('renderReport', () => {
  it('没有出生地的事不报', () => {
    expect(renderReport({matter: handmade, title: '手动派的', artifactCount: 0, turn: 0})).toBeNull()
  })

  it('从聊天里交办的,报一句带现成动作的话', () => {
    const r = renderReport({matter: fromChat, title: '首页调整', artifactCount: 2, turn: 0})!
    expect(r).not.toBeNull()
    expect(r.text).toContain('首页调整')
    expect(r.text).toContain('已答复')
    expect(r.text).toContain('累计生成了2份成果。')
    expect(r.text).toContain(`任务 ${fromChat.id}`)
  })

  it('没有成果就不提份数', () => {
    const r = renderReport({matter: fromChat, title: '首页调整', artifactCount: 0, turn: 0})!
    expect(r.text).not.toContain('生成了')
    expect(r.text).not.toContain('份成果')
  })

  it('PendingReport 带上出生地,供投递器找回原对话', () => {
    const r = renderReport({matter: fromChat, title: '首页调整', artifactCount: 1, turn: 0})!
    expect(r.matterId).toBe(fromChat.id)
    expect(r.originMatterId).toBe('c1c1c1c1')
    expect(r.originMessageId).toBe('msg-42')
  })

  it('originMessageId 可以是 null(微信不一定给 msgId)', () => {
    const noMsgId: Matter = {...fromChat, originMessageId: null}
    const r = renderReport({matter: noMsgId, title: '首页调整', artifactCount: 0, turn: 0})!
    expect(r.originMessageId).toBeNull()
  })

  /**
   * 终审第 6 项:相邻两轮没有新成果时,以前 outcome 是空字符串,两条文案
   * 逐字节相同——主人分不清指哪一轮,重复外发相同文本也正是本仓库在
   * reminders 那条专门退避的微信风控触发形状。轮次(Active.turnSeq)是
   * 现成的,塞进文案里就够区分。
   */
  it('相邻两轮没有新成果时,文案带着轮次、不会逐字节相同', () => {
    const r0 = renderReport({matter: fromChat, title: '首页调整', artifactCount: 0, turn: 0})!
    const r1 = renderReport({matter: fromChat, title: '首页调整', artifactCount: 0, turn: 1})!
    expect(r0.text).not.toBe(r1.text)
    expect(r0.text).toContain('第1轮')
    expect(r1.text).toContain('第2轮')
  })
})

/**
 * shouldDisturb 的失败测试先行(task-4-brief.md Step 1,原样照抄用例)。用真实
 * 量级的 epoch(NOW=1_800_000_000_000)而不是 1_000 这类小数——task-4-brief
 * 点名过上一轮的教训:小数字会让"减出来还是很大"这类算术巧合把假 bug 藏起来,
 * 这里 NOW 和 lastSeenAt 的差值必须是判据真正算出来的,不是凑出来的。
 */
const NOW = 1_800_000_000_000

describe('shouldDisturb', () => {
  it('这件事刚被动过 ⇒ 只静静更新,不打扰', () => {
    expect(shouldDisturb({lastSeenAt: NOW - 10_000, now: NOW})).toBe(false)
  })

  it('很久没被动过 ⇒ 该响', () => {
    expect(shouldDisturb({lastSeenAt: NOW - 120_000, now: NOW})).toBe(true)
  })

  /**
   * 评审修复轮 1 ①:原先这条用 now=NOW(1.8e12)代入,鉴别不出 null 分支——
   * 删掉 `if (input.lastSeenAt === null) return true` 这一行之后,JS 把
   * `NOW - null` 按 `NOW - 0` 算,算出来仍然 `>= 60_000` 为 true,测试照样
   * 绿(TS 的 number|null 静态类型是唯一挡住这个删除的东西,不是这条 expect)。
   * 换成小于阈值的 now(30_000 < VIEWED_RECENTLY_MS):有 null 分支 ⇒ true;
   * 删掉 null 分支 ⇒ `30_000 - 0 = 30_000 < 60_000` ⇒ false,两者产生真实分歧,
   * 这条测试才真的在钉这一行。已实测删掉该行确认变红(见 task-4-report.md)。
   */
  it('从来没被动过(没有绑定记录)⇒ 该响', () => {
    expect(shouldDisturb({lastSeenAt: null, now: 30_000})).toBe(true)
  })

  it('恰好等于阈值(60_000ms)⇒ 该响——边界在">="这一侧', () => {
    expect(shouldDisturb({lastSeenAt: NOW - VIEWED_RECENTLY_MS, now: NOW})).toBe(true)
  })
})

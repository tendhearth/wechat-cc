import { describe, expect, it } from 'vitest'
import { isRoutineTopicText, isRoutineTopicEntry } from './topic-noise'

describe('topic routine noise: conservative whole-record recognition', () => {
  it.each([
    'Codex升至0.167.0自检过',
    '服务升级至DB v109…便宜模型切至agy',
    'wechat-cc self deploy 完成,soak 通过',
    'CC 数据库迁移至 v109',
  ])('excludes maintenance receipt: %s', text => expect(isRoutineTopicText(text)).toBe(true))
  it.each([
    'CC桌宠录制完成43秒9核心动作演示',
    '决定修复 CLI 自动升级回滚漏洞',
    '答应周五补 self deploy 的回滚验收',
    'DB v109 迁移失败的根因是外键未开启,已修复',
    'Codex升至0.167.0自检过;仍欠桌宠录屏验收',
    '客户服务升级至 v109',
    'bx 部署完成',
    '升级规范决定采用官方升级器',
  ])('retains project work: %s', text => expect(isRoutineTopicText(text)).toBe(false))
})

describe('isRoutineTopicEntry: 索引行是机器回执、细节只做保护性否决(11-08 真机漏判)', () => {
  it('真机条目:索引行纯回执,细节是整理追加的同类回执历史 ⇒ 流水', () => {
    expect(isRoutineTopicEntry({ line: 'Codex升至0.167.0自检过', body: 'Codex自动升级至0.167.0并完成自检通过。\n之前:\n- Codex升至0.166.0自检过，Cursor升至2026.11.05过，agy升至1.5.1过' })).toBe(true)
  })
  it('细节里有主人在意的信号 ⇒ 保留', () => {
    expect(isRoutineTopicEntry({ line: 'Codex升至0.167.0自检过', body: '升级后发现审批卡回归，待修复' })).toBe(false)
    expect(isRoutineTopicEntry({ line: 'Codex升至0.167.0自检过', body: '主人决定以后固定这个版本' })).toBe(false)
  })
  it('索引行不是纯回执 ⇒ 保留,不管细节多像回执', () => {
    expect(isRoutineTopicEntry({ line: '确立单对话流+话题泡泡架构', body: 'Codex升至0.167.0自检过' })).toBe(false)
    expect(isRoutineTopicEntry({ line: 'CC桌宠4小时稳定性观察，录制完成43秒9核心动作演示', body: '' })).toBe(false)
  })
  it('没有细节时等同于只判索引行', () => {
    expect(isRoutineTopicEntry({ line: '服务升级至DB v109', body: null })).toBe(true)
    expect(isRoutineTopicEntry({ line: '服务升级至DB v109' })).toBe(true)
  })
})

import { describe, expect, it } from 'vitest'
import { isRoutineTopicText } from './topic-noise'

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

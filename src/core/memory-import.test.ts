import { describe, expect, it } from 'vitest'
import { splitImportedMemory, IMPORT_PROMPT, IMPORT_MAX_ITEMS } from './memory-import'

describe('memory import splitter', () => {
  it('the prompt asks for one fact per line, no secrets', () => {
    expect(IMPORT_PROMPT).toContain('一行一条')
    expect(IMPORT_PROMPT).toContain('密码')
  })
  it('splits bullets / numbered lines; strips markers; drops headings, empties, dupes, over-long lines', () => {
    const text = `以下是我记得的关于你的信息:\n\n## 基本情况\n- 你住在上海\n* 你喜欢喝美式咖啡,不加糖\n1. 你的女儿叫小满\n2) 你下个月要去日本出差\n- 你住在上海\n- ${'很长'.repeat(150)}\n• 你偏好简短的回答`
    const r = splitImportedMemory(text)
    expect(r.map(x => x.text)).toEqual(['你住在上海', '你喜欢喝美式咖啡,不加糖', '你的女儿叫小满', '你下个月要去日本出差', '你偏好简短的回答'])
    expect(r.map(x => x.section)).toEqual(['关于你', '偏好', '身边的人', '承诺', '偏好'])
  })
  it('caps the count; plain prose falls back to sentences', () => {
    const many = Array.from({ length: 40 }, (_, i) => `- 事实 ${i}`).join('\n')
    expect(splitImportedMemory(many)).toHaveLength(IMPORT_MAX_ITEMS)
    expect(splitImportedMemory('你在做一个叫 Tendhearth 的项目。你每天早上跑步。').map(x => x.text)).toEqual(['你在做一个叫 Tendhearth 的项目', '你每天早上跑步'])
  })
  it('drops lines that look like secrets', () => {
    expect(splitImportedMemory('- 你的密码是 hunter2\n- api key sk-ant-abcdefghijklmnopqrstuvwxyz\n- 你喜欢猫').map(x => x.text)).toEqual(['你喜欢猫'])
  })
})

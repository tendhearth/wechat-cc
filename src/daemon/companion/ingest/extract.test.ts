import { describe, it, expect } from 'vitest'
import { buildExtractionPrompt, parseFacts, type Batch } from './extract'

const batch: Batch = {
  batch_id: 'b1',
  contact: 'wxid_z',
  display: '张三',
  messages: [
    { msg_key: 'k1', sender: '张三', time: 1000, text: '我下周还你那本书' },
    { msg_key: 'k2', sender: '主人', time: 1001, text: null },   // undecoded → omitted
    { msg_key: 'k3', sender: '主人', time: 1002, text: '好' },
  ],
}

describe('buildExtractionPrompt', () => {
  it('includes the display name, the JSON-only instruction, and each decoded message', () => {
    const p = buildExtractionPrompt(batch)
    expect(p).toContain('张三')
    expect(p).toContain('只输出 JSON 数组')
    expect(p).toContain('[k1] 张三: 我下周还你那本书')
    expect(p).toContain('[k3] 主人: 好')
  })
  it('omits messages with null text', () => {
    expect(buildExtractionPrompt(batch)).not.toContain('k2')
  })
})

describe('parseFacts', () => {
  it('parses a clean array', () => {
    const f = parseFacts('[{"kind":"obligation","predicate":"欠","value":"一本书","source_msg_keys":["k1"]}]')
    expect(f).toHaveLength(1)
    expect(f[0]).toMatchObject({ kind: 'obligation', predicate: '欠', value: '一本书', source_msg_keys: ['k1'] })
  })
  it('handles a ```json code fence', () => {
    expect(parseFacts('```json\n[{"kind":"entity","predicate":"是","value":"产品经理"}]\n```')).toHaveLength(1)
  })
  it('extracts the array out of surrounding prose', () => {
    expect(parseFacts('好的，结果：[{"kind":"attribute","predicate":"喜欢","value":"爬山"}] 完成')).toHaveLength(1)
  })
  it('drops elements with an unknown kind but keeps valid siblings', () => {
    const f = parseFacts('[{"kind":"gossip","predicate":"a","value":"b"},{"kind":"event","predicate":"去了","value":"日本"}]')
    expect(f).toHaveLength(1)
    expect(f[0]!.kind).toBe('event')
  })
  it('drops an element missing value', () => {
    expect(parseFacts('[{"kind":"entity","predicate":"是"}]')).toEqual([])
  })
  it('drops a bad confidence but keeps the fact', () => {
    const f = parseFacts('[{"kind":"entity","predicate":"是","value":"x","confidence":"maybe"}]')
    expect(f).toHaveLength(1)
    expect(f[0]!.confidence).toBeUndefined()
  })
  it('returns [] for an empty array', () => {
    expect(parseFacts('[]')).toEqual([])
  })
  it('returns [] for a refusal with no array', () => {
    expect(parseFacts('我不能帮你做这个')).toEqual([])
  })
  it('returns [] for an object (not an array)', () => {
    expect(parseFacts('{"kind":"entity","predicate":"是","value":"x"}')).toEqual([])
  })
  it('returns [] (no throw) for malformed JSON', () => {
    expect(parseFacts('[{"kind":')).toEqual([])
  })
  it('does not truncate on a nested array inside a value-adjacent structure', () => {
    const f = parseFacts('[{"kind":"relation","predicate":"同事","value":"a","source_msg_keys":["k1","k2"]}]')
    expect(f[0]!.source_msg_keys).toEqual(['k1', 'k2'])
  })
})

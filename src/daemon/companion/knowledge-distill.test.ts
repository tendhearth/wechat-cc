import { describe, it, expect } from 'vitest'
import { distillOwnerKnowledge, KNOWLEDGE_DISTILL_CAP, type DistillBridge } from './knowledge-distill'

function bridge(tools: string[], responses: Record<string, unknown>): DistillBridge {
  const set = new Set(tools)
  return {
    hasTool: (t) => set.has(t),
    call: async (tool, input) => {
      const key = tool === 'top_contacts' ? `top_contacts:${(input as { by: string }).by}` : tool
      return JSON.stringify(responses[key] ?? {})
    },
  }
}

const FACTS = { results: [{ predicate: '我答应', value: '帮他改简历' }, { predicate: '欠', value: '一本书' }] }
const CLOSE = [{ display: '张三' }, { display: '李四' }]
const NEGLECTED = [{ display: '王五' }]

describe('distillOwnerKnowledge', () => {
  it('formats obligations + close + neglected into one markdown digest', async () => {
    const md = await distillOwnerKnowledge(bridge(['find_facts', 'top_contacts'], {
      find_facts: FACTS, 'top_contacts:closeness': CLOSE, 'top_contacts:neglected': NEGLECTED,
    }))
    expect(md).toContain('你的社交状态')
    expect(md).toContain('未了义务')
    expect(md).toContain('- 我答应 帮他改简历')
    expect(md).toContain('**亲近的人**\n- 张三、李四')
    expect(md).toContain('**好久没联系**\n- 王五')
  })

  it('omits a subsection whose tool is absent, keeps the rest', async () => {
    const md = await distillOwnerKnowledge(bridge(['top_contacts'], {   // no find_facts
      'top_contacts:closeness': CLOSE, 'top_contacts:neglected': NEGLECTED,
    }))
    expect(md).not.toContain('未了义务')
    expect(md).toContain('亲近的人')
  })

  it('returns empty string when nothing to distill', async () => {
    expect(await distillOwnerKnowledge(bridge([], {}))).toBe('')
    // tools present but all sources empty
    const md = await distillOwnerKnowledge(bridge(['find_facts', 'top_contacts'], {
      find_facts: { results: [] }, 'top_contacts:closeness': [], 'top_contacts:neglected': [],
    }))
    expect(md).toBe('')
  })

  it('tolerates malformed JSON from a source (drops it, no throw)', async () => {
    const b: DistillBridge = {
      hasTool: () => true,
      call: async (tool, input) => {
        if (tool === 'find_facts') return 'not json{'
        return JSON.stringify(tool === 'top_contacts' && (input as { by: string }).by === 'closeness' ? CLOSE : [])
      },
    }
    const md = await distillOwnerKnowledge(b)
    expect(md).not.toContain('未了义务')
    expect(md).toContain('张三')
  })

  it('caps the digest at KNOWLEDGE_DISTILL_CAP', async () => {
    const many = { results: Array.from({ length: 12 }, (_, i) => ({ predicate: 'p'.repeat(200), value: `v${i}`.repeat(50) })) }
    const md = await distillOwnerKnowledge(bridge(['find_facts'], { find_facts: many }))
    expect(md.length).toBeLessThanOrEqual(KNOWLEDGE_DISTILL_CAP)
  })
})

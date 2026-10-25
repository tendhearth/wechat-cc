import { describe, it, expect } from 'vitest'
import { parseAvoidTopics, avoidTopicsLine, topicLabels, AVOID_TOPICS } from './companion-topics'

describe('companion topics CC should not bring up on its own', () => {
  it('parses Chinese or English, any separator, dedups, keeps canonical order', () => {
    expect(parseAvoidTopics('健康,家人')).toEqual({ ok: true, topics: ['health', 'family'] })
    expect(parseAvoidTopics('family、health，钱')).toEqual({ ok: true, topics: ['health', 'family', 'money'] })
    expect(parseAvoidTopics('Work/work')).toEqual({ ok: true, topics: ['work'] })
  })
  it('none / 无 / 清空 clears', () => {
    for (const v of ['none', '无', '清空', 'off']) expect(parseAvoidTopics(v)).toEqual({ ok: true, topics: [] })
  })
  it('an unknown topic is an error naming it and the choices', () => {
    const r = parseAvoidTopics('健康,星座')
    expect(r.ok).toBe(false)
    if (!r.ok) { expect(r.error).toContain('星座'); for (const t of AVOID_TOPICS) expect(r.error).toContain(t.label) }
  })
  it('labels and the envelope line', () => {
    expect(topicLabels(['health', 'money'])).toBe('健康、钱')
    expect(avoidTopicsLine([])).toBe('')
    expect(avoidTopicsLine(undefined)).toBe('')
    const line = avoidTopicsLine(['health', 'family'])
    expect(line).toContain('健康、家人')
    expect(line).toContain('自己提起')
  })
  it('ignores junk stored in prefs', () => {
    expect(avoidTopicsLine(['health', 'bogus' as never])).toContain('健康')
    expect(avoidTopicsLine(['bogus' as never])).toBe('')
  })
})

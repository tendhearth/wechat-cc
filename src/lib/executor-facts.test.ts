import { describe, expect, it } from 'vitest'
import { EXECUTOR_FACTS } from './executor-facts'
import { PROVIDER_IDS } from './provider-ids'

describe('executor facts(重构第二批步 7:每家执行者的事实只写一处)', () => {
  it('covers exactly the provider id list', () => {
    expect(Object.keys(EXECUTOR_FACTS).sort()).toEqual([...PROVIDER_IDS].sort())
    for (const id of PROVIDER_IDS) expect(EXECUTOR_FACTS[id].id).toBe(id)
  })
  it('slash words are unique, lower-case, and claude is /cc, openai is /api', () => {
    const words = PROVIDER_IDS.map(id => EXECUTOR_FACTS[id].slash)
    expect(new Set(words).size).toBe(words.length)
    for (const w of words) expect(w).toBe(w.toLowerCase())
    expect(EXECUTOR_FACTS.claude.slash).toBe('cc'); expect(EXECUTOR_FACTS.openai.slash).toBe('api')
  })
  it('every executor has a setup hint; only claude and codex share the generic model field', () => {
    for (const id of PROVIDER_IDS) expect(EXECUTOR_FACTS[id].setupHint.length).toBeGreaterThan(0)
    expect(PROVIDER_IDS.filter(id => EXECUTOR_FACTS[id].modelField === 'model').sort()).toEqual(['claude', 'codex'])
  })
})

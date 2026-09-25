import { describe, it, expect } from 'vitest'
import { parseMemoryDoc, serializeMemoryDoc, renderForPrompt, docChars, parseDue, assignMissingIds, emptyDoc } from './curated-doc'

const SAMPLE = [
  '<!-- wechat-cc 记忆 · 每晚整理 · 最近整理 2026-09-24T04:00:00.000Z · 编号是给整理用的,别删;删了也不会丢,只会被当成新条目 -->',
  '',
  '## 关于你',
  '- 全栈开发兼产品 <!-- m:7f3a · 2026-08-24 -->',
  '## 偏好',
  '- 回复直接,别客套 <!-- m:91c2 · 2026-09-10 -->',
  '- 主人手写的一条',
  '## 承诺',
  '- 周五前给 X 回话(期限 2026-09-27) <!-- m:b01e · 2026-09-24 -->',
  '## 随手记',
  '一段主人自己加的话',
].join('\n')

describe('curated memory doc', () => {
  it('parses entries, ids, seen dates; keeps unknown sections as extra', () => {
    const d = parseMemoryDoc(SAMPLE)
    expect(d.sections['关于你']).toEqual([{ id: '7f3a', text: '全栈开发兼产品', seen: '2026-08-24' }])
    expect(d.sections['偏好'][1]).toEqual({ id: null, text: '主人手写的一条', seen: null })
    expect(d.extra).toEqual(['## 随手记', '一段主人自己加的话'])
  })
  it('round-trips byte-stably after one serialize', () => {
    const once = serializeMemoryDoc(parseMemoryDoc(SAMPLE), '2026-09-25T04:00:00.000Z')
    expect(serializeMemoryDoc(parseMemoryDoc(once), '2026-09-25T04:00:00.000Z')).toBe(once)
    expect(once).toContain('- 主人手写的一条\n')
    expect(once).toContain('## 随手记\n一段主人自己加的话')
  })
  it('renders for the prompt without comments or empty sections', () => {
    const r = renderForPrompt(parseMemoryDoc(SAMPLE))
    expect(r).not.toContain('<!--')
    expect(r).toContain('### 承诺\n- 周五前给 X 回话(期限 2026-09-27)')
    expect(r).not.toContain('### 近况')
  })
  it('counts only entry text; parses due dates', () => {
    const d = emptyDoc(); d.sections['近况'].push({ id: 'aaaa', text: '12345', seen: '2026-09-01' })
    expect(docChars(d)).toBe(5)
    expect(parseDue('周五前给 X 回话(期限 2026-09-27)')).toBe('2026-09-27')
    expect(parseDue('没有期限')).toBeNull()
  })
  it('assigns ids (and today as seen) only to entries without one', () => {
    let n = 0
    const d = assignMissingIds(parseMemoryDoc(SAMPLE), () => `n${n++}ab`, '2026-09-25')
    expect(d.sections['偏好'][1]).toEqual({ id: 'n0ab', text: '主人手写的一条', seen: '2026-09-25' })
    expect(d.sections['关于你'][0]!.id).toBe('7f3a')
  })
  it('keeps blank lines inside hand-written extra text, without growing on repeated round-trips', () => {
    const md = '## 承诺\n- x\n## 随手记\n第一段\n\n第二段\n'
    const d = parseMemoryDoc(md)
    expect(d.extra).toEqual(['## 随手记', '第一段', '', '第二段'])
    const once = serializeMemoryDoc(d, 'T')
    expect(serializeMemoryDoc(parseMemoryDoc(once), 'T')).toBe(once)
  })
  it('a leading BOM does not push the header into extra, and the rewrite has exactly one header and no BOM', () => {
    const d0 = parseMemoryDoc(SAMPLE)
    const bommed = '﻿' + serializeMemoryDoc(d0, '2026-09-24T04:00:00.000Z')
    const d = parseMemoryDoc(bommed)
    expect(d.extra).toEqual(d0.extra)
    expect(d.extra.some(l => l.includes('wechat-cc 记忆'))).toBe(false)
    const out = serializeMemoryDoc(d, '2026-09-25T04:00:00.000Z')
    expect(out.startsWith('﻿')).toBe(false)
    expect(out.split('\n').filter(l => l.includes('<!-- wechat-cc 记忆'))).toHaveLength(1)
  })
  it('a BOM-prefixed doc without extras parses with empty extra', () => {
    const bommed = '﻿' + serializeMemoryDoc(emptyDoc(), 'T')
    expect(parseMemoryDoc(bommed).extra).toEqual([])
  })
})

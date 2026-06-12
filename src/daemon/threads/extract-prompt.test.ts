import { describe, it, expect } from 'vitest'
import { buildExtractPrompt, parseExtractResponse } from './extract-prompt'

describe('extract prompt', () => {
  it('prompt embeds new messages, existing threads and tag vocabulary', () => {
    const p = buildExtractPrompt({
      newMessages: [{ ts: '2026-06-11T00:00:00Z', direction: 'in', text: '排产又要改' }],
      existingThreads: [{ id: 'thr_1', title: 'compass 排产', facets: ['task'], tags: ['compass'], summary: '' }],
      tagVocabulary: ['compass', '股票'],
    })
    expect(p).toContain('排产又要改')
    expect(p).toContain('thr_1')
    expect(p).toContain('compass')
    expect(p).toMatch(/反复出现|第二次/)
    expect(p).toMatch(/复用|已有 tag/)
  })

  it('parses ops from a fenced json response', () => {
    const ops = parseExtractResponse('```json\n{"ops":[{"op":"create","title":"股票观察","facets":["life"],"tags":["股票"],"private":false,"summary":"s","episode":{"from_ts":"a","to_ts":"b"}}]}\n```')
    expect(ops).toEqual([expect.objectContaining({ op: 'create', title: '股票观察' })])
  })

  it('rejects malformed responses with null (never throws)', () => {
    expect(parseExtractResponse('not json at all')).toBeNull()
    expect(parseExtractResponse('{"ops": "nope"}')).toBeNull()
    expect(parseExtractResponse('{"ops":[{"op":"create","title":"x","facets":["mood"]}]}')).toBeNull()
  })

  it('accepts update/touch ops referencing existing ids', () => {
    const ops = parseExtractResponse('{"ops":[{"op":"touch","id":"thr_1","episode":{"from_ts":"a","to_ts":"b"}},{"op":"update","id":"thr_1","status":"done"}]}')
    expect(ops?.length).toBe(2)
  })
})

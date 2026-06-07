import { describe, expect, it } from 'vitest'
import { classifyProbeResult } from './connection-probe'

describe('classifyProbeResult', () => {
  it('errcode -14 → taken_over with the server errmsg', () => {
    expect(classifyProbeResult({ resp: { errcode: -14, errmsg: 'session timeout' } }))
      .toEqual({ state: 'taken_over', detail: 'session timeout' })
  })
  it('ret -14 (alt field) → taken_over', () => {
    expect(classifyProbeResult({ resp: { ret: -14 } }).state).toBe('taken_over')
  })
  it('empty successful poll → connected', () => {
    expect(classifyProbeResult({ resp: { ret: 0, msgs: [] } }).state).toBe('connected')
  })
  it('thrown network error → inconclusive carrying the message', () => {
    expect(classifyProbeResult({ error: new Error('fetch failed') }))
      .toEqual({ state: 'inconclusive', detail: 'fetch failed' })
  })
})

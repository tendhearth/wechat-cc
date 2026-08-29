import { describe, expect, it } from 'vitest'
import { makeCursorStreamParser } from './cursor-cli-stream'

// Verbatim lines captured from cursor-agent 2026.08.11 (live spike 2026-08-25).
const INIT = '{"type":"system","subtype":"init","apiKeySource":"login","cwd":"/tmp/x","session_id":"86e522b6-09a5-4651-a268-d176e67e6527","model":"Auto","permissionMode":"default"}'
const USER_ECHO = '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"只回复两个字:收到"}]},"session_id":"86e522b6"}'
const THINKING = '{"type":"thinking","subtype":"delta","text":"用户要求…","session_id":"86e522b6","timestamp_ms":1}'
const ASSISTANT = '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"收到"}]},"session_id":"86e522b6"}'
const RESULT_OK = '{"type":"result","subtype":"success","duration_ms":8779,"is_error":false,"result":"收到","session_id":"86e522b6-09a5-4651-a268-d176e67e6527","request_id":"1b883ca0"}'

describe('makeCursorStreamParser', () => {
  it('parses the observed happy-path stream', () => {
    const p = makeCursorStreamParser()
    expect(p.feed(INIT)).toEqual([{ kind: 'init', sessionId: '86e522b6-09a5-4651-a268-d176e67e6527' }])
    expect(p.feed(USER_ECHO)).toEqual([])
    expect(p.feed(THINKING)).toEqual([])
    expect(p.feed(ASSISTANT)).toEqual([{ kind: 'text', text: '收到' }])
    expect(p.feed(RESULT_OK)).toEqual([{ kind: 'result', sessionId: '86e522b6-09a5-4651-a268-d176e67e6527' }])
    expect(p.flush()).toEqual([])
  })

  it('error results surface as error events', () => {
    const p = makeCursorStreamParser()
    expect(p.feed('{"type":"result","subtype":"error_during_execution","is_error":true,"result":"model overloaded","session_id":"s1"}'))
      .toEqual([{ kind: 'error', message: 'cursor-agent result error: model overloaded' }])
    expect(p.feed('{"type":"result","subtype":"failed","is_error":true,"session_id":"s1"}'))
      .toEqual([{ kind: 'error', message: 'cursor-agent result error: subtype=failed' }])
  })

  it('tool_use content blocks become tool_call events', () => {
    const p = makeCursorStreamParser()
    expect(p.feed('{"type":"assistant","message":{"content":[{"type":"tool_use","name":"reply"},{"type":"text","text":"好"}]}}'))
      .toEqual([{ kind: 'tool_call', tool: 'reply' }, { kind: 'text', text: '好' }])
  })

  it('garbage, unknown types and empty lines are silently skipped', () => {
    const p = makeCursorStreamParser()
    expect(p.feed('not json')).toEqual([])
    expect(p.feed('{"type":"future_thing","x":1}')).toEqual([])
    expect(p.feed('{"no_type":true}')).toEqual([])
    expect(p.feed('[]')).toEqual([])
  })
})

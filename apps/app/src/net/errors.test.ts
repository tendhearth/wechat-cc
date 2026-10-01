import { describe, it, expect } from 'vitest'
import { mapPhoneError, transportErrorCode } from './errors'

describe('mapPhoneError(HTTP 状态 + 正文 → BackendCode)', () => {
  it.each([
    [200, { ok: true }, null],
    [202, { ok: true, receipt: {} }, null],
    [409, { ok: false, error: 'permission_stale' }, 'stale'],
    [409, { ok: false, error: 'question_stale' }, 'stale'],
    [409, { ok: false, error: 'input_stale' }, 'stale'],
    [401, { error: 'unauthorized' }, 'revoked'],
    [401, null, 'revoked'],
    [404, { ok: false, error: 'matter_not_found' }, 'not_found'],
    [409, { ok: false, error: 'workbench_busy' }, 'busy'],
    [409, { ok: false, error: 'input_delivery_busy' }, 'busy'],
    [409, { ok: false, error: 'reply_sink_busy' }, 'busy'],
    [409, { ok: false, error: 'input_conflict' }, 'busy'],
    [409, { error: 'workbench_busy' }, 'busy'],
    [409, { ok: false, error: 'workbench_archived' }, 'unknown'],
    [400, { ok: false, error: 'invalid' }, 'invalid'],
    [400, { ok: false, error: 'invalid_answer' }, 'invalid'],
    [200, { ok: false, error: 'invalid_value' }, 'invalid'],
    [200, { ok: false, error: 'lan_only' }, 'unknown'],
    [503, { ok: false, error: 'insight_not_wired' }, 'unknown'],
    [500, null, 'unknown'],
    [403, { error: 'route_not_allowed' }, 'unknown'],
  ])('%s %j ⇒ %s', (status, body, want) => {
    expect(mapPhoneError(status, body)).toBe(want)
  })

  it.each([
    [409, { ok: false, error: 'native_session_busy' }, 'session_busy'],
    [409, { ok: false, error: 'native_folder_busy' }, 'folder_busy'],
    [503, { ok: false, error: 'unavailable_provider' }, 'provider_missing'],
    [400, { ok: false, error: 'invalid_path' }, 'folder_missing'],
    [503, { ok: false, error: 'provider_quota_exhausted' }, 'quota'],
    [409, { ok: false, error: 'native_history_changed' }, 'unknown'],
    [409, { ok: false, error: 'native_history_empty' }, 'unknown'],
    [409, { ok: false, error: 'native_session_already_managed' }, 'unknown'],
    [400, { ok: false, error: 'invalid_text' }, 'invalid'],
  ] as const)('接着做电脑会话的码(spec D11):%s %j ⇒ %s', (status, body, want) => {
    expect(mapPhoneError(status, body)).toBe(want)
  })
  it('daemon 没接推送(push_not_wired,503)⇒ unavailable', () => {
    expect(mapPhoneError(503, { ok: false, error: 'push_not_wired' })).toBe('unavailable')
  })
  it('跟 CC 说 / 连接 / 会话的错误码', () => {
    expect(mapPhoneError(409, { ok: false, error: 'chat_busy' })).toBe('busy')
    expect(mapPhoneError(404, { ok: false, error: 'no_owner_chat' })).toBe('not_found')
    expect(mapPhoneError(404, { ok: false, error: 'unsupported' })).toBe('not_found')
    for (const e of ['chat_not_wired', 'connections_not_wired', 'sessions_not_wired']) expect(mapPhoneError(503, { ok: false, error: e })).toBe('unavailable')
    expect(mapPhoneError(503, { ok: false, error: 'unavailable' })).toBe('unavailable')
    expect(mapPhoneError(500, { ok: false, error: 'unavailable' })).toBe('unknown')
  })
})

describe('transportErrorCode(协议客户端拒绝的原因 → BackendCode)', () => {
  it.each([
    ['auth_failed', 'revoked'],
    ['timeout', 'timeout'],
    ['unreachable', 'offline'],
    ['daemon_offline', 'offline'],
    ['closed', 'offline'],
    ['stream_unknown', 'offline'],
    ['rate_limited', 'offline'],
    ['frame_too_large', 'unknown'],
    ['binary_body_needs_v2', 'unknown'],
    ['something new', 'offline'],
  ])('%s ⇒ %s', (msg, want) => {
    expect(transportErrorCode(new Error(msg))).toBe(want)
  })
  it('不是 Error ⇒ offline', () => { expect(transportErrorCode('x')).toBe('offline') })
})

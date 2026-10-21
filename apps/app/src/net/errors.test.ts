import { describe, it, expect } from 'vitest'
import { WORKBENCH_ERRORS, workbenchErrorHttp } from '@wechat-cc/protocol'
import { mapPhoneError, transportErrorCode } from './errors'

describe('mapPhoneError(HTTP 状态 + 正文 → BackendCode)', () => {
  it.each([
    [200, { ok: true }, null],
    [202, { ok: true, receipt: {} }, null],
    [409, { ok: false, error: 'permission_stale' }, 'stale'],
    [409, { ok: false, error: 'question_stale' }, 'stale'],
    [409, { ok: false, error: 'input_stale' }, 'input_stale'],
    [401, { error: 'unauthorized' }, 'revoked'],
    [401, null, 'revoked'],
    [404, { ok: false, error: 'matter_not_found' }, 'not_found'],
    [409, { ok: false, error: 'workbench_busy' }, 'busy'],
    [409, { ok: false, error: 'input_delivery_busy' }, 'busy'],
    [409, { ok: false, error: 'reply_sink_busy' }, 'busy'],
    [409, { ok: false, error: 'input_conflict' }, 'input_conflict'],
    [409, { error: 'workbench_busy' }, 'busy'],
    [409, { ok: false, error: 'workbench_archived' }, 'unknown'],
    [400, { ok: false, error: 'invalid' }, 'invalid'],
    [400, { ok: false, error: 'invalid_answer' }, 'invalid'],
    [200, { ok: false, error: 'invalid_value' }, 'invalid'],
    [200, { ok: false, error: 'lan_only' }, 'unknown'],
    [503, { ok: false, error: 'insight_not_wired' }, 'unknown'],
    [500, null, 'unknown'],
    [403, { error: 'route_not_allowed' }, 'unknown'],
    // 工作区脚本(2026-10-20):批准只在电脑上 / 在跑 / setup 跑完接着运行 / 没有 run 脚本
    [428, { ok: false, error: 'script_needs_computer' }, 'scripts_unapproved'],
    [409, { ok: false, error: 'script_running' }, 'script_running'],
    [409, { ok: false, error: 'script_setup_running' }, 'script_queued'],
    [422, { ok: false, error: 'no_scripts' }, 'no_scripts'],
    // 做到条件成立为止(2026-10-20):不能落到 invalid_ 前缀规则里
    [400, { ok: false, error: 'invalid_until' }, 'until_invalid'],
    [422, { ok: false, error: 'until_requires_worktree' }, 'until_requires_worktree'],
    [422, { ok: false, error: 'until_unattended_unsupported' }, 'until_unattended'],
    // 按住说话(2026-10-18)
    [422, { ok: false, error: 'stt_not_configured' }, 'stt_not_configured'],
    [503, { ok: false, error: 'stt_blocked' }, 'stt_blocked'],
    [502, { ok: false, error: 'stt_failed' }, 'stt_failed'],
    [504, { ok: false, error: 'stt_timeout' }, 'stt_failed'],
    [422, { ok: false, error: 'no_speech' }, 'no_speech'],
    [413, { ok: false, error: 'audio_too_large' }, 'too_large'],
    [503, { ok: false, error: 'voice_not_wired' }, 'unavailable'],
  ])('%s %j ⇒ %s', (status, body, want) => {
    expect(mapPhoneError(status, body)).toBe(want)
  })

  it.each([
    [409, { ok: false, error: 'native_session_busy' }, 'session_busy'],
    [409, { ok: false, error: 'native_folder_busy' }, 'folder_busy'],
    [503, { ok: false, error: 'unavailable_provider' }, 'provider_missing'],
    [400, { ok: false, error: 'invalid_path' }, 'folder_missing'],
    [503, { ok: false, error: 'provider_quota_exhausted' }, 'quota'],
    [409, { ok: false, error: 'native_history_changed' }, 'session_changed'],
    [409, { ok: false, error: 'native_history_empty' }, 'session_empty'],
    [409, { ok: false, error: 'native_session_already_managed' }, 'session_managed'],
    // 第一句时电脑那边的记录变了(终端里的 Claude Code 还在写)/ 原会话已不能直接接上:都是「会话刚变」,不是「没送到」
    [409, { ok: false, error: 'external_close_confirmation_stale' }, 'session_changed'],
    [409, { ok: false, error: 'restart_confirmation_required' }, 'session_changed'],
    [400, { ok: false, error: 'invalid_text' }, 'invalid'],
  ] as const)('接着做电脑会话的码(spec D11):%s %j ⇒ %s', (status, body, want) => {
    expect(mapPhoneError(status, body)).toBe(want)
  })
  it.each([
    [409, 'quota_handoff_not_needed'], [409, 'quota_handoff_changed'], [503, 'quota_handoff_unavailable'],
  ] as const)('额度交接(spec §7-3):%s %s ⇒ handoff_changed(重读详情,不说「没送到」)', (status, error) => {
    expect(mapPhoneError(status, { ok: false, error })).toBe('handoff_changed')
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

/**
 * 工作台错误码一张表(packages/protocol workbench-errors):daemon 在手机上会回的每个码,App 都得有个说法。
 * 下面这些是有意按通用说法走的(invalid_* ⇒「不对」,其余 ⇒「没做成」);表里加了手机码 ⇒ 要么在 errors.ts 里给一句,要么加进这里。
 */
const GENERIC = new Set([
  // 交办被拒
  'api_task_attachment_invalid', 'api_task_attachment_unsupported', 'api_task_input_invalid', 'attachment_changed', 'entry_expired', 'project_stale',
  'unattended_ack_required', 'workbench_attachments_unsupported', 'workbench_execution_unsupported',
  'invalid_context', 'invalid_entry', 'invalid_execution', 'invalid_provider', 'invalid_request_id', 'invalid_target', 'invalid_text', 'invalid_title',
  'invalid_entry_owner', 'invalid_managed_workspace', 'invalid_attachment_size',
  // 附件 / 分块上传
  'attachment_conflict', 'attachment_in_use', 'attachment_limit', 'attachment_scope', 'attachment_storage_limit',
  'upload_changed', 'upload_conflict', 'upload_discarded', 'upload_expired', 'upload_invalid_content', 'upload_limit', 'upload_not_found', 'upload_offset', 'upload_unfinished_limit',
  // 独立工作区
  'worktree_branch_exists', 'worktree_conflict', 'worktree_git_failed', 'issue_unattended_unsupported', 'worktree_open', 'worktree_project_missing', 'worktree_removed',
  // 其余
  'external_close_confirmation_required', 'restart_confirmation_stale', 'creation_conflict', 'entry_not_wired', 'managed_workspace_changed', 'managed_workspace_unavailable',
  'network_unprotected', 'workbench_stopping', 'artifact_changed', 'matter_say_unsupported', 'matter_task_required', 'workbench_archived',
])
describe('工作台错误码表 × App(daemon 在手机上会回的码都有说法)', () => {
  const phone = Object.keys(WORKBENCH_ERRORS).filter(code => WORKBENCH_ERRORS[code]!.phone !== undefined)
  it.each(phone)('%s', code => {
    const { status, error } = workbenchErrorHttp(code, 'phone')
    const mapped = mapPhoneError(status, { ok: false, error })
    if (GENERIC.has(code)) expect(['unknown', 'invalid'], code).toContain(mapped)
    else expect(['unknown', 'invalid'], code).not.toContain(mapped)
  })
  it('GENERIC 里没有表外的码', () => {
    expect([...GENERIC].filter(code => !phone.includes(code))).toEqual([])
  })
})

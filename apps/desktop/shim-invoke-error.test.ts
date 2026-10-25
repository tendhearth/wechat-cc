import { describe, expect, it } from 'vitest'
import { invokeErrorMessage } from './shim-invoke-error.js'

describe('shim invoke 的错误串与 lib.rs 一致', () => {
  it('daemon_request:只有 rewind_* 带 reason 才拼', () => {
    expect(invokeErrorMessage('daemon_request', 422, JSON.stringify({ error: 'rewind_unavailable', reason: 'no_checkpoint' }))).toBe('rewind_unavailable:no_checkpoint')
    expect(invokeErrorMessage('daemon_request', 409, JSON.stringify({ error: 'rewind_noop' }))).toBe('rewind_noop')
    expect(invokeErrorMessage('daemon_request', 409, JSON.stringify({ error: 'workbench_busy', reason: 'x' }))).toBe('workbench_busy')
    expect(invokeErrorMessage('daemon_request', 428, JSON.stringify({ error: 'unattended_ack_required', reason: 'y' }))).toBe('unattended_ack_required')
    expect(invokeErrorMessage('daemon_request', 500, 'oops')).toBe('HTTP 500')
  })
  it('别的命令一律原样', () => {
    expect(invokeErrorMessage('pet_permission_resolve', 422, JSON.stringify({ error: 'rewind_unavailable', reason: 'z' }))).toBe('rewind_unavailable')
    expect(invokeErrorMessage('daemon_request', 400, JSON.stringify({ error: 'invalid', reason: 'z' }))).toBe('invalid')
  })
  it('toString 出来的源码能在页面里直接跑', () => {
    const fn = new Function(`${invokeErrorMessage.toString()}; return invokeErrorMessage`)() as typeof invokeErrorMessage
    expect(fn('daemon_request', 422, JSON.stringify({ error: 'rewind_x', reason: 'r' }))).toBe('rewind_x:r')
  })
})

import { describe, expect, it } from 'vitest'
import { DAEMON_DOWN_TEXT, daemonErrorText, isDaemonDownError } from './daemon-errors.js'

describe('daemon 没起时说什么(架构终态 F6)', () => {
  it('宿主 / api.js / dev 代理报的「连不上 daemon」都认成没在运行', () => {
    for (const msg of [
      'read /Users/x/.claude/channels/wechat/internal-api-info.json: No such file or directory (os error 2)',
      'request error: error sending request for url (http://127.0.0.1:51234/v1/memory/files)',
      'daemon not running (internal-api-info.json not found)',
      'workbench_connection_unavailable',
      'daemon info unavailable',
    ]) expect(isDaemonDownError(msg), msg).toBe(true)
  })
  it('daemon 在、只是这一下出错的,原样给(超时、业务码、HTTP 码)', () => {
    for (const msg of ['request timed out', 'memory_no_owner', 'HTTP 500', 'thread not found: thr_1']) expect(isDaemonDownError(msg), msg).toBe(false)
    expect(daemonErrorText(new Error('HTTP 500'))).toBe('HTTP 500')
    expect(daemonErrorText(new Error('request error: connection refused'))).toBe(DAEMON_DOWN_TEXT)
  })
})

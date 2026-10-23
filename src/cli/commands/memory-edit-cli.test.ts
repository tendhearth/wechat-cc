import { afterEach, describe, expect, it, vi } from 'vitest'
import { printEditResult } from './memory'

describe('memory view / edit 的退出码(桌面经 wechat_cli_json 只读退出码 0 的 stdout)', () => {
  afterEach(() => { process.exitCode = 0; vi.restoreAllMocks() })
  const bulk = { ok: false, code: 'memory_edit_bulk', count: 6, deleted: 2, rewritten: 4 }

  it('--json + 业务拒绝 ⇒ 退出码 0,载荷原样在 stdout', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    printEditResult({ body: bulk }, true)
    expect(process.exitCode ?? 0).toBe(0)
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toEqual(bulk)
  })
  it.each(['memory_no_owner', 'memory_edit_failed', 'daemon_required', 'daemon_unreachable', 'bad_lines'])('--json + %s ⇒ 也是 0', code => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    printEditResult({ body: { ok: false, code } }, true)
    expect(process.exitCode ?? 0).toBe(0)
  })
  it('没有 --json(人在终端)⇒ 失败退 1,成功 0', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    printEditResult({ body: bulk }, false)
    expect(process.exitCode).toBe(1)
    process.exitCode = 0
    printEditResult({ body: { ok: true } }, false)
    expect(process.exitCode ?? 0).toBe(0)
  })
})

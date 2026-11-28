import { expect, it, vi } from 'vitest'
import { recordShipFailure } from './self-ship-runtime'
import { SHIP_EXIT } from './self-ship'

it.each(['health', 'plugins', 'polling'])('records a manual ship that swaps and fails the %s gate', name => {
  const record = vi.fn()
  const source = { automatic: false, knownSource: true }
  const result = { exitCode: SHIP_EXIT.deploy_failed, message: '已自动回滚' }
  const deployed = { ok: false, exitCode: 1 as const, rolledBack: true,
    steps: [{ name: 'swap', ok: true }, { name, ok: false }, { name: 'rollback_health', ok: true }] }
  expect(recordShipFailure(result, deployed, source, record, vi.fn())).toEqual(result)
  expect(record).toHaveBeenCalledExactlyOnceWith('deploy')
  record.mockClear()
  recordShipFailure(result, deployed, { ...source, knownSource: false }, record, vi.fn())
  recordShipFailure(result, { ...deployed, steps: [{ name: 'swap', ok: false }] }, source, record, vi.fn())
  recordShipFailure({ ...result, blocked: 'tasks' }, deployed, source, record, vi.fn())
  expect(record).not.toHaveBeenCalled()
})

it.each([
  { exitCode: SHIP_EXIT.selftest_red, message: '自检红，已回滚到上一版。' },
  { exitCode: SHIP_EXIT.selftest_red, message: '自检红，回滚也没成。' },
])('preserves the deployment outcome when recording fails', result => {
  const log = vi.fn()
  expect(recordShipFailure(result, undefined, { automatic: false, knownSource: true }, () => {
    throw new Error('无法写失败账')
  }, log)).toEqual({ ...result, ledgerError: '部署失败账不可用：无法写失败账' })
  expect(log).toHaveBeenCalledExactlyOnceWith('部署失败账不可用：无法写失败账')
})

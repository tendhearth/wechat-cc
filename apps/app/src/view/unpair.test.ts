import { describe, it, expect } from 'vitest'
import { BackendError } from '../backend/types'
import { unpairNotice } from './unpair'

describe('unpairNotice', () => {
  it('成功 / 已被电脑撤销 ⇒ 不提示', () => {
    expect(unpairNotice(null)).toBe('none')
    expect(unpairNotice(new BackendError('revoked'))).toBe('none')
  })
  it('离线 / 超时 ⇒ 电脑那边仍列着', () => {
    expect(unpairNotice(new BackendError('offline'))).toBe('computerStillLists')
    expect(unpairNotice(new BackendError('timeout'))).toBe('computerStillLists')
  })
  it('其它错误(含非 BackendError)⇒ 中性提示', () => {
    expect(unpairNotice(new BackendError('unknown'))).toBe('neutral')
    expect(unpairNotice(new Error('boom'))).toBe('neutral')
  })
})

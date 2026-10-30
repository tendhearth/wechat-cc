import { describe, expect, it } from 'vitest'
import { formatCompanionStatus } from './companion-status.js'
import { presenceToPet } from './pet/bridge/presence-map.js'

describe('companion current activity text', () => {
  it('preserves the existing connected idle status and image label', () => {
    expect(formatCompanionStatus({ form: 'lit', behavior: 'idle' }, 0)).toEqual({ text: '已连接', ariaLabel: 'CC，已连接' })
  })

  it.each([
    ['thinking', '已连接 · 想一想', 'CC，已连接，想一想'],
    ['working', '已连接 · 正在做', 'CC，已连接，正在做'],
    ['companion', '已连接 · 陪伴中', 'CC，已连接，陪伴中'],
    ['permission', '已连接 · 等你决定', 'CC，已连接，等你决定'],
  ])('exposes the current %s fact without requiring visible motion', (behavior, text, ariaLabel) => {
    expect(formatCompanionStatus({ form: 'lit', behavior }, 0)).toEqual({ text, ariaLabel })
  })

  it.each(['visiting', 'hosting_human', 'hosting_peer'])('describes %s as companionship without claiming a host role', kind => {
    const intent = presenceToPet({
      presence: 'ok',
      activity: { kind, label: 'private backend description', since: null },
      news: { unread: 0, latest_kind: null, latest_title: null },
    }, null)
    expect(formatCompanionStatus(intent, 0)).toEqual({ text: '已连接 · 陪伴中', ariaLabel: 'CC，已连接，陪伴中' })
  })

  it.each(['idle', 'thinking', 'working', 'companion'])('gives a current pending permission precedence over %s', behavior => {
    expect(formatCompanionStatus({ form: 'lit', behavior }, 2)).toEqual({ text: '已连接 · 等你决定', ariaLabel: 'CC，已连接，等你决定' })
  })

  it.each(['idle', 'thinking', 'working', 'companion', 'permission'])('Dark hides stale %s facts, including pending permission', behavior => {
    expect(formatCompanionStatus({ form: 'unlit', behavior }, 3)).toEqual({ text: '暂时联系不上', ariaLabel: 'CC，暂时联系不上' })
  })

  it.each(['receive', 'done', 'blink', 'look', 'error', 'drag', 'wake', 'sleep', 'unrecognized', 'toString'])('never invents progress from decorative or unknown %s behavior', behavior => {
    expect(formatCompanionStatus({ form: 'lit', behavior }, 0)).toEqual({ text: '已连接', ariaLabel: 'CC，已连接' })
  })

  it.each([null, undefined, 'backend label', {}, { form: 'unknown', behavior: 'working' }])('falls back to connection-only text for unknown input %j', intent => {
    expect(formatCompanionStatus(intent, 1)).toEqual({ text: '暂时联系不上', ariaLabel: 'CC，暂时联系不上' })
  })

  it.each([-1, NaN, Infinity, '2', null, 0.5])('does not manufacture a pending permission from malformed count %j', count => {
    expect(formatCompanionStatus({ form: 'lit', behavior: 'idle' }, count)).toEqual({ text: '已连接', ariaLabel: 'CC，已连接' })
  })

  it('ignores backend titles, hints, contents and decorative events and repeats stable bounded text', () => {
    const fact = { form: 'lit', behavior: 'working', hint: 'private path /secret', title: 'private task'.repeat(1000), oneShots: ['done', 'receive'], props: ['laptop'] }
    expect(formatCompanionStatus(fact, 0)).toEqual({ text: '已连接 · 正在做', ariaLabel: 'CC，已连接，正在做' })
    expect(formatCompanionStatus({ ...fact, hint: 'different backend label', oneShots: [] }, 0)).toEqual({ text: '已连接 · 正在做', ariaLabel: 'CC，已连接，正在做' })
  })
})

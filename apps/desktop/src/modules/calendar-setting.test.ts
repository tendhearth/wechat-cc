// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest'
import { wireCalendarSetting } from './calendar-setting.js'

beforeEach(() => {
  document.body.innerHTML = `
    <button id="calendar-toggle" aria-pressed="false" disabled></button>
    <span id="calendar-toggle-feedback" role="status"></span>`
})

const button = () => document.querySelector<HTMLButtonElement>('#calendar-toggle')!
const feedback = () => document.getElementById('calendar-toggle-feedback')!.textContent

it('重新打开设置时只应用最新的状态', async () => {
  let finishFirstRead!: (value: unknown) => void
  const firstRead = new Promise(resolve => { finishFirstRead = resolve })
  const call = vi.fn().mockReturnValueOnce(firstRead).mockResolvedValueOnce({ enabled: false, permission: 'unavailable' })
  const refresh = wireCalendarSetting(call)
  const oldRefresh = refresh()
  expect(button().disabled).toBe(true)
  await refresh()
  finishFirstRead({ enabled: true, permission: 'granted' })
  await oldRefresh
  expect(call.mock.calls).toEqual([['GET', '/v1/calendar/status'], ['GET', '/v1/calendar/status']])
  expect(button().getAttribute('aria-pressed')).toBe('false')
  expect(feedback()).toBe('这台电脑目前读不了日历和提醒。')
})

it('等授权时保留原状态，并阻止重复提交', async () => {
  let finishAuthorization!: (value: unknown) => void
  const authorization = new Promise(resolve => { finishAuthorization = resolve })
  const call = vi.fn().mockResolvedValueOnce({ enabled: false, permission: 'not_determined' }).mockReturnValueOnce(authorization)
  const refresh = wireCalendarSetting(call)
  await refresh()
  button().click()
  expect(feedback()).toBe('正在请求授权…')
  expect(button().disabled).toBe(true)
  expect(button().getAttribute('aria-pressed')).toBe('false')
  button().click()
  await refresh()
  expect(call.mock.calls).toEqual([['GET', '/v1/calendar/status'], ['POST', '/v1/calendar/enabled', { on: true }]])
  finishAuthorization({ enabled: true, permission: 'granted', text: '日历和提醒事项开了。' })
  await vi.waitFor(() => expect(button().getAttribute('aria-pressed')).toBe('true'))
  expect(button().disabled).toBe(false)
  expect(feedback()).toBe('开着，Mac 已授权。')
})

it('原先开启后系统授权被撤回，仍能关掉 CC 的设置', async () => {
  const text = 'CC 不再读。系统里的授权要收回，去『系统设置 → 隐私与安全性 → 日历 / 提醒事项』。'
  const call = vi.fn().mockResolvedValueOnce({ enabled: true, permission: 'denied' }).mockResolvedValueOnce({ enabled: false, text })
  await wireCalendarSetting(call)()
  expect(button().getAttribute('aria-pressed')).toBe('true')
  expect(feedback()).toContain('Mac 没给权限。')
  button().click()
  await vi.waitFor(() => expect(feedback()).toBe(text))
  expect(call).toHaveBeenLastCalledWith('POST', '/v1/calendar/enabled', { on: false })
  expect(button().getAttribute('aria-pressed')).toBe('false')
})

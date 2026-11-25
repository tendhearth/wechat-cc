import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { calendarRoutes } from './routes'
import { createInternalApi, type InternalApi } from '../../daemon/internal-api'
import { minTierFor, moduleFor } from '../../daemon/internal-api/route-tiers'
import type { SubsystemStatus } from '../../daemon/subsystems'
import { makeCalendar, makeCalendarCommand, type Calendar } from './calendar'

const q = (s = '') => new URLSearchParams(s)
const cal = (agenda: Calendar['agenda']) => ({ agenda } as unknown as Calendar)

describe('GET /v1/calendar/agenda(读日历,对标 #8)', () => {
  it('offset 0 / 1 only (default 0); returns the same text as the 日历 command; admin tier; mounted by the calendar module', async () => {
    const agenda = vi.fn(async (o: 0 | 1) => ({ ok: true as const, text: o === 0 ? '- 10:00–11:00 评审(工作)' : '' }))
    const r = calendarRoutes(cal(agenda))['GET /v1/calendar/agenda']!
    expect(await r(q(), undefined)).toEqual({ status: 200, body: { ok: true, text: '今天的安排:\n- 10:00–11:00 评审(工作)' } })
    expect(await r(q('offset=1'), undefined)).toEqual({ status: 200, body: { ok: true, text: '明天日历和提醒事项里都没有安排。' } })
    expect(agenda).toHaveBeenLastCalledWith(1)
    expect(await r(q('offset=7'), undefined)).toEqual({ status: 400, body: { error: 'invalid_offset' } })
    expect(minTierFor('GET /v1/calendar/agenda')).toBe('admin')
    expect(moduleFor('GET /v1/calendar/agenda')).toBe('calendar')
  })
  it('没授权照实说(不说成没安排)', async () => {
    const r = calendarRoutes(cal(async () => ({ ok: false as const, reason: 'denied' as const })))['GET /v1/calendar/agenda']!
    const res = await r(q(), undefined) as { body: { text: string } }
    expect(res.body.text).toMatch(/权限/)
  })
  it('throws ⇒ 503 unavailable', async () => {
    const r = calendarRoutes(cal(async () => { throw new Error('osascript') }))['GET /v1/calendar/agenda']!
    expect(await r(q(), undefined)).toEqual({ status: 503, body: { error: 'unavailable' } })
  })
})

describe('桌面日历偏好经内部 API', () => {
  let stateDir: string
  let api: InternalApi | undefined
  let subsystems: SubsystemStatus[]
  const where = { name: 'calendar', sinceIso: '2026-11-25T00:00:00Z' }
  const granted = '{"events":3,"reminders":3}'
  const undecided = '{"events":0,"reminders":0}'
  const denied = '{"events":2,"reminders":2}'
  const statusPath = '/v1/calendar/status'
  const enabledPath = '/v1/calendar/enabled'

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'calendar-routes-'))
    subsystems = [{ ...where, state: 'ok' }]
  })

  afterEach(async () => {
    await api?.stop()
    api = undefined
    rmSync(stateDir, { recursive: true, force: true })
  })

  async function start({ permission = undecided, afterRequest = granted, mount = true } = {}) {
    const run = vi.fn(async (_cmd: string, args: string[]) => {
      if (args.at(-1)?.includes('requestFullAccess')) permission = afterRequest
      return { code: 0, stdout: permission, stderr: '', timedOut: false }
    })
    const calendar = makeCalendar({
      stateDir, run, platform: 'darwin', bundleHasUsage: () => true,
      now: () => 0, timezone: () => 'Asia/Shanghai', log: () => {},
    })
    const enable = vi.spyOn(calendar, 'enable')
    const disable = vi.spyOn(calendar, 'disable')
    api = createInternalApi({ stateDir, daemonPid: 1, subsystems: () => subsystems })
    if (mount) api.mount('calendar', calendarRoutes(calendar))
    const { port, tokenFilePath, operatorTokenFilePath } = await api.start()
    const operator = readFileSync(operatorTokenFilePath, 'utf8').trim()
    const trusted = readFileSync(tokenFilePath, 'utf8').trim()
    function request(path: string, body?: unknown, token = operator) {
      return fetch(`http://127.0.0.1:${port}${path}`, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
      })
    }
    return { request, calendar, run, trusted, enable, disable }
  }

  it.each([
    [granted, 'granted'], [undecided, 'not_determined'], [denied, 'denied'], ['{}', 'unavailable'],
  ])('GET status 报告 %s 对应的权限 %s，且不请求授权', async (permission, expected) => {
    const { request, run, enable } = await start({ permission })
    const response = await request(statusPath)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ enabled: false, permission: expected })
    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0]![1].at(-1)).not.toContain('requestFullAccess')
    expect(enable).not.toHaveBeenCalled()
  })

  it('POST 开启请求授权并落盘，关闭沿用微信回复且不请求授权', async () => {
    const { request, calendar, run, enable, disable } = await start()
    const opened = await request(enabledPath, { on: true })
    expect(opened.status).toBe(200)
    expect(await opened.json()).toEqual({
      enabled: true, permission: 'granted',
      text: '好,日历和提醒事项开了:早报里会有今天的安排,说「日历」/「日历 明天」也能看。只读,不会改你的日历。日程和提醒的标题会交给回你话的那个模型。',
    })
    expect(enable).toHaveBeenCalledOnce()
    expect(run).toHaveBeenCalledTimes(2)
    expect(run.mock.calls[1]![1].at(-1)).toContain('requestFullAccess')
    expect(await (await request(statusPath)).json()).toEqual({ enabled: true, permission: 'granted' })

    run.mockClear()
    const closed = await request(enabledPath, { on: false })
    expect(closed.status).toBe(200)
    const say = vi.fn(async () => {})
    const command = makeCalendarCommand({ calendar, isOwner: () => true, say })
    expect(disable).toHaveBeenCalledOnce()
    expect(calendar.enabled()).toBe(false)
    expect(run).not.toHaveBeenCalled()
    await command.handle('日历 关', 'owner')
    const text = 'CC 不再读。系统里的授权要收回，去『系统设置 → 隐私与安全性 → 日历 / 提醒事项』。'
    expect(say).toHaveBeenCalledWith('owner', text)
    expect(await closed.json()).toEqual({ enabled: false, text })
  })

  it('POST 开启被拒时返回现有提示，开关保持关着', async () => {
    const { request } = await start({ afterRequest: denied })
    const response = await request(enabledPath, { on: true })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ enabled: false, permission: 'denied', text: expect.stringContaining('系统设置 → 隐私与安全性') })
  })

  it('POST 拒绝非布尔值，且不调用开关', async () => {
    const { request, enable, disable } = await start()
    const response = await request(enabledPath, { on: 'false' })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: 'invalid_request' })
    expect(enable).not.toHaveBeenCalled()
    expect(disable).not.toHaveBeenCalled()
  })

  it('两条路由拒绝非 admin 令牌', async () => {
    const { request, trusted, run } = await start()
    for (const response of [await request(statusPath, undefined, trusted), await request(enabledPath, { on: true }, trusted)]) {
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({ error: 'forbidden', required: 'admin' })
    }
    expect(run).not.toHaveBeenCalled()
  })

  it.each([
    ['off', 'module_off'], ['degraded', 'module_degraded'], ['ok', 'module_starting'],
  ] as const)('模块状态 %s 时两条路由返回 %s', async (state, error) => {
    subsystems = [{ ...where, state }]
    const { request, run } = await start({ mount: false })
    for (const response of [await request(statusPath), await request(enabledPath, { on: true })]) {
      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({ error, module: 'calendar' })
    }
    expect(run).not.toHaveBeenCalled()
  })
})

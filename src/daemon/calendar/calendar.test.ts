import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeCalendar, makeCalendarCommand, parseCalendarCommand } from './calendar'

const ok = (stdout: string) => ({ code: 0, stdout, stderr: '', timedOut: false })
const GRANTED = '{"events":3,"reminders":3}', UNDECIDED = '{"events":0,"reminders":0}', DENIED = '{"events":2,"reminders":2}'
const READ = JSON.stringify({ events: [{ title: '设计评审', start: Date.parse('2026-10-21T10:00:00+08:00'), end: Date.parse('2026-10-21T11:00:00+08:00'), allDay: false, calendar: '工作' }], reminders: [] })

function setup(o: { platform?: string; usage?: boolean; status?: string; afterRequest?: string; read?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cal-'))
  const calls: string[] = []
  let status = o.status ?? UNDECIDED
  const run = vi.fn(async (_cmd: string, args: string[]) => {
    const s = args[args.length - 1]!
    if (s.includes('requestFullAccess')) { calls.push('request'); status = o.afterRequest ?? GRANTED; return ok(status) }
    if (s.includes('eventsMatchingPredicate')) { calls.push('read'); return ok(o.read ?? READ) }
    calls.push('status'); return ok(status)
  })
  const log = vi.fn()
  const cal = makeCalendar({ stateDir: dir, run, platform: o.platform ?? 'darwin', bundleHasUsage: () => o.usage ?? true, now: () => Date.parse('2026-10-21T07:30:00+08:00'), timezone: () => 'Asia/Shanghai', log })
  return { cal, calls, run, log, setStatus: (x: string) => { status = x } }
}

describe('makeCalendar', () => {
  it('off by default ⇒ agenda is null and nothing runs', async () => {
    const s = setup({ status: GRANTED })
    expect(await s.cal.agenda(0)).toEqual({ ok: false, reason: 'off' })
    expect(s.calls).toEqual([])
  })
  it('enable on a bundle without usage strings ⇒ never requests; says a newer app is needed', async () => {
    const s = setup({ usage: false })
    const r = await s.cal.enable()
    expect(r.status).toBe('unavailable')
    expect(r.text).toContain('1.7.8')
    expect(s.calls).not.toContain('request')
  })
  it('not a Mac ⇒ unavailable, nothing runs', async () => {
    const s = setup({ platform: 'win32' })
    expect((await s.cal.enable()).text).toContain('只在 Mac 上')
    expect(s.calls).toEqual([])
  })
  it('enable ⇒ requests once, says where titles go; then agenda reads', async () => {
    const s = setup()
    const r = await s.cal.enable()
    expect(r.status).toBe('granted')
    expect(r.text).toContain('标题会交给回你话的那个模型')
    expect(s.calls).toEqual(['status', 'request'])
    const a = await s.cal.agenda(0)
    expect(a).toEqual({ ok: true, text: '- 10:00–11:00 设计评审(工作)' })
    expect(s.calls.slice(-2)).toEqual(['status', 'read'])
  })
  it('denied ⇒ never requests again; says exactly where to go', async () => {
    const s = setup({ status: DENIED })
    const r = await s.cal.enable()
    expect(r.status).toBe('denied')
    expect(r.text).toContain('系统设置 → 隐私与安全性')
    expect(s.calls).not.toContain('request')
    expect(s.cal.enabled()).toBe(false)
  })
  it('access withdrawn in System Settings after it was on ⇒ the reason, never "nothing today", no read', async () => {
    const s = setup({ status: GRANTED })
    await s.cal.enable()
    s.setStatus(DENIED)
    expect(await s.cal.agenda(0)).toEqual({ ok: false, reason: 'denied' })
    s.setStatus(UNDECIDED)
    expect(await s.cal.agenda(0)).toEqual({ ok: false, reason: 'not_determined' })
    expect(s.calls).not.toContain('read')
  })
  it('a prompt that was not answered ⇒ switch stays off, asks to try again', async () => {
    const s = setup({ status: UNDECIDED, afterRequest: UNDECIDED })
    const r = await s.cal.enable()
    expect(r.text).toContain('点「允许」')
    expect(s.cal.enabled()).toBe(false)
  })
  it('read failure ⇒ reason, and titles never go to the log', async () => {
    const s = setup({ status: GRANTED, read: 'garbage' })
    await s.cal.enable()
    expect(await s.cal.agenda(0)).toEqual({ ok: false, reason: 'read_failed' })
    const s3 = setup({ status: GRANTED })
    await s3.cal.enable(); await s3.cal.agenda(0)
    expect(JSON.stringify(s3.log.mock.calls)).not.toContain('设计评审')
  })
  it('disable ⇒ off again; the switch survives a restart', async () => {
    const s = setup({ status: GRANTED })
    await s.cal.enable()
    expect(s.cal.enabled()).toBe(true)
    s.cal.disable()
    expect(s.cal.enabled()).toBe(false)
  })
})

describe('日历 command', () => {
  it('parses', () => {
    expect(parseCalendarCommand('日历')).toEqual({ op: 'show', offset: 0 })
    expect(parseCalendarCommand('日历 明天')).toEqual({ op: 'show', offset: 1 })
    expect(parseCalendarCommand('日历 开')).toEqual({ op: 'on' })
    expect(parseCalendarCommand('日历 关')).toEqual({ op: 'off' })
    expect(parseCalendarCommand('日历 状态')).toEqual({ op: 'status' })
    expect(parseCalendarCommand('日历真好看')).toBeNull()
    expect(parseCalendarCommand('今天日历')).toBeNull()
  })
  it('owner only; replies the agenda', async () => {
    const s = setup({ status: GRANTED })
    const said: string[] = []
    const cmd = makeCalendarCommand({ calendar: s.cal, isOwner: c => c === 'owner', say: async (_c, t) => { said.push(t) } })
    expect(cmd.probe('日历', 'guest')).toBe(false)
    expect(cmd.probe('日历', 'owner')).toBe(true)
    await cmd.handle('日历 开', 'owner')
    await cmd.handle('日历', 'owner')
    expect(said.at(-1)).toContain('设计评审')
    expect(said.at(-1)).toContain('今天')
  })
  it('nothing on the calendar ⇒ says so plainly', async () => {
    const s = setup({ status: GRANTED, read: '{"events":[],"reminders":[]}' })
    const said: string[] = []
    const cmd = makeCalendarCommand({ calendar: s.cal, isOwner: () => true, say: async (_c, t) => { said.push(t) } })
    await cmd.handle('日历 开', 'o'); await cmd.handle('日历 明天', 'o')
    expect(said.at(-1)).toBe('明天日历和提醒事项里都没有安排。')
  })
})

// 读日历只在 macOS 上有(.app 包路径是 POSIX 的):Windows 上不跑这两组
describe.skipIf(process.platform === 'win32')('appBundleHasCalendarUsage', () => {
  it('reads Contents/Info.plist next to the running binary; missing key / not in a bundle ⇒ false', async () => {
    const { appBundleHasCalendarUsage } = await import('./calendar')
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const root = mkdtempSync(join(tmpdir(), 'app-'))
    const app = join(root, 'Tendhearth CC.app', 'Contents')
    mkdirSync(join(app, 'MacOS'), { recursive: true })
    const bin = join(app, 'MacOS', 'tendhearth-cc-cli')
    writeFileSync(join(app, 'Info.plist'), '<plist><dict><key>NSMicrophoneUsageDescription</key><string>x</string></dict></plist>')
    expect(appBundleHasCalendarUsage(bin)).toBe(false)
    writeFileSync(join(app, 'Info.plist'), '<plist><dict><key>NSCalendarsFullAccessUsageDescription</key><string>x</string><key>NSRemindersFullAccessUsageDescription</key><string>y</string></dict></plist>')
    expect(appBundleHasCalendarUsage(bin)).toBe(true)
    expect(appBundleHasCalendarUsage('/usr/local/bin/bun')).toBe(false)
  })
})

describe.skipIf(process.platform === 'win32')('appBundleHasCalendarUsage × 真的 Info.plist', () => {
  it('the Info.plist we ship passes the daemon check (the two cannot drift apart)', async () => {
    const { appBundleHasCalendarUsage } = await import('./calendar')
    const { mkdirSync, copyFileSync } = await import('node:fs')
    const app = join(mkdtempSync(join(tmpdir(), 'app-')), 'Tendhearth CC.app', 'Contents')
    mkdirSync(join(app, 'MacOS'), { recursive: true })
    copyFileSync(join(import.meta.dirname, '..', '..', '..', 'apps', 'desktop', 'src-tauri', 'Info.plist'), join(app, 'Info.plist'))
    expect(appBundleHasCalendarUsage(join(app, 'MacOS', 'tendhearth-cc-cli'))).toBe(true)
  })
})

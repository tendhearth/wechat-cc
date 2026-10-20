/**
 * 读日历和提醒(只读,spec 2026-10-20-calendar-read-design,对标 #8)。
 * 开关存 state/calendar.json;授权只在主人「日历 开」时请求;读之前先看状态 —— 没授权时 EventKit 读出来是空的,
 * 绝不能把「没权限」说成「今天没安排」。日志里不写标题。只进主人的轮次(早报 / 「日历」命令)。
 */
import { join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { readJsonFile } from '../../lib/read-json-file'
import { dayWindow, formatAgenda, parseRead, parseStatus, readScript, requestScript, statusScript, type CalendarStatus } from '../../core/calendar/eventkit'
import type { Runner } from '../cli-reply-handler'
import type { ReplyHandler } from '../scheduled-jobs/command'

export const CALENDAR_FILE = 'calendar.json'
const STATUS_MS = 15_000, READ_MS = 20_000, REQUEST_MS = 130_000
const SETTINGS_HINT = '去「系统设置 → 隐私与安全性 → 日历」和「提醒事项」,把 Tendhearth CC 打开,再说「日历 开」。'

export interface CalendarDeps {
  stateDir: string
  run: Runner
  platform: string
  /** 主 app 包的 Info.plist 里有没有日历用途说明(没有 ⇒ 系统会静默拒绝,别去请求)。 */
  bundleHasUsage: () => boolean
  now: () => number
  timezone: () => string
  log: (tag: string, line: string) => void
}

/**
 * 主 app 包的 Info.plist 里有没有日历 + 提醒的用途说明(1.7.8 起)。授权记在责任进程(app 主二进制)名下,
 * 用途说明缺了系统会静默拒绝 ⇒ 没有就别去请求。不在 .app 里跑(开发时)⇒ false。
 */
export function appBundleHasCalendarUsage(execPath: string): boolean {
  const m = /^(.*\.app\/Contents)\/MacOS\/[^/]+$/.exec(execPath)
  if (!m) return false
  const plist = join(m[1]!, 'Info.plist')
  if (!existsSync(plist)) return false
  const keys = ['NSCalendarsFullAccessUsageDescription', 'NSRemindersFullAccessUsageDescription']
  try {
    const raw = readFileSync(plist)
    if (raw.subarray(0, 6).toString() !== 'bplist') { const t = raw.toString('utf8'); return keys.every(k => t.includes(`<key>${k}</key>`)) }
    // 二进制 plist:交给 plutil
    return keys.every(k => spawnSync('plutil', ['-extract', k, 'raw', '-o', '-', plist], { stdio: 'ignore', windowsHide: true }).status === 0)
  } catch { return false }
}

export type AgendaResult = { ok: true; text: string } | { ok: false; reason: 'off' | 'unavailable' | 'not_determined' | 'denied' | 'read_failed' }

export function makeCalendar(deps: CalendarDeps) {
  const file = join(deps.stateDir, CALENDAR_FILE)
  // 文件没有 / 读不出 ⇒ 关着(默认关)
  const enabled = (): boolean => { try { return readJsonFile<{ enabled?: unknown }>(file)?.enabled === true } catch { return false } }
  const setEnabled = (on: boolean) => {
    mkdirSync(deps.stateDir, { recursive: true })
    const tmp = `${file}.tmp-${process.pid}`
    writeFileSync(tmp, JSON.stringify({ enabled: on }) + '\n')
    renameSync(tmp, file)
  }
  const osa = (script: string, ms: number) => deps.run('osascript', ['-l', 'JavaScript', '-e', script], deps.stateDir, ms)
  const available = () => deps.platform === 'darwin' && deps.bundleHasUsage()

  async function status(): Promise<CalendarStatus> {
    if (!available()) return 'unavailable'
    try {
      const r = await osa(statusScript(), STATUS_MS)
      return r.code === 0 && !r.timedOut ? parseStatus(r.stdout) : 'unavailable'
    } catch { return 'unavailable' }
  }
  const unavailableText = () => deps.platform !== 'darwin'
    ? '读日历只在 Mac 上有。'
    : '这一版的 Tendhearth CC 还不能读日历:要等新版本(1.7.8 起)装上,系统才肯给权限。装好再说「日历 开」。'

  return {
    enabled,
    status,
    /** 「日历 开」:可能在 Mac 上弹授权框(只有这一处会弹)。 */
    async enable(): Promise<{ status: CalendarStatus; text: string }> {
      if (!available()) return { status: 'unavailable', text: unavailableText() }
      let st = await status()
      if (st === 'denied') return { status: st, text: `系统没给 Tendhearth CC 读日历的权限。${SETTINGS_HINT}` }
      if (st === 'not_determined') {
        deps.log('CALENDAR', 'requesting EventKit full access (owner asked)')
        try {
          const r = await osa(requestScript(), REQUEST_MS)
          st = r.code === 0 && !r.timedOut ? parseStatus(r.stdout) : 'not_determined'
        } catch { st = 'not_determined' }
      }
      deps.log('CALENDAR', `status ${st}`)
      if (st === 'granted') {
        setEnabled(true)
        return { status: st, text: '好,日历和提醒事项开了:早报里会有今天的安排,说「日历」/「日历 明天」也能看。只读,不会改你的日历。日程和提醒的标题会交给回你话的那个模型。' }
      }
      if (st === 'denied') return { status: st, text: `没拿到权限。${SETTINGS_HINT}` }
      return { status: st, text: 'Mac 上应该弹了一个框,问能不能让 Tendhearth CC 读日历和提醒事项。点「允许」之后再说一次「日历 开」。' }
    },
    disable(): void { setEnabled(false) },
    /** 某一天的安排(0 今天、1 明天)。没开 / 没授权 / 读失败 ⇒ 原因,不当成「没安排」。 */
    async agenda(offsetDays: number): Promise<AgendaResult> {
      if (!enabled()) return { ok: false, reason: 'off' }
      const st = await status()
      if (st !== 'granted') return { ok: false, reason: st }
      try {
        const r = await osa(readScript(dayWindow(deps.now(), deps.timezone(), offsetDays)), READ_MS)
        const parsed = r.code === 0 && !r.timedOut ? parseRead(r.stdout) : null
        if (!parsed) { deps.log('CALENDAR', `read failed (code ${r.code}${r.timedOut ? ', timed out' : ''})`); return { ok: false, reason: 'read_failed' } }
        deps.log('CALENDAR', `read ${parsed.events.length} events, ${parsed.reminders.length} reminders`)
        return { ok: true, text: formatAgenda(parsed, deps.timezone()) }
      } catch { return { ok: false, reason: 'read_failed' } }
    },
  }
}
export type Calendar = ReturnType<typeof makeCalendar>

export type CalendarCommand = { op: 'show'; offset: 0 | 1 } | { op: 'on' } | { op: 'off' } | { op: 'status' }
export function parseCalendarCommand(text: string): CalendarCommand | null {
  const m = /^\s*日历(?:\s+(\S+))?\s*$/.exec(text)
  if (!m) return null
  const arg = m[1]
  if (!arg || arg === '今天') return { op: 'show', offset: 0 }
  if (arg === '明天') return { op: 'show', offset: 1 }
  if (arg === '开') return { op: 'on' }
  if (arg === '关') return { op: 'off' }
  if (arg === '状态') return { op: 'status' }
  return null
}

const REASON_TEXT: Record<Exclude<AgendaResult, { ok: true }>['reason'], string> = {
  off: '日历还没开。说「日历 开」,Mac 上会弹一个框问你允不允许。',
  unavailable: '这台电脑上现在读不了日历(要 Mac,和 1.7.8 起的 Tendhearth CC)。',
  not_determined: '还没拿到读日历的权限。说「日历 开」,Mac 上点「允许」。',
  denied: `系统没给 Tendhearth CC 读日历的权限。${SETTINGS_HINT}`,
  read_failed: '这次没读出来,过一会儿再试。',
}

/** 微信 / 桌面文本命令「日历 [今天|明天|开|关|状态]」:只认主人。 */
export function makeCalendarCommand(deps: { calendar: Calendar; isOwner: (chatId: string) => boolean; say: (chatId: string, text: string) => Promise<unknown> }): ReplyHandler {
  return {
    probe: (text, chatId) => parseCalendarCommand(text) !== null && deps.isOwner(chatId),
    async handle(text, chatId) {
      const c = parseCalendarCommand(text)
      if (!c || !deps.isOwner(chatId)) return false
      if (c.op === 'on') { await deps.say(chatId, (await deps.calendar.enable()).text); return true }
      if (c.op === 'off') { deps.calendar.disable(); await deps.say(chatId, '日历关了,CC 不再读。系统里的授权要收回,去「系统设置 → 隐私与安全性 → 日历 / 提醒事项」。'); return true }
      if (c.op === 'status') {
        const st = await deps.calendar.status()
        const word = { granted: '已授权', not_determined: '还没授权', denied: '被拒了', unavailable: '这台读不了' }[st]
        await deps.say(chatId, `日历:${deps.calendar.enabled() ? '开着' : '关着'};系统权限:${word}。`)
        return true
      }
      const day = c.offset === 0 ? '今天' : '明天'
      const a = await deps.calendar.agenda(c.offset)
      await deps.say(chatId, a.ok ? (a.text ? `${day}的安排:\n${a.text}` : `${day}日历和提醒事项里都没有安排。`) : REASON_TEXT[a.reason])
      return true
    },
  }
}

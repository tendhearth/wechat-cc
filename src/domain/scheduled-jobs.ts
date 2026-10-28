/**
 * scheduled-jobs — 主人亲手写的定时任务(spec 2026-10-20-scheduled-jobs-design):命令解析与到点判断。纯函数。
 *
 * 只收三种写法(每天 / 每周X / 工作日 + HH:MM);到点 = 当天没跑过、日子对、在约定时刻之后 10 分钟内 ——
 * 过了窗口就不算到点:daemon 睡着错过的,醒来不补跑。
 */
export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7
export type JobSchedule = { kind: 'daily'; at: string } | { kind: 'weekly'; at: string; weekday: Weekday } | { kind: 'weekdays'; at: string }
/** brief = 早报(对标 #7):正文由 CC 自己拼,同时只能有一个。recap = 周报(CC 这一周替主人做过的事),同理。 */
export interface ScheduledJob { id: string; schedule: JobSchedule; text: string; createdAt: string; paused: boolean; brief?: boolean; recap?: boolean }
export type JobCommand =
  | { kind: 'add'; schedule: JobSchedule; text: string; brief?: boolean; recap?: boolean }
  | { kind: 'list' }
  | { kind: 'pause' | 'resume' | 'remove'; id: string }
  | { kind: 'usage'; error: string }

export const JOB_TEXT_MAX = 500
export const JOB_DUE_WINDOW_MIN = 10
const WEEKDAY_CHARS: Record<string, Weekday> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 }
const WEEKDAY_NAMES = ['', '一', '二', '三', '四', '五', '六', '日']

export const JOB_USAGE = '定时的写法:\n· 定时 每天 8:30 <要做的事>\n· 定时 每周一 9:00 <要做的事>\n· 定时 工作日 18:00 <要做的事>\n· 定时 早报 8:00 · 定时 周报 20:00(每周日回顾 CC 这一周替你做了什么)\n· 定时(看列表)· 定时 停 / 开 / 删 <编号>\n定时那一轮只读:能看、能查,不改东西、不给别人发消息;没新东西就不吭声。'

function parseAt(raw: string): string | null {
  const m = /^(\d{1,2})[:：](\d{2})$/.exec(raw)
  if (!m) return null
  const h = Number(m[1]), min = Number(m[2])
  if (h > 23 || min > 59) return null
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`
}

export function parseJobCommand(text: string): JobCommand | null {
  const t = text.trim()
  if (t !== '定时' && !/^定时\s/.test(t)) return null
  const rest = t.slice(2).trim()
  if (rest === '' || rest === '列表') return { kind: 'list' }
  // 早报:定时 早报 [工作日] HH:MM
  const brief = /^早报(?:\s+(工作日))?(?:\s+(\S+))?$/.exec(rest)
  if (brief) {
    const at = brief[2] ? parseAt(brief[2]) : null
    if (!at) return { kind: 'usage', error: `早报的写法:定时 早报 8:00(每天)/ 定时 早报 工作日 8:00。\n\n${JOB_USAGE}` }
    return { kind: 'add', schedule: brief[1] ? { kind: 'weekdays', at } : { kind: 'daily', at }, text: '早报', brief: true }
  }
  // 周报:定时 周报 [周X] HH:MM(缺省周日)—— 「CC 做过的事」这一周的回顾
  const recap = /^周报(?:\s+周([一二三四五六日天]))?(?:\s+(\S+))?$/.exec(rest)
  if (recap) {
    const at = recap[2] ? parseAt(recap[2]) : null
    if (!at) return { kind: 'usage', error: `周报的写法:定时 周报 20:00(每周日)/ 定时 周报 周五 18:30。\n\n${JOB_USAGE}` }
    return { kind: 'add', schedule: { kind: 'weekly', at, weekday: WEEKDAY_CHARS[recap[1] ?? '日']! }, text: '周报', recap: true }
  }
  const ctl = /^(停|开|删)\s+(j\d+)$/i.exec(rest)
  if (ctl) return { kind: ctl[1] === '停' ? 'pause' : ctl[1] === '开' ? 'resume' : 'remove', id: ctl[2]!.toLowerCase() }
  const m = /^(每天|工作日|每周([一二三四五六日天]))\s+(\S+)(?:\s+([\s\S]+))?$/.exec(rest)
  if (!m) return { kind: 'usage', error: JOB_USAGE }
  const at = parseAt(m[3]!)
  if (!at) return { kind: 'usage', error: `时间「${m[3]}」看不懂,写成 9:00 这样。\n\n${JOB_USAGE}` }
  const body = (m[4] ?? '').trim()
  if (!body) return { kind: 'usage', error: `要做什么还没写。\n\n${JOB_USAGE}` }
  if ([...body].length > JOB_TEXT_MAX) return { kind: 'usage', error: `要做的事太长了(上限 ${JOB_TEXT_MAX} 字)。` }
  const schedule: JobSchedule = m[1] === '每天' ? { kind: 'daily', at } : m[1] === '工作日' ? { kind: 'weekdays', at } : { kind: 'weekly', at, weekday: WEEKDAY_CHARS[m[2]!]! }
  return { kind: 'add', schedule, text: body }
}

/** 'YYYY-MM-DD' 是星期几(1 = 周一 … 7 = 周日)。按日历算,与时区无关。 */
export function weekdayOf(day: string): Weekday {
  const d = new Date(`${day}T00:00:00Z`).getUTCDay()
  return (d === 0 ? 7 : d) as Weekday
}

function dayMatches(s: JobSchedule, day: string): boolean {
  if (s.kind === 'daily') return true
  const w = weekdayOf(day)
  return s.kind === 'weekly' ? w === s.weekday : w <= 5
}

const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5))

export function isJobDue(s: JobSchedule, local: { day: string; hhmm: string }, lastRunDay: string | null): boolean {
  if (lastRunDay === local.day || !dayMatches(s, local.day)) return false
  const late = minutes(local.hhmm) - minutes(s.at)
  return late >= 0 && late < JOB_DUE_WINDOW_MIN
}

/** 今天该跑、还没跑、窗口已经过了 —— 这一天就算错过了(记一笔,不补跑)。 */
export function windowPassed(s: JobSchedule, local: { day: string; hhmm: string }, lastRunDay: string | null): boolean {
  if (lastRunDay === local.day || !dayMatches(s, local.day)) return false
  return minutes(local.hhmm) - minutes(s.at) >= JOB_DUE_WINDOW_MIN
}

const TZ_NAMES: Record<string, string> = { 'Asia/Shanghai': '上海', 'Asia/Chongqing': '上海', 'Asia/Hong_Kong': '香港', 'Asia/Taipei': '台北', 'Asia/Tokyo': '东京', 'Asia/Singapore': '新加坡' }
/** 时区的短名:常见的写中文城市名,其余取 IANA 名的最后一段(下划线换空格)。 */
export function tzLabel(tz: string): string {
  return TZ_NAMES[tz] ?? (tz.split('/').pop() ?? tz).replace(/_/g, ' ')
}

/** 「每周一 09:00」;给了时区 ⇒「每周一 09:00(上海)」—— --at 按主人时区,回显里要看得见(10-20 真机核对)。 */
export function describeSchedule(s: JobSchedule, tz?: string): string {
  const base = s.kind === 'daily' ? `每天 ${s.at}` : s.kind === 'weekdays' ? `工作日 ${s.at}` : `每周${WEEKDAY_NAMES[s.weekday]} ${s.at}`
  return tz ? `${base}(${tzLabel(tz)})` : base
}

const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)

/** 下次什么时候跑:「今天 09:00」/「明天 09:00」/「10月26日(周一)09:00」。 */
export function nextRunLabel(s: JobSchedule, local: { day: string; hhmm: string }): string {
  for (let i = 0; i < 8; i++) {
    const day = addDays(local.day, i)
    if (!dayMatches(s, day)) continue
    if (i === 0) {
      const late = minutes(local.hhmm) - minutes(s.at)
      if (late < 0) return `今天 ${s.at}`
      if (late < JOB_DUE_WINDOW_MIN) return `马上(今天 ${s.at} 这次)`
      continue
    }
    if (i === 1) return `明天 ${s.at}`
    return `${Number(day.slice(5, 7))}月${Number(day.slice(8, 10))}日(周${WEEKDAY_NAMES[weekdayOf(day)]})${s.at}`
  }
  return s.at
}

export type BriefPref = { kind: 'add'; line: string } | { kind: 'show' } | { kind: 'clear' } | { kind: 'usage' }
export const BRIEF_PREF_MAX = 80
export const BRIEF_PREF_USAGE = '早报的口味:\n· 早报 少点 <什么>\n· 早报 多点 <什么>\n· 早报 偏好(看)· 早报 偏好 清空'

/** 「早报 少点 X / 多点 X / 偏好 / 偏好 清空」;不以「早报」整词开头 ⇒ null。 */
export function parseBriefPref(text: string): BriefPref | null {
  const t = text.trim()
  if (t !== '早报' && !/^早报\s/.test(t)) return null
  const rest = t.slice(2).trim()
  if (rest === '' || rest === '偏好') return { kind: 'show' }
  if (rest === '偏好 清空') return { kind: 'clear' }
  const m = /^(少点|多点)(?:\s+([\s\S]+))?$/.exec(rest)
  if (!m) return { kind: 'usage' }
  const what = (m[2] ?? '').trim()
  if (!what || [...what].length > BRIEF_PREF_MAX) return { kind: 'usage' }
  return { kind: 'add', line: `${m[1]}:${what}` }
}

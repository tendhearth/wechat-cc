// @ts-check

const DAY_MS = 86_400_000
const weekdays = { 'zh-Hans': ['周日', '周一', '周二', '周三', '周四', '周五', '周六'], en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] }
const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** 把本地日历日期映射到整天，跨夏令时也能比较天数。 @param {Date} date */
const calendarDay = date => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS
/** @param {number} n */
const pad = n => String(n).padStart(2, '0')

/**
 * @param {number | null} resetsAt
 * @param {number} now
 * @param {'zh-Hans' | 'en'} [lang]
 */
export function usageResetTime(resetsAt, now, lang = 'zh-Hans') {
  if (resetsAt === null || resetsAt <= now) return null
  const reset = new Date(resetsAt)
  const today = new Date(now)
  if (!Number.isFinite(reset.getTime()) || !Number.isFinite(today.getTime())) return null
  const days = calendarDay(reset) - calendarDay(today)
  if (days === 0) return `${pad(reset.getHours())}:${pad(reset.getMinutes())}`
  if (days <= 7) return weekdays[lang][reset.getDay()]
  const year = reset.getFullYear(), month = reset.getMonth(), day = reset.getDate()
  const sameYear = year === today.getFullYear()
  return lang === 'zh-Hans'
    ? `${sameYear ? '' : `${year}年`}${month + 1}月${day}日`
    : `${months[month]} ${day}${sameYear ? '' : `, ${year}`}`
}

/**
 * @param {{ usedPercent: number, resetsAt: number | null, durationMins: number | null }} usage
 * @param {number} now
 * @param {'zh-Hans' | 'en'} [lang]
 */
export function usageWindowDisplay(usage, now, lang = 'zh-Hans') {
  const zh = lang === 'zh-Hans'
  const minutes = usage.durationMins
  const period = minutes === 10080 ? (zh ? '本周' : 'This week')
    : minutes === null || minutes <= 0 ? (zh ? '额度' : 'Limit')
    : minutes % 60 === 0 ? `${minutes / 60}${zh ? ' 小时' : 'h'}`
    : `${minutes}${zh ? ' 分钟' : ' min'}`
  const percent = Math.min(100, Math.max(0, usage.usedPercent))
  const full = percent === 100
  const time = usageResetTime(usage.resetsAt, now, lang)
  const amount = full ? (zh ? '已用完' : 'Used up') : `${Math.min(99, Math.round(percent))}%`
  const reset = time ? (zh ? `${time}${time.includes(':') ? ' ' : ''}${full ? '恢复' : '重置'}` : `${full ? 'Available again' : 'Resets'} ${time}`) : null
  const label = `${period} ${amount}${reset ? `${full ? (zh ? '，' : ', ') : ' · '}${reset}` : ''}`
  return { label, percent, warning: percent > 80 }
}

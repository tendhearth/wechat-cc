import type { Lang } from '../i18n'

const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const calendarDay = (date: Date) => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())

/** Compare local calendar days so midnight and daylight saving transitions work alike. */
export function phoneTime(value: string | number | null | undefined, now: number, lang: Lang): string {
  if (value == null || value === '') return ''
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''

  const today = new Date(now)
  const days = (calendarDay(today) - calendarDay(date)) / 86_400_000
  const zh = lang === 'zh-Hans'
  if (days >= 0 && days <= 6) {
    const hour = date.getHours()
    const minute = String(date.getMinutes()).padStart(2, '0')
    const clock = zh ? `${String(hour).padStart(2, '0')}:${minute}` : `${hour % 12 || 12}:${minute} ${hour < 12 ? 'AM' : 'PM'}`
    if (days === 0) return clock
    if (days === 1) return `${zh ? '昨天' : 'Yesterday'} ${clock}`
    return `${zh ? `周${'日一二三四五六'[date.getDay()]}` : weekdays[date.getDay()]} ${clock}`
  }
  const monthDay = zh ? `${date.getMonth() + 1} 月 ${date.getDate()} 日` : `${months[date.getMonth()]} ${date.getDate()}`
  if (date.getFullYear() === today.getFullYear()) return monthDay
  return zh ? `${date.getFullYear()} 年 ${monthDay}` : `${monthDay}, ${date.getFullYear()}`
}

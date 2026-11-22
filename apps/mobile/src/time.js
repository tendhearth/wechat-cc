// 按手机的本地日历算相隔几天，跨夏令时或午夜也能正确显示「昨天」。
function mobileTime(value, now = Date.now()) {
  if (value == null || value === '') return ''
  var date = new Date(value), today = new Date(now)
  if (!Number.isFinite(date.getTime())) return ''
  var day = function(d) { return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) }
  var days = (day(today) - day(date)) / 864e5
  var clock = String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0')
  if (days === 0) return clock
  if (days === 1) return '昨天 ' + clock
  if (days >= 2 && days <= 7) return '周' + '日一二三四五六'[date.getDay()] + ' ' + clock
  var monthDay = (date.getMonth() + 1) + ' 月 ' + date.getDate() + ' 日'
  return date.getFullYear() === today.getFullYear() ? monthDay : date.getFullYear() + ' 年 ' + monthDay
}

function ago(value, now = Date.now()) {
  if (value == null || value === '') return ''
  var seconds = Math.max(0, now - new Date(value).getTime()) / 1000
  if (seconds < 60) return '刚刚'
  if (seconds < 3600) return Math.floor(seconds / 60) + ' 分钟前'
  if (seconds < 86400) return Math.floor(seconds / 3600) + ' 小时前'
  if (seconds <= 30 * 86400) return Math.floor(seconds / 86400) + ' 天前'
  return mobileTime(value, now)
}

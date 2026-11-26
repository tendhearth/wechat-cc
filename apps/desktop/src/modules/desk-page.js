// @ts-check
const digits = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九']

/** @param {number} n */
function chineseNumber(n) {
  if (n < 10) return digits[n]
  return (n >= 20 ? digits[Math.floor(n / 10)] : '') + '十' + (n % 10 ? digits[n % 10] : '')
}

/** @param {Date} date */
export function deskDate(date) {
  return `${chineseNumber(date.getMonth() + 1)}月${chineseNumber(date.getDate())}日 周${'日一二三四五六'[date.getDay()]}`
}

/** @param {number} waiting @param {number} moving */
export function deskSituation(waiting, moving) {
  const count = (/** @type {number} */ n) => n === 2 ? '两' : n <= 10 ? chineseNumber(n) : String(n)
  const lines = [waiting && `${count(waiting)}件要你定`, moving && `${count(moving)}件在做`].filter(Boolean)
  return lines.length ? lines.join('，') + '。' : '都安静，没有要你管的。'
}

/** @param {number|undefined} at */
export function messageDay(at) {
  if (typeof at !== 'number') return null
  const day = new Date(at)
  return Number.isFinite(day.getTime()) ? day : null
}

const DESK_CC_AVATAR = '<img src="./assets/pet/cc-v1/canonical/lit/front.png" alt="">'
const DESK_YOU_AVATAR = '<svg viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"><circle cx="14" cy="14" r="12.6" stroke-dasharray="2.2 2.6"/><circle cx="14" cy="11.4" r="3.5"/><path d="M7.4 21.6c1.1-3.5 3.6-5.1 6.6-5.1s5.5 1.6 6.6 5.1"/></svg>'
/** @param {string} role */
export const deskSpeakerHtml = role => `<span class="desk-speaker" data-speaker="${role === 'user' ? 'you' : 'cc'}" aria-hidden="true">${role === 'user' ? DESK_YOU_AVATAR : DESK_CC_AVATAR}</span>`

export const waitingOfflineNoteHtml = `<p class="desk-offline-note" data-waiting-offline hidden>CC 没在运行，叫它起来以后才能回答。 <button class="desk-text-button" type="button" data-wake-cc>叫它起来</button> <span data-wake-cc-error role="status" hidden>没叫起来，再点一次试试。</span></p>`

// @ts-check
// now-page.js — 「此刻」页(spec 2026-10-01 §6.3):问候、CC(明暗来自 presence)、最近一句真话的气泡、等你的事、home/chat 两态。
import { greetingFor, ccPresence, waitingRows } from './now-home.js'

const pad = (/** @type {number} */ n) => String(n).padStart(2, '0')
/** @param {number} at @param {Date} now */
function when(at, now) {
  const d = new Date(at)
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  return d.toDateString() === now.toDateString() ? hm : `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`
}

/** @param {{root:HTMLElement,presencePoller:{subscribe:(cb:(p:any)=>void)=>()=>void},onOpenTask:(id:string)=>unknown,onModeChange?:(m:'home'|'chat')=>void,now?:()=>Date}} o */
export function mountNowPage({ root, presencePoller, onOpenTask, onModeChange, now = () => new Date() }) {
  const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (root.querySelector(`#${id}`))
  // 问候随钟点变:挂载、presence 每一拍、切 home/chat 都重算(textContent 同值不动 DOM)。
  const greet = () => { const g = greetingFor(now().getHours()); const el = $('now-greeting'); if (el.textContent !== g) el.textContent = g }
  greet()
  const unsub = presencePoller.subscribe(p => { root.dataset.cc = ccPresence(p); greet() })
  /** @param {'home'|'chat'} m */
  function setMode(m) { root.dataset.now = m; $('now-back').hidden = m !== 'chat'; greet(); onModeChange?.(m) }
  const toChat = () => setMode('chat')
  $('now-cc-bubble').addEventListener('click', toChat)
  $('now-cc').addEventListener('click', toChat)
  $('now-back').addEventListener('click', () => setMode('home'))
  const list = $('now-waiting-list')
  list.addEventListener('click', e => {
    const row = /** @type {HTMLElement|null} */ (/** @type {HTMLElement} */ (e.target).closest('.now-waiting-row'))
    if (row?.dataset.taskId) void onOpenTask(row.dataset.taskId)
  })
  return {
    setMode,
    /** @param {{text:string,at:number|null}|null} line */
    setLatestLine(line) {
      const b = $('now-cc-bubble')
      b.hidden = !line
      if (!line) return
      const text = /** @type {HTMLElement} */ (b.querySelector('.now-bubble-text'))
      const time = /** @type {HTMLElement} */ (b.querySelector('.now-bubble-time'))
      text.textContent = line.text
      time.textContent = line.at === null ? '' : when(line.at, now())
    },
    /** @param {any} state */
    setAttention(state) {
      const rows = waitingRows(state)
      $('now-waiting').hidden = rows.length === 0
      $('now-waiting-title').textContent = `${rows.length} 件事等你`
      list.replaceChildren(...rows.map(r => {
        const li = document.createElement('li')
        const btn = document.createElement('button')
        btn.type = 'button'; btn.className = 'now-waiting-row'; btn.dataset.taskId = r.id
        const text = document.createElement('div')
        const t = document.createElement('p'); t.className = 't'; t.textContent = r.title
        const d = document.createElement('p'); d.className = 'd'; d.textContent = r.detail
        text.append(t, d)
        const go = document.createElement('span'); go.className = 'go'; go.textContent = `${r.go} ›`
        btn.append(text, go); li.append(btn); return li
      }))
    },
    destroy() { unsub() },
  }
}

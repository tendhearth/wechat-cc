// @ts-check
// now-page.js — 「此刻」页(spec 2026-10-01 §6.3):问候、CC(明暗来自 presence)、最近一句真话的气泡、等你的事、home/chat 两态。
import { greetingFor, ccPresence, waitingRows, waitingHeader, ccBubblePreview } from './now-home.js'

const pad = (/** @type {number} */ n) => String(n).padStart(2, '0')
/** @param {number} at @param {Date} now */
function when(at, now) {
  const d = new Date(at)
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  return d.toDateString() === now.toDateString() ? hm : `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`
}

/**
 * onResolveTerminal:终端里等批准的那一行按了「允许 / 拒绝」(2026-10-14)。缺席 ⇒ 不给按钮。
 * 返回 true = 拍板了;false = 那一项已经不在(微信 / 桌宠刚拍过、过期);抛错 = 没送出去。
 * @param {{root:HTMLElement,presencePoller:{subscribe:(cb:(p:any)=>void)=>()=>void},onOpenTask:(id:string)=>unknown,onResolveTerminal?:(hash:string,decision:'allow'|'deny')=>Promise<boolean>,onModeChange?:(m:'home'|'chat')=>void,now?:()=>Date}} o
 */
export function mountNowPage({ root, presencePoller, onOpenTask, onResolveTerminal, onModeChange, now = () => new Date() }) {
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
  /** @type {any} */ let attention = null
  /** @type {import('./terminal-waiting.js').TerminalRow[]} */ let terminal = []
  // 按下去之后到下一拍列表把它收走之前,别让 3 秒一次的重绘把按钮又放出来(hash → 行上那句话;'' = 正在送)。
  /** @type {Map<string,string>} */ const decided = new Map()
  list.addEventListener('click', e => {
    const target = /** @type {HTMLElement} */ (e.target)
    const decide = /** @type {HTMLButtonElement|null} */ (target.closest('.now-terminal-decide'))
    if (decide) { void resolveTerminal(decide); return }
    const row = /** @type {HTMLElement|null} */ (target.closest('.now-waiting-row'))
    if (row?.dataset.taskId) void onOpenTask(row.dataset.taskId)
  })
  /** @param {HTMLButtonElement} btn */
  async function resolveTerminal(btn) {
    const li = /** @type {HTMLElement} */ (btn.closest('.now-terminal'))
    const hash = li?.dataset.hash, decision = /** @type {'allow'|'deny'} */ (btn.dataset.decision)
    if (!hash || !onResolveTerminal || decided.has(hash)) return
    decided.set(hash, '')
    renderWaiting()
    /** @type {string|null} */ let failed = null
    try {
      const ok = await onResolveTerminal(hash, decision)
      decided.set(hash, ok ? (decision === 'allow' ? '已允许' : '已拒绝') : '这一项已经处理过了')
    } catch {
      decided.delete(hash)
      failed = hash
    }
    renderWaiting()
    if (failed) {
      const note = list.querySelector(`.now-terminal[data-hash="${failed}"] .now-terminal-note`)
      if (note) note.textContent = '没送出去，再试一次'
    }
  }
  /** @param {import('./terminal-waiting.js').TerminalRow} r */
  function terminalItem(r) {
    const li = document.createElement('li')
    li.className = 'now-terminal'
    li.dataset.sessionId = r.id
    if (r.hash) li.dataset.hash = r.hash
    const box = document.createElement('div'); box.className = 'now-waiting-row now-terminal-row'
    const text = document.createElement('div')
    const t = document.createElement('p'); t.className = 't'; t.textContent = r.title
    const d = document.createElement('p'); d.className = 'd'; d.textContent = r.detail
    text.append(t, d)
    const actions = document.createElement('div'); actions.className = 'now-terminal-actions'
    const done = r.hash ? decided.get(r.hash) : undefined
    if (r.hash && onResolveTerminal && !done) {
      for (const [decision, label] of /** @type {const} */ ([['allow', '允许'], ['deny', '拒绝']])) {
        const b = document.createElement('button')
        b.type = 'button'; b.className = 'now-terminal-decide'; b.dataset.decision = decision; b.textContent = label
        b.disabled = done === ''
        b.setAttribute('aria-label', `${label}：${r.title}`)
        actions.append(b)
      }
    }
    const note = document.createElement('span'); note.className = 'now-terminal-note'; note.setAttribute('aria-live', 'polite')
    if (done) note.textContent = done
    actions.append(note)
    box.append(text, actions); li.append(box)
    return li
  }
  function renderWaiting() {
    const rows = waitingRows(attention)
    const head = waitingHeader(attention, terminal.length)
    const box = $('now-waiting')
    box.hidden = head.hidden
    if (head.unknown) box.dataset.state = 'unknown'; else delete box.dataset.state
    $('now-waiting-title').textContent = head.title
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
    }), ...terminal.map(terminalItem))
  }
  return {
    setMode,
    /** @param {{text:string,at:number|null}|null} line */
    setLatestLine(line) {
      const b = $('now-cc-bubble')
      b.hidden = !line
      if (!line) return
      const text = /** @type {HTMLElement} */ (b.querySelector('.now-bubble-text'))
      const time = /** @type {HTMLElement} */ (b.querySelector('.now-bubble-time'))
      const preview = ccBubblePreview(line.text)
      text.textContent = preview.text
      const more = /** @type {HTMLElement|null} */ (b.querySelector('.now-bubble-more'))
      if (more) more.hidden = !preview.shortened
      b.setAttribute('aria-label', `CC 最近说的话：${preview.text}，点开${preview.shortened ? '查看完整回复' : '进对话'}`)
      time.textContent = line.at === null ? '' : when(line.at, now())
    },
    /** @param {any} state */
    setAttention(state) { attention = state; renderWaiting() },
    /** 终端里等批准的会话(terminal-waiting.js 的行),接在工作台的等你行后面。 @param {import('./terminal-waiting.js').TerminalRow[]} rows */
    setTerminal(rows) {
      terminal = rows
      for (const h of [...decided.keys()]) if (!rows.some(r => r.hash === h)) decided.delete(h)
      renderWaiting()
    },
    destroy() { unsub() },
  }
}

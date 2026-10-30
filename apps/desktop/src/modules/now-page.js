// @ts-check
// now-page.js — 「此刻」页(spec 2026-10-01 §6.3):问候、CC(明暗来自 presence)、最近一句真话的气泡、等你的事、home/chat 两态。
import { greetingFor, ccPresence, waitingRows, waitingHeader, ccBubblePreview } from './now-home.js'
import { mountNowHero } from './now-hero.js'
import { createAgentAvatars } from '../shared/agent-avatars.js'
import { icon } from './icons.js'

const AGENTS = createAgentAvatars()

const pad = (/** @type {number} */ n) => String(n).padStart(2, '0')
/** @param {number} at @param {Date} now */
function when(at, now) {
  const d = new Date(at)
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  return d.toDateString() === now.toDateString() ? hm : `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`
}

// 动作文字保留在按钮的可访问名称中;视觉上只留本地箭头,让请求原文本身成为重点。
/** @param {HTMLElement} go @param {string} label */
function requestArrow(go, label) {
  const purpose = document.createElement('span'); purpose.className = 'now-sr'; purpose.textContent = `${label} ›`
  go.append(purpose)
  go.insertAdjacentHTML('beforeend', icon('arrow-left-02', { size: 16, className: 'now-request-arrow' }))
}

/**
 * onResolveTerminal:终端里等批准的那一行点开小窗后按了「允许 / 拒绝」(2026-10-14)。缺席 ⇒ 行不能点。
 * 返回 true = 拍板了;false = 那一项已经不在(微信 / 桌宠刚拍过、过期);抛错 = 没送出去。
 * @param {{root:HTMLElement,presencePoller:{subscribe:(cb:(p:any)=>void)=>()=>void},onOpenTask:(id:string)=>unknown,onResolveTerminal?:(hash:string,decision:'allow'|'deny')=>Promise<boolean>,onModeChange?:(m:'home'|'chat')=>void,now?:()=>Date}} o
 */
export function mountNowPage({ root, presencePoller, onOpenTask, onResolveTerminal, onModeChange, now = () => new Date() }) {
  const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (root.querySelector(`#${id}`))
  // 问候随钟点变:挂载、presence 每一拍、切 home/chat 都重算(textContent 同值不动 DOM)。
  const greet = () => { const g = greetingFor(now().getHours()); const el = $('now-greeting'); if (el.textContent !== g) el.textContent = g }
  greet()
  const hero = mountNowHero({ root, button: $('now-cc') })
  const unsub = presencePoller.subscribe(p => { root.dataset.cc = ccPresence(p); hero.setPresence(p); greet() })
  /** @param {'home'|'chat'} m */
  function setMode(m) { root.dataset.now = m; $('now-back').hidden = m !== 'chat'; greet(); onModeChange?.(m) }
  const toChat = () => setMode('chat')
  $('now-cc-bubble').addEventListener('click', toChat)
  $('now-cc').addEventListener('click', toChat)
  $('now-back').addEventListener('click', () => setMode('home'))
  const list = $('now-waiting-list')
  /** @type {any} */ let attention = null
  /** @type {import('./terminal-waiting.js').TerminalRow[]} */ let terminal = []
  // 按下去之后到下一拍列表把它收走之前,别让 3 秒一次的重绘把「看清楚」又放出来(hash → 行上那句话;'' = 正在送)。
  /** @type {Map<string,string>} */ const decided = new Map()
  list.addEventListener('click', e => {
    const target = /** @type {HTMLElement} */ (e.target)
    const term = /** @type {HTMLElement|null} */ (target.closest('.now-terminal-row[data-hash]'))
    if (term) { openDecide(/** @type {string} */ (term.dataset.hash)); return }
    const row = /** @type {HTMLElement|null} */ (target.closest('.now-waiting-row'))
    if (row?.dataset.taskId) void onOpenTask(row.dataset.taskId)
  })
  // 终端行与工作台行一样只有一个打开动作;点开小窗看清命令,再「允许 / 拒绝」。
  /** @type {{dialog:HTMLDialogElement,hash:string}|null} */ let decideView = null
  /** @param {string} hash */
  function openDecide(hash) {
    const r = terminal.find(x => x.hash === hash)
    if (!r || !onResolveTerminal || decided.has(hash)) return
    decideView?.dialog.close()
    const dialog = document.createElement('dialog')
    dialog.className = 'wb-history-dialog wb-handoff-dialog now-terminal-dialog'
    dialog.setAttribute('aria-label', r.title)
    const head = document.createElement('header')
    const hd = document.createElement('div')
    const h = document.createElement('h2'); h.textContent = r.title
    const sub = document.createElement('p'); sub.textContent = [r.detail, r.source].filter(Boolean).join(' · ')
    hd.append(h, sub)
    const close = document.createElement('button'); close.type = 'button'; close.className = 'now-terminal-close'; close.textContent = '关闭'
    close.addEventListener('click', () => dialog.close())
    head.append(hd, close)
    const body = document.createElement('div'); body.className = 'wb-handoff-body'
    if (r.command) {
      const label = document.createElement('p'); label.className = 'wb-history-note'; label.textContent = r.commandLabel ?? '具体内容'
      const pre = document.createElement('pre'); pre.className = 'now-terminal-command'; pre.textContent = r.command
      body.append(label, pre)
    } else {
      const p = document.createElement('p'); p.className = 'wb-history-note'; p.textContent = r.tool ? `${r.tool} 没说具体要做什么。` : '它没说具体要做什么。'
      body.append(p)
    }
    const foot = document.createElement('footer'); foot.className = 'wb-handoff-footer'
    const note = document.createElement('span'); note.className = 'now-terminal-note'; note.setAttribute('aria-live', 'polite')
    const actions = document.createElement('div'); actions.className = 'now-terminal-actions'
    for (const [decision, label] of /** @type {const} */ ([['deny', '拒绝'], ['allow', '允许']])) {
      const b = document.createElement('button')
      b.type = 'button'; b.className = `wb-btn now-terminal-decide${decision === 'allow' ? ' wb-btn-primary' : ''}`; b.dataset.decision = decision; b.textContent = label
      b.addEventListener('click', () => { void resolveTerminal(hash, decision) })
      actions.append(b)
    }
    foot.append(note, actions)
    dialog.append(head, body, foot)
    dialog.addEventListener('close', () => { dialog.remove(); if (decideView?.dialog === dialog) decideView = null })
    document.body.append(dialog)
    decideView = { dialog, hash }
    dialog.showModal()
  }
  /** @param {string} hash @param {'allow'|'deny'} decision */
  async function resolveTerminal(hash, decision) {
    if (!onResolveTerminal || decided.has(hash)) return
    const box = decideView?.hash === hash ? decideView.dialog : null
    const buttons = box ? [...box.querySelectorAll('button.now-terminal-decide')] : []
    for (const b of buttons) /** @type {HTMLButtonElement} */ (b).disabled = true
    decided.set(hash, '')
    renderWaiting()
    try {
      const ok = await onResolveTerminal(hash, decision)
      decided.set(hash, ok ? (decision === 'allow' ? '已允许' : '已拒绝') : '这一项已经处理过了')
      renderWaiting()
      if (box?.open) box.close()
    } catch {
      decided.delete(hash)
      renderWaiting()
      for (const b of buttons) /** @type {HTMLButtonElement} */ (b).disabled = false
      const note = box?.querySelector('.now-terminal-note')
      if (note) note.textContent = '没送出去，再试一次'
    }
  }
  /** @param {import('./terminal-waiting.js').TerminalRow} r */
  function terminalItem(r) {
    const li = document.createElement('li')
    li.className = 'now-terminal'
    li.dataset.sessionId = r.id
    if (r.hash) li.dataset.hash = r.hash
    const done = r.hash ? decided.get(r.hash) : undefined
    const canDecide = Boolean(r.hash && onResolveTerminal && done === undefined)
    const box = document.createElement(canDecide ? 'button' : 'div')
    box.className = 'now-waiting-row now-terminal-row'
    if (canDecide && r.hash) {
      /** @type {HTMLButtonElement} */ (box).type = 'button'; box.dataset.hash = r.hash
      box.title = `看清楚：${[r.title, r.detail, r.source].filter(Boolean).join(' · ')}`
    }
    const text = document.createElement('div')
    const t = document.createElement('p'); t.className = 't'; t.textContent = r.title
    const d = document.createElement('p'); d.className = 'd'; d.textContent = r.detail
    text.append(t, d)
    // 哪家:行尾一个圆头像(名字在读屏标签与 title 里,小窗标题下也写)。
    const who = document.createElement('span'); who.className = 'now-terminal-agent'
    who.innerHTML = AGENTS.agentAvatarsHtml([r.agent], { cls: 'now-agents', nameOf: () => r.source })
    const go = document.createElement('span'); go.className = 'go'
    if (canDecide) requestArrow(go, '看清楚')
    else go.textContent = done === '' ? '正在送…' : done ?? (r.hash ? '' : '回终端处理')
    if (done !== undefined) go.setAttribute('aria-live', 'polite')
    box.append(text, who, go); li.append(box)
    return li
  }
  function renderWaiting() {
    const rows = waitingRows(attention)
    const head = waitingHeader(attention, terminal.length)
    const box = $('now-waiting')
    box.hidden = head.hidden
    box.setAttribute('aria-labelledby', 'now-waiting-title')
    if (attention?.stale) box.dataset.state = head.unknown ? 'unknown' : 'partial'; else delete box.dataset.state
    const heading = $('now-waiting-title')
    heading.textContent = head.title
    // 普通计数仍可按标题导航;读不到时必须把不确定性留在眼前。
    heading.classList.toggle('now-sr', !attention?.stale)
    list.replaceChildren(...rows.map(r => {
      const li = document.createElement('li')
      const btn = document.createElement('button')
      btn.type = 'button'; btn.className = 'now-waiting-row'; btn.dataset.taskId = r.id
      btn.title = `${r.go}：${[r.title, r.detail].filter(Boolean).join(' · ')}`
      const text = document.createElement('div')
      const t = document.createElement('p'); t.className = 't'; t.textContent = r.title
      const d = document.createElement('p'); d.className = 'd'; d.textContent = r.detail
      text.append(t, d)
      const go = document.createElement('span'); go.className = 'go'; requestArrow(go, r.go)
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
    setAttention(state) { attention = state; hero.setAttention(state); renderWaiting() },
    /** @param {import('./converse.js').ConverseMsg[]} msgs */
    setConversationSnapshot(msgs) { hero.setConverse(msgs) },
    /** 终端里等批准的会话(terminal-waiting.js 的行),接在工作台的等你行后面。 @param {import('./terminal-waiting.js').TerminalRow[]} rows */
    setTerminal(rows) {
      terminal = rows
      hero.setTerminal(rows)
      for (const h of [...decided.keys()]) if (!rows.some(r => r.hash === h)) decided.delete(h)
      // 小窗开着时那一项已经不在(微信 / 桌宠刚拍过)⇒ 关掉,别留一个按了也白按的窗。
      if (decideView && !rows.some(r => r.hash === decideView?.hash)) decideView.dialog.close()
      renderWaiting()
    },
    destroy() { unsub(); hero.destroy(); decideView?.dialog.close() },
  }
}

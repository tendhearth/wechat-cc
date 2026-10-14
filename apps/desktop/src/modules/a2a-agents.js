import { showToast, armConfirm } from "../view.js"
// @ts-check
/// <reference lib="dom" />
/**
 * Dashboard module: "Agents (A2A)" tab.
 * Renders the registered-agents list, hooks up Add Agent modal flow,
 * pause/resume/remove/activity actions.
 *
 * Click handler is attached ONCE to the list (delegated) — not per-refresh —
 * so there are no event-listener leaks across list reloads.
 */

import { invokeApi } from '../api.js'
import { initHuntBag, refreshHuntBag } from './journal.js'
import { initPeople, refreshPeople } from './people.js'
import { initWishes, refreshWishes } from './wishes.js'

// ── module-level state ────────────────────────────────────────────────────
/** @type {Record<string, unknown> | null} */
let previewedCard = null
let previewedUrl = ''

// A page visit owns its reads and UI writes. Drafts survive visits; requests do not.
let active = true
let pageGeneration = 0
let refreshGeneration = 0
/** @type {HTMLElement | null} */
let initializedList = null
// Keep mutations single-flight even if their page or dialog closes.
const agentMutations = new Map()
let inboundOperation = null
let inboundAvailable = true
let socialEnableOperation = null
let activityRevision = 0
let testSession = null
const testSending = new Map()
let addSession = null
let previewOperation = null
const addInstalling = new Map()

/** @param {number} generation */
function isPageCurrent(generation) { return active && pageGeneration === generation }

export function deactivateA2AAgentsTab() {
  active = false
  pageGeneration++
  refreshGeneration++
  closeMailThread()
  deactivatePairing()
  closeActivityDrawer()
  closeTestModal()
  closeAddModal(false)
}

/** Only these explicit server responses mean social has not been wired. */
function isSocialUnwired(error) { return error === 'social_not_wired' || error === 'penpal_not_wired' }
function readErrorText(err) { return err instanceof Error ? err.message : String(err) }
function renderReadError(what, action = 'forage-retry') {
  return `<div class="fd-empty" role="status">${escapeHtml(what)}暂时读不到。<button class="btn ghost" data-action="${action}" type="button">重试</button></div>`
}
async function onForageRetry(e) {
  const target = e.target?.closest?.('[data-action="forage-retry"], [data-action="mailbox-retry"]')
  if (!target || target.disabled || !active) return
  target.disabled = true
  try { await refresh() } finally { if (target.isConnected) target.disabled = false }
}


// ── public API ────────────────────────────────────────────────────────────


// ── 社交总开关 ──────────────────────────────────────────────────────────
//
// 2026-08-31:此前社交未启用时,这个页面四处入口(觅食、配对、信箱、寄信)
// 都只会说「先在命令行运行 wechat-cc social enable 并重启守护进程」——
// 一个桌面产品把人踢回终端。被朋友拉来试用的人基本必然卡死在这一步,这是
// "找朋友测试"的头号障碍。
//
// 现在给一个就地按钮。社交仍然【默认关闭】:这一下点击就是用户的明确同意
// (社交层会代表他往外发东西,这个契约不能省)。启用后可以在觅食网区块里
// 随时关掉 —— 开关必须双向,否则用户被单向门锁住。
const SOCIAL_OFF_HINT = '它会让你的 CC 代表你和朋友的 CC 打交道,所以默认关着。'

/** 未启用时统一的空态:一句人话 + 一个就地启用按钮(不再打发人去终端)。 */
function renderSocialOffState(what) {
  return `<div class="fd-empty">${escapeHtml(what)}${escapeHtml(SOCIAL_OFF_HINT)}
    <div style="margin-top:8px"><button class="btn" data-action="social-enable" type="button">启用社交</button></div></div>`
}

/**
 * 点「启用社交」:落盘,然后【提示】需要重启才生效 —— 不自动重启。
 *
 * 与同页的入站开关(/v1/social/inbound)保持一致的姿态。重启会短暂断开微信
 * 连接,那是用户该自己挑时机的事;替他决定不合适。
 */
async function onSocialEnableClick(btn) {
  if (!btn || btn.disabled || !active || socialEnableOperation) return
  const operation = { generation: pageGeneration }
  socialEnableOperation = operation
  btn.disabled = true
  const original = btn.textContent
  btn.textContent = '启用中…'
  try {
    const r = /** @type {{enabled?:boolean, restart_required?:boolean}} */ (
      await invokeApi('POST', '/v1/social/enable', { enabled: true }))
    if (!isPageCurrent(operation.generation)) return
    if (!r || r.enabled !== true) throw new Error('启用未生效')
    btn.textContent = '已启用'
    showToast(r.restart_required ? '社交已启用 —— 重启守护进程后生效' : '社交已启用')
  } catch (err) {
    if (!isPageCurrent(operation.generation)) return
    btn.disabled = false
    btn.textContent = original
    showToast(`启用失败:${readErrorText(err)}`)
  } finally {
    if (socialEnableOperation === operation) socialEnableOperation = null
  }
}

export async function initA2AAgentsTab() {
  const list = document.getElementById('a2a-agents-list')
  if (!list) return

  const pane = document.querySelector?.('.dash-pane[data-pane="a2a-agents"]')
  if (!pane || !pane.hidden) await refresh()
  else deactivateA2AAgentsTab()
  if (initializedList === list) return
  initializedList = list

  // Wire all event handlers ONCE.
  document.getElementById('a2a-add-btn')?.addEventListener('click', openAddModal)
  document.getElementById('a2a-add-form')?.addEventListener('submit', onPreviewSubmit)
  document.getElementById('a2a-install-confirm')?.addEventListener('click', onInstallConfirm)
  document.getElementById('a2a-install-cancel')?.addEventListener('click', closeAddModal)
  document.getElementById('a2a-add-close')?.addEventListener('click', closeAddModal)
  // ✕ in modal header (any stage) + backdrop click (click outside the
  // content area). HTML <dialog> doesn't close on backdrop click by
  // default — event target === the dialog itself only when the click
  // landed on the backdrop (not on any descendant); use that as the
  // signal. Esc uses the same owner-invalidating close handlers below.
  document.getElementById('a2a-add-modal-close')?.addEventListener('click', closeAddModal)
  document.getElementById('a2a-add-modal')?.addEventListener('click', (e) => {
    if (e.target instanceof HTMLDialogElement) closeAddModal()
  })
  document.getElementById('a2a-test-modal-close')?.addEventListener('click', closeTestModal)
  document.getElementById('a2a-test-modal')?.addEventListener('click', (e) => {
    if (e.target instanceof HTMLDialogElement) closeTestModal()
  })
  document.getElementById('a2a-activity-close')?.addEventListener('click', closeActivityDrawer)
  document.getElementById('a2a-test-inbound')?.addEventListener('click', () => runTest(false))
  document.getElementById('a2a-test-outbound')?.addEventListener('click', () => runTest(true))
  document.getElementById('a2a-test-close')?.addEventListener('click', closeTestModal)
  // Delegated click handler on the list container (attached ONCE; not per
  // refresh — duplicating would multiply calls per click).
  list.addEventListener('click', onCardAction)

  document.getElementById('fd-hero-status')?.addEventListener('click', onForageRetry)
  document.getElementById('fd-inbound-note')?.addEventListener('click', onForageRetry)
  document.getElementById('fd-mailbox-count')?.addEventListener('click', onForageRetry)
  document.getElementById('fd-connect-btn')?.addEventListener('click', () => {
    const details = document.querySelector?.('#fd-net > details')
    if (details) details.open = true
    document.getElementById('fd-pair-start')?.focus()
  })
  for (const [id, close] of [['a2a-add-modal', closeAddModal], ['a2a-test-modal', closeTestModal]]) {
    const modal = document.getElementById(id)
    modal?.addEventListener('cancel', event => { event.preventDefault(); close() })
    modal?.addEventListener('close', () => {
      // The browser may deliver an old close event after the dialog reopened.
      if (modal instanceof HTMLDialogElement && !modal.open) {
        if (id === 'a2a-add-modal') invalidateAddSession()
        else testSession = null
      }
    })
  }
  document.getElementById('a2a-add-preview')?.addEventListener('input', syncInstallButton)
  // 觅食台 — inbound toggle, pairing.
  document.getElementById('fd-inbound-toggle')?.addEventListener('click', onInboundToggle)
  document.getElementById('fd-pair-start')?.addEventListener('click', onPairStart)
  document.getElementById('fd-pair-accept')?.addEventListener('click', onPairAccept)
  document.getElementById('fd-mailbox')?.addEventListener('click', onMailboxAction)
  initHuntBag()
  initPeople()
  initWishes()
}

export async function refresh() {
  active = true
  const generation = pageGeneration
  const request = ++refreshGeneration
  const read = async (path, key) => {
    try {
      const data = await invokeApi('GET', path)
      if (!data || (key && !Array.isArray(data[key]))) throw new Error('返回内容不完整')
      if (path === '/v1/social/inbound' && typeof data.enabled !== 'boolean') throw new Error('返回内容不完整')
      return { data, error: '' }
    } catch (err) { return { data: null, error: readErrorText(err) } }
  }
  const [list, inbound, mail, info] = await Promise.all([
    read('/v1/a2a/list', 'agents'), read('/v1/social/inbound', ''),
    read('/v1/penpal/channels', 'channels'), read('/v1/a2a/info', ''),
    refreshHuntBag(), refreshPeople(),
  ])
  if (!isPageCurrent(generation) || request !== refreshGeneration) return
  const banner = document.getElementById('a2a-server-banner')
  if (banner) renderServerBanner(info.data, banner)
  renderForageDesk({
    agents: list.data?.agents ?? null, agentsError: list.error,
    inbound: inbound.data, inboundError: inbound.error,
    mailbox: mail.data?.channels ?? null, mailboxError: mail.error,
  })
  await refreshWishes()
  if (!isPageCurrent(generation) || request !== refreshGeneration) return
  const sub = document.getElementById('fd-tools-sub')
  if (sub) {
    if (mail.error) sub.textContent = isSocialUnwired(mail.error) ? '' : '信箱暂时读不到'
    else {
      const unread = mail.data.channels.reduce((a, c) => a + (Number(c.unread) || 0), 0)
      sub.textContent = unread ? `${unread} 封未读` : ''
    }
  }
}

/**
 * Render the operator-visible "your A2A base URL is X" banner — so they
 * can share it with external agents without hunting through the Add
 * Agent modal.
 * @param {Record<string, any> | null} info
 * @param {HTMLElement} banner
 */
function renderServerBanner(info, banner) {
  if (!info) {
    banner.innerHTML = '<span class="dot off"></span> 暂时连不上 CC，请到首页检查连接。'
  } else if (!info.enabled) {
    banner.innerHTML = '<span class="dot off"></span> 觅食网还没开通 — 在 <code>agent-config.json</code> 加 <code>"a2a_listen": { "port": 8717 }</code> 后重启 daemon'
  } else {
    const url = String(info.base_url ?? '')
    banner.innerHTML = `<span class="dot on"></span> 你的 CC 在线，朋友的 CC 能找到它
      <details class="a2a-tech"><summary>接入地址</summary><code class="a2a-base-url">${escapeHtml(url)}/a2a/notify</code></details>`
  }
}

/**
 * Render the registered-agents cards into `list` (preserved verbatim
 * markup — `.a2a-agent-card`, `data-action`, ids — Playwright a2a.spec
 * depends on the `.empty` state text).
 * @param {Array<any>} agents
 * @param {HTMLElement} list
 */
function renderAgents(agents, list) {
  list.innerHTML = ''
  if (agents.length === 0) {
    list.innerHTML = '<li class="empty">还没连上朋友的 CC — 生成一个配对码念给朋友，就能连上。</li>'
    return
  }
  for (const a of agents) {
    const li = document.createElement('li')
    li.className = 'a2a-agent-card' + (a.paused ? ' paused' : '')
    li.dataset.id = a.id
    const inbound = a.counts?.inbound ?? 0
    const outbound = a.counts?.outbound ?? 0
    const exchanged = inbound + outbound > 0
      ? `收到 ${inbound} 条 · 送出 ${outbound} 条`
      : '还没有来往 — 撒个心愿试试'
    li.innerHTML = `
      <header class="a2a-card-head">
        <span class="dot ${a.paused ? 'off' : 'on'}"></span>
        <strong>${escapeHtml(a.name)}</strong>
        <span class="plugin-name">${escapeHtml(a.id)}</span>
        ${a.paused ? '<span class="plugin-source">已暂停</span>' : ''}
      </header>
      <div class="a2a-card-counts">${exchanged}</div>
      <details class="a2a-tech"><summary>技术详情</summary><code>${escapeHtml(peerReach(a))}</code> · ↓ ${inbound} · ↑ ${outbound}</details>
      <div class="a2a-card-actions">
        <button class="btn ghost" data-action="pause" data-id="${escapeHtml(a.id)}">${a.paused ? '恢复' : '暂停'}</button>
        <button class="btn ghost" data-action="test" data-id="${escapeHtml(a.id)}">测试连通</button>
        <button class="btn ghost" data-action="activity" data-id="${escapeHtml(a.id)}">看往来</button>
        <button class="btn danger" data-action="remove" data-id="${escapeHtml(a.id)}">断开</button>
      </div>
    `
    if (agentMutations.has(String(a.id))) li.querySelectorAll('button').forEach(button => { button.disabled = true })
    list.appendChild(li)
  }
}

/**
 * Render the whole 觅食台 from live data.
 * @param {{ agents:Array<any>|null, inbound:any, mailbox?:Array<any>|null }} data
 */
/**
 * 伙伴的可达地址,一行人话。
 *
 * 六位配对码建立的对端**没有 url** —— 它的可达性在 transport/mailbox_addr/
 * relays 里。原先这里直接印 `a.url`,对信箱对端就渲染出字符串 "undefined",
 * 看着像装坏了。见 routes-a2a.list.test.ts(接口那半边的同一个洞)。
 */
export function peerReach(a) {
  if (a.url) return a.url
  if (a.transport === 'mailbox') {
    const hosts = (a.relays ?? [])
      .map(u => { try { return new URL(u).host } catch { return u } })
      .join('、')
    return hosts ? `信箱 · 经 ${hosts}` : '信箱 · 还没有中继'
  }
  return '没有地址'
}

export function renderForageDesk(data) {
  const agents = Array.isArray(data.agents) ? data.agents : null
  const unwired = isSocialUnwired(data.mailboxError) || isSocialUnwired(data.inboundError)
  const status = document.getElementById('fd-hero-status')
  if (status) {
    status.innerHTML = agents
      ? `<span class="fd-status-line"><span>连着 <b>${agents.length} 位</b>朋友的 CC</span></span>`
      : renderReadError('朋友列表')
  }
  const note = document.getElementById('fd-social-note')
  if (note) {
    note.hidden = !unwired
    note.textContent = unwired ? '社交功能尚未开启。展开下方「你的觅食网」，开启「让朋友的 CC 能找到我」，再重新连接 CC。' : ''
  }

  // Reading and replying keep their DOM owner, even when other sections retry.
  const mailbox = document.getElementById('fd-mailbox')
  const mbCount = document.getElementById('fd-mailbox-count')
  const chans = Array.isArray(data.mailbox) ? data.mailbox : null
  const mailThreadOpen = !!(openMailThreadEl && !openMailThreadEl.hidden && openMailThreadEl.isConnected !== false)
  if (mailbox && !mailThreadOpen) {
    openMailThreadEl = null
    openMailThread = null
    if (chans == null) mailbox.innerHTML = isSocialUnwired(data.mailboxError)
      ? renderSocialOffState('笔友信箱还没开 —— ') : renderReadError('信箱', 'mailbox-retry')
    else if (chans.length === 0) mailbox.innerHTML = '<div class="fd-empty">还没有笔友 —— 和朋友配对后，就能在这里通信了。</div>'
    else mailbox.innerHTML = chans.map(c => renderMailChannel(c)).join('')
  }
  if (mbCount) {
    if (chans == null && !isSocialUnwired(data.mailboxError)) mbCount.innerHTML = '信箱暂时读不到 <button class="btn ghost" data-action="mailbox-retry" type="button">重试</button>'
    else if (!mailThreadOpen) {
      const unread = (chans ?? []).reduce((sum, c) => sum + (Number(c.unread) || 0), 0)
      mbCount.textContent = unread ? `${unread} 封未读` : ''
    }
  }

  const toggle = document.getElementById('fd-inbound-toggle')
  const inboundNote = document.getElementById('fd-inbound-note')
  if (toggle) {
    const on = data.inbound?.enabled === true
    inboundAvailable = data.inbound != null
    toggle.disabled = !inboundAvailable || !!inboundOperation
    toggle.classList.toggle('fd-on', on)
    toggle.setAttribute('aria-checked', on ? 'true' : 'false')
    if (inboundNote && data.inbound == null && !isSocialUnwired(data.inboundError)) {
      inboundNote.hidden = false
      inboundNote.innerHTML = renderReadError('连接设置')
      inboundNote.dataset.readError = 'true'
    } else if (inboundNote?.dataset.readError) {
      inboundNote.hidden = true
      inboundNote.textContent = ''
      delete inboundNote.dataset.readError
    }
  }
  const peers = document.getElementById('fd-peers')
  const peersCount = document.getElementById('fd-peers-count')
  if (peers) {
    const shown = (agents ?? []).slice(0, 4)
    let html = shown.map(a => `<span class="fd-peer">${escapeHtml(lastGlyph(a.name || a.id))}</span>`).join('')
    if (agents && agents.length > 4) html += `<span class="fd-peer">+${agents.length - 4}</span>`
    peers.innerHTML = html
  }
  if (peersCount) peersCount.textContent = agents ? `连着 ${agents.length} 位朋友的 CC` : '朋友列表暂时读不到'
  const list = document.getElementById('a2a-agents-list')
  if (list) {
    if (agents) renderAgents(agents, list)
    else list.innerHTML = `<li class="empty">${renderReadError('朋友列表')}</li>`
  }
}

/** @param {string} iso */
function fdRelTime(iso) {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const s = Math.floor((Date.now() - t) / 1000)
  if (s < 60) return '刚刚'
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`
  if (s < 172800) return '昨天'
  return `${Math.floor(s / 86400)} 天前`
}
/**
 * Last visible glyph of a name (handles surrogate pairs) — for common CN
 * nicknames like 老王/小李 (老/小 + surname prefix pattern) this surfaces
 * the surname rather than the generic 老/小 prefix.
 * @param {string} s
 */
function lastGlyph(s) { const g = Array.from(String(s || '?')); return g[g.length - 1] || '?' }

/** @param {any} c — GET /v1/penpal/channels 的一行。 */
function renderMailChannel(c) {
  const unread = Number(c.unread) || 0
  return `<div class="fd-mail-chan" data-chan-id="${escapeHtml(c.id)}">` +
    `<button type="button" class="fd-mail-head" aria-expanded="false" data-action="mail-toggle" data-id="${escapeHtml(c.id)}">` +
    `<span class="fd-mail-peer">${escapeHtml(c.peer_label || '笔友')}</span>` +
    (c.title ? `<span class="fd-mail-title">「${escapeHtml(c.title)}」</span>` : '') +
    (unread ? `<span class="fd-mail-unread">${unread}</span>` : '') +
    (c.last_preview ? `<span class="fd-mail-preview">${escapeHtml(c.last_preview)}</span>` : '') +
    `</button>` +
    `<div class="fd-mail-thread" hidden></div>` +
    `</div>`
}

/** @param {Array<any>} letters — 路由返回 newest-first;渲染 reverse 成正序。
 *  @param {string} channelId */
function renderMailBubbles(letters) {
  return letters.slice().reverse().map(l =>
    `<div class="fd-mail-bubble ${l.direction === 'out' ? 'fd-out' : 'fd-in'}">` +
    `<div class="fd-mail-text">${escapeHtml(l.plaintext ?? '')}</div>` +
    `<div class="fd-mail-time">${escapeHtml(fdRelTime(l.created_at))}</div>` +
    `</div>`).join('')
}
function renderMailThread(letters, channelId, draft = '') {
  const bubbles = renderMailBubbles(letters ?? [])
  return `<div class="fd-mail-bubbles">${bubbles || (letters ? '<div class="fd-empty">还没有信 —— 写下第一封吧。</div>' : '<div class="fd-empty">正在读信…</div>')}</div>` +
    `<div class="fd-mail-replyrow">` +
    `<label class="fd-mail-replylabel"><span>回信</span><input class="fd-mail-input" placeholder="写封信…" maxlength="2000" value="${escapeHtml(draft)}"></label>` +
    `<button type="button" class="fd-btn fd-btn-primary" data-action="mail-send" data-id="${escapeHtml(channelId)}">寄出</button>` +
    `</div>` +
    `<div class="fd-mail-note" hidden></div>`
}

// ── event handlers ────────────────────────────────────────────────────────

/** @param {MouseEvent} e */
async function onCardAction(e) {
  const target = e.target?.closest?.('button[data-action]')
  if (!(target instanceof HTMLButtonElement) || target.disabled || !active) return
  const action = target.dataset.action
  if (action === 'social-enable') { await onSocialEnableClick(target); return }
  if (action === 'forage-retry') { await onForageRetry(e); return }
  const id = target.dataset.id
  if (!action || !id) return
  if (action === 'pause' || action === 'remove') {
    if (agentMutations.has(id)) return
    if (action === 'remove' && !armConfirm(target, '再点一次，确认断开')) return
    const card = target.closest('.a2a-agent-card')
    const wasPaused = card?.classList.contains('paused')
    const operation = { generation: pageGeneration }
    agentMutations.set(id, operation)
    card?.querySelectorAll('button').forEach(button => { button.disabled = true })
    try {
      await invokeApi('POST', `/v1/a2a/${action}`, action === 'pause' ? { id, paused: !wasPaused } : { id })
      if (isPageCurrent(operation.generation)) await refresh()
    } catch (err) {
      if (isPageCurrent(operation.generation)) showToast(`${action === 'remove' ? '断开' : wasPaused ? '恢复' : '暂停'}失败：${readErrorText(err)}`)
    } finally {
      if (agentMutations.get(id) === operation) {
        agentMutations.delete(id)
        if (active) {
          document.querySelectorAll('.a2a-agent-card').forEach(currentCard => {
            if (currentCard instanceof HTMLElement && currentCard.dataset.id === id) currentCard.querySelectorAll('button').forEach(button => { button.disabled = false })
          })
        }
      }
    }
  } else if (action === 'activity') {
    await openActivityDrawer(id)
  } else if (action === 'test') {
    await openTestModal(id)
  }
}

// ✉️ 信箱 — 展开看信(即读即清未读) + 回信。同时只展开一个线程。
/** @type {any} */
let openMailThreadEl = null
/** @type {{id:string, card:any, thread:any, generation:number, read:number, reading:boolean}|null} */
let openMailThread = null
/** @type {Map<string, {draft:string, revision:number, letters:Array<any>|null}>} */
const mailThreads = new Map()
/** @type {Map<string, object>} */
const mailSending = new Map()
function mailState(id) {
  if (!mailThreads.has(id)) mailThreads.set(id, { draft: '', revision: 0, letters: null })
  return mailThreads.get(id)
}
function updateMailDraft(id, draft) {
  const state = mailState(id)
  if (state.draft !== draft) { state.draft = draft; state.revision++ }
}
function saveMailDraft(owner) {
  if (!owner) return
  const input = owner.card.querySelector('.fd-mail-input')
  if (input) updateMailDraft(owner.id, String(input.value ?? ''))
}
function closeMailThread() {
  saveMailDraft(openMailThread)
  openMailThread?.card.querySelector('.fd-mail-head')?.setAttribute('aria-expanded', 'false')
  if (openMailThreadEl) openMailThreadEl.hidden = true
  openMailThreadEl = null
  openMailThread = null
}
function isCurrentMail(owner) {
  return !!owner && openMailThread === owner && isPageCurrent(owner.generation)
    && owner.thread.isConnected !== false && !owner.thread.hidden
}
function setMailSending(id) {
  if (openMailThread?.id !== id || !isCurrentMail(openMailThread)) return
  const button = openMailThread.card.querySelector('[data-action="mail-send"]')
  if (button) button.disabled = mailSending.has(id)
}


const MAIL_FAIL_COPY = /** @type {Record<string, string>} */ ({
  channel_not_open: '这条信道还没打开 —— 双方都揭晓后才能通信',
  no_route: '找不到通往对方的路 —— 稍后再试',
  send_failed: '寄出失败 —— 对方的 CC 暂时联系不上，稍后再试',
  unknown_letter: '找不到要重寄的那封信 —— 重新写一封吧',
})

/** @param {MouseEvent} e */
async function onMailboxAction(e) {
  let target = /** @type {any} */ (e.target)
  if (!target || !target.dataset) return
  // 真实 DOM 里点击多半落在 .fd-mail-head 的子 span 上(e.target 无
  // data-action)—— closest 走一级找到携带 action 的容器;线程气泡等
  // 无 [data-action] 祖先的点击在这里自然滤掉。
  if (!target.dataset.action && typeof target.closest === 'function') {
    target = target.closest('[data-action]')
    if (!target || !target.dataset) return
  }
  if (!active) return
  if (target.dataset.action === 'forage-retry' || target.dataset.action === 'mailbox-retry') return onForageRetry(e)
  if (target.dataset.action === 'social-enable') return onSocialEnableClick(target)
  if (target.dataset.action === 'mail-toggle') return showMailThread(target)
  if (target.dataset.action === 'mail-retry' && openMailThread?.id === target.dataset.id) return readMailThread(openMailThread)
  if (target.dataset.action === 'mail-send') return sendMailReply(target)
}

/** @param {any} target */
async function showMailThread(target) {
  const card = target.closest?.('.fd-mail-chan')
  const thread = card?.querySelector('.fd-mail-thread')
  const id = target.dataset.id
  if (!card || !thread || !id) return
  if (!thread.hidden) { closeMailThread(); thread.hidden = true; return }
  closeMailThread()
  const state = mailState(id)
  const owner = { id, card, thread, generation: pageGeneration, read: 0, reading: false }
  openMailThread = owner
  openMailThreadEl = thread
  target.setAttribute('aria-expanded', 'true')
  thread.hidden = false
  thread.innerHTML = renderMailThread(state.letters, id, state.draft)
  const input = card.querySelector('.fd-mail-input')
  input?.addEventListener('input', () => {
    if (isCurrentMail(owner)) updateMailDraft(id, String(input.value ?? ''))
  })
  setMailSending(id)
  await readMailThread(owner)
}

async function readMailThread(owner) {
  if (!isCurrentMail(owner)) return
  const request = ++owner.read
  owner.reading = true
  const note = owner.card.querySelector('.fd-mail-note')
  if (note) { note.hidden = false; note.textContent = '正在读信…' }
  try {
    const r = await invokeApi('GET', `/v1/penpal/letters?channel_id=${encodeURIComponent(owner.id)}`)
    if (!isCurrentMail(owner) || request !== owner.read) return
    if (!Array.isArray(r?.letters)) throw new Error('返回内容不完整')
    mailState(owner.id).letters = r.letters
    const bubbles = owner.card.querySelector('.fd-mail-bubbles')
    if (bubbles) bubbles.innerHTML = renderMailBubbles(r.letters) || '<div class="fd-empty">还没有信 —— 写下第一封吧。</div>'
    if (note) { note.hidden = true; note.textContent = '' }
    invokeApi('POST', '/v1/penpal/letters/read', { channel_id: owner.id }).catch(() => {})
    owner.card.querySelector('.fd-mail-unread')?.remove()
  } catch (err) {
    if (!isCurrentMail(owner) || request !== owner.read) return
    if (mailState(owner.id).letters == null) {
      const bubbles = owner.card.querySelector('.fd-mail-bubbles')
      if (bubbles) bubbles.innerHTML = '<div class="fd-empty">信件暂时读不到</div>'
    }
    if (note) {
      note.hidden = false
      const error = readErrorText(err)
      note.innerHTML = isSocialUnwired(error)
        ? renderSocialOffState('笔友功能尚未开启 —— ')
        : `看信失败：${escapeHtml(error)} <button class="btn ghost" data-action="mail-retry" data-id="${escapeHtml(owner.id)}" type="button">重试</button>`
    }
  } finally {
    if (owner.read === request) owner.reading = false
  }
}

// 失败重试登记:channel id → { letterId, text }。send_failed 时信已落库,
// 同文本重按「寄出」走 /resend 重投同字节(接收端 nonce 去重 ⇒ 幂等),
// 而不是再封一封新 nonce 的信在“投到了但 ack 丢了”时重复投递。
/** @type {Record<string, { letterId: string, text: string }>} */
const mailRetry = Object.create(null)

/** @param {any} target */
async function sendMailReply(target) {
  const id = target.dataset.id
  const card = target.closest?.('.fd-mail-chan')
  if (!id || !card || target.disabled || mailSending.has(id)) return
  const owner = openMailThread
  if (!isCurrentMail(owner) || owner.card !== card || owner.id !== id) return
  const input = card.querySelector('.fd-mail-input')
  const note = card.querySelector('.fd-mail-note')
  const submitted = String(input?.value ?? '')
  const text = submitted.trim()
  if (!text) { if (note) { note.hidden = false; note.textContent = '先写点什么' } return }
  const current = () => isCurrentMail(owner)
  const pending = mailRetry[id]?.text === text ? mailRetry[id] : null
  if (!pending) delete mailRetry[id]
  const operation = {}
  mailSending.set(id, operation)
  updateMailDraft(id, submitted)
  const submittedRevision = mailState(id).revision
  target.disabled = true
  try {
    const r = pending
      ? await invokeApi('POST', '/v1/penpal/letters/resend', { letter_id: pending.letterId })
      : await invokeApi('POST', '/v1/penpal/letters', { channel_id: id, text })
    if (r?.ok) {
      delete mailRetry[id]
      // Reconcile only the draft represented by this submission. A later edit,
      // including deleting and retyping the same text, belongs to the user.
      const state = mailState(id)
      if (openMailThread?.id === id && isCurrentMail(openMailThread)) saveMailDraft(openMailThread)
      if (state.draft === submitted && state.revision === submittedRevision) {
        state.draft = ''
        state.revision++
        const currentInput = openMailThread?.id === id && isCurrentMail(openMailThread)
          ? openMailThread.card.querySelector('.fd-mail-input') : null
        if (currentInput && String(currentInput.value ?? '') === submitted) currentInput.value = ''
      }
      if (!current()) return
      const reading = owner.reading
      // A GET dispatched before this POST may not yet contain the sent letter.
      owner.read++
      owner.reading = false
      const bubbles = card.querySelector('.fd-mail-bubbles')
      if (bubbles) bubbles.innerHTML += `<div class="fd-mail-bubble fd-out"><div class="fd-mail-text">${escapeHtml(text)}</div><div class="fd-mail-time">刚刚</div></div>`
      if (bubbles) bubbles.querySelector?.('.fd-empty')?.remove()
      state.letters = [{ direction: 'out', plaintext: text, created_at: new Date().toISOString() }, ...(state.letters ?? [])]
      if (note) { note.hidden = true; note.textContent = '' }
      if (reading) void readMailThread(owner)
    } else {
      if (r?.error === 'send_failed' && typeof r?.letter_id === 'string') mailRetry[id] = { letterId: r.letter_id, text }
      else if (pending && r?.error !== 'send_failed') delete mailRetry[id]
      if (!current()) return
      if (note) {
        note.hidden = false
        note.textContent = r?.error === 'send_failed' && (pending || mailRetry[id])
          ? '寄出失败 —— 对方的 CC 暂时联系不上，再点一次「寄出」会重试同一封'
          : MAIL_FAIL_COPY[String(r?.error)] ?? `寄出失败：${String(r?.error ?? '未知错误')}`
      }
    }
  } catch (err) {
    if (!current()) return
    if (note) {
      note.hidden = false
      const error = readErrorText(err)
      note.textContent = isSocialUnwired(error) ? `笔友功能未启用 —— ${SOCIAL_OFF_HINT}到「觅食网」区块可以启用。` : `寄出失败：${error}`
    }
  } finally {
    if (mailSending.get(id) === operation) {
      mailSending.delete(id)
      if (current()) target.disabled = false
      setMailSending(id)
    }
  }
}

async function onInboundToggle() {
  const toggle = document.getElementById('fd-inbound-toggle')
  const note = document.getElementById('fd-inbound-note')
  if (!toggle || toggle.disabled || !active || inboundOperation) return
  const operation = { generation: pageGeneration }
  inboundOperation = operation
  toggle.disabled = true
  const next = !toggle.classList.contains('fd-on')
  try {
    const r = await invokeApi('POST', '/v1/social/inbound', { enabled: next })
    if (!isPageCurrent(operation.generation) || inboundOperation !== operation) return
    if (typeof r?.enabled !== 'boolean') throw new Error('返回内容不完整')
    const enabled = r.enabled
    toggle.classList.toggle('fd-on', enabled)
    toggle.setAttribute('aria-checked', enabled ? 'true' : 'false')
    if (note) {
      note.hidden = false
      note.textContent = r.restart_required
        ? (enabled ? '已开启 —— 需重启守护进程后，别人的心愿才能真正传到你这。' : '已关闭 —— 需重启守护进程后生效。')
        : (enabled ? '已开启。' : '已关闭。')
    }
  } catch (err) {
    if (isPageCurrent(operation.generation) && note) { note.hidden = false; note.textContent = `切换失败：${readErrorText(err)}` }
  } finally {
    if (inboundOperation === operation) {
      inboundOperation = null
      const currentToggle = document.getElementById('fd-inbound-toggle')
      if (active && currentToggle) currentToggle.disabled = !inboundAvailable
    }
  }
}

// 配对码 — start(生成 6 位码,完成靠后端轮询引擎异步收边)+ accept(同步出结果)。
// 码展示期间每 15s 拉一次 agent 列表,出现新条目即判定配对完成。

/** @type {ReturnType<typeof setInterval> | null} */
let pairCountdownTimer = null
/** @type {ReturnType<typeof setInterval> | null} */
let pairPollTimer = null
let pairGeneration = 0
/** @typedef {{ kind: 'start'|'accept', generation: number, pageGeneration: number, button: HTMLButtonElement|null, label: string|null }} PairOperation */
/** @type {PairOperation|null} */
let pairOperation = null
/** @type {{ generation: number, pageGeneration: number }|null} */
let pairPollRequest = null

const PAIR_FAIL_COPY = /** @type {Record<string, string>} */ ({
  expired_or_wrong: '码不对或已过期 —— 让朋友重新生成一个试试',
  self_pair: '这是你自己的码，不能和自己配对',
  id_conflict: '对方的名字和你已有的朋友冲突 —— 让对方改名后重试',
  relay_drop_failed: '中继暂时联系不上，稍后再试',
})

/** @param {unknown} err */
function pairErrText(err) {
  const msg = err instanceof Error ? err.message : String(err)
  if (msg === 'pairing_not_wired') return `配对功能未启用 —— ${SOCIAL_OFF_HINT}到「觅食网」区块可以启用。`
  return `配对失败：${msg}`
}

/** @param {HTMLElement | null} note @param {string} text @param {'success' | 'error'} [state] */
function showPairNote(note, text, state = 'error') {
  if (!note) return
  note.hidden = false
  note.textContent = text
  note.classList.toggle('status-success', state === 'success')
  note.classList.toggle('status-error', state === 'error')
  note.setAttribute('role', 'status')
}

function stopPairTimers() {
  // Clearing intervals cannot cancel an already dispatched read.
  pairGeneration++
  pairPollRequest = null
  if (pairCountdownTimer !== null) { clearInterval(pairCountdownTimer); pairCountdownTimer = null }
  if (pairPollTimer !== null) { clearInterval(pairPollTimer); pairPollTimer = null }
}

function hidePairPanel() {
  const panel = document.getElementById('fd-pair-panel')
  if (panel) { panel.hidden = true; panel.innerHTML = '' }
}

function releasePairOperation() {
  const operation = pairOperation
  pairOperation = null
  if (operation?.button) {
    operation.button.disabled = false
    operation.button.textContent = operation.label
  }
}

function deactivatePairing() {
  stopPairTimers()
  releasePairOperation()
  hidePairPanel()
  const note = document.getElementById('fd-pair-note')
  if (note) { note.hidden = true; note.textContent = '' }
}

/** @param {number} generation @param {number} currentPageGeneration */
function isPairCurrent(generation, currentPageGeneration) {
  return isPageCurrent(currentPageGeneration) && pairGeneration === generation
}

/** @param {PairOperation} operation */
function isPairOperationCurrent(operation) {
  return pairOperation === operation && isPairCurrent(operation.generation, operation.pageGeneration)
}

/** @param {'start'|'accept'} kind @param {HTMLButtonElement|null} button */
function beginPairOperation(kind, button) {
  if (!active || pairOperation?.kind === kind) return null
  // Switching between generating and accepting abandons the old UI result.
  stopPairTimers()
  releasePairOperation()
  hidePairPanel()
  const operation = { kind, generation: pairGeneration, pageGeneration, button, label: button?.textContent ?? null }
  pairOperation = operation
  if (button) { button.disabled = true; if (kind === 'accept') button.textContent = '配对中…' }
  const note = document.getElementById('fd-pair-note')
  if (note) { note.hidden = true; note.textContent = '' }
  return operation
}

async function onPairStart() {
  const note = document.getElementById('fd-pair-note')
  const btn = /** @type {HTMLButtonElement | null} */ (document.getElementById('fd-pair-start'))
  const operation = beginPairOperation('start', btn)
  if (!operation) return
  try {
    // A failed snapshot cannot safely distinguish a new friend from an old one.
    const before = /** @type {{agents?:Array<any>}|null} */ (await invokeApi('GET', '/v1/a2a/list').catch(() => null))
    if (!isPairOperationCurrent(operation)) return
    if (!Array.isArray(before?.agents)) {
      showPairNote(note, '暂时读不到现有朋友列表，稍后再试')
      return
    }
    const knownIds = new Set(before.agents.map(a => String(a.id)))
    const r = /** @type {{ok?:boolean, code?:string, expiresAt?:number, reason?:string}} */ (
      await invokeApi('POST', '/v1/pair/start'))
    if (!isPairOperationCurrent(operation)) return
    if (!r?.ok) {
      showPairNote(note, PAIR_FAIL_COPY[String(r?.reason)] ?? `配对失败：${String(r?.reason ?? '未知错误')}`)
      return
    }
    const expiresAt = Number(r.expiresAt) || 0
    renderPairPanel(String(r.code ?? ''), expiresAt, operation.generation, operation.pageGeneration)
    // Rendering an already expired code invalidates this operation too.
    if (!isPairOperationCurrent(operation)) return
    pairCountdownTimer = setInterval(() => updatePairCountdown(expiresAt, operation.generation, operation.pageGeneration), 1000)
    pairPollTimer = setInterval(() => { checkPairLanded(knownIds, operation.generation, operation.pageGeneration).catch(() => {}) }, 15_000)
  } catch (err) {
    if (isPairOperationCurrent(operation)) showPairNote(note, pairErrText(err))
  } finally {
    if (pairOperation === operation) releasePairOperation()
  }
}

/** @param {string} code @param {number} expiresAt @param {number} generation @param {number} currentPageGeneration */
function renderPairPanel(code, expiresAt, generation, currentPageGeneration) {
  const panel = document.getElementById('fd-pair-panel')
  if (!panel) return
  panel.hidden = false
  panel.innerHTML = `<div class="fd-pair-code">${escapeHtml(code)}</div>` +
    `<div class="fd-pair-cap">把这六位码给朋友，对方在觅食页输入就能连接。</div>` +
    `<div class="fd-pair-count" id="fd-pair-countdown"></div>`
  updatePairCountdown(expiresAt, generation, currentPageGeneration)
}

/** @param {number} expiresAt @param {number} generation @param {number} currentPageGeneration */
function updatePairCountdown(expiresAt, generation, currentPageGeneration) {
  if (!isPairCurrent(generation, currentPageGeneration)) return
  const left = Math.floor((expiresAt - Date.now()) / 1000)
  if (left <= 0) {
    stopPairTimers()
    hidePairPanel()
    const note = document.getElementById('fd-pair-note')
    showPairNote(note, '配对码已过期 —— 需要时再生成一个。')
    return
  }
  const el = document.getElementById('fd-pair-countdown')
  if (el) el.textContent = `有效期还剩 ${Math.floor(left / 60)} 分 ${left % 60} 秒`
}

/**
 * 轮询判定:agent 列表出现快照之外的新 id ⇒ 对方接受了码,配对完成。
 * @param {Set<string>} knownIds
 * @param {number} [generation]
 * @param {number} [currentPageGeneration]
 */
async function checkPairLanded(knownIds, generation = pairGeneration, currentPageGeneration = pageGeneration) {
  if (!isPairCurrent(generation, currentPageGeneration)) return
  if (pairPollRequest?.generation === generation && pairPollRequest.pageGeneration === currentPageGeneration) return
  const request = { generation, pageGeneration: currentPageGeneration }
  pairPollRequest = request
  try {
    const r = /** @type {{agents?:Array<any>}|null} */ (await invokeApi('GET', '/v1/a2a/list').catch(() => null))
    if (pairPollRequest !== request || !isPairCurrent(generation, currentPageGeneration)) return
    const fresh = (r?.agents ?? []).find(a => !knownIds.has(String(a.id)))
    if (!fresh) return
    stopPairTimers()
    hidePairPanel()
    const note = document.getElementById('fd-pair-note')
    showPairNote(note, `配对成功：已和 ${fresh.name || fresh.id} 成为邻居`, 'success')
    refresh().catch(() => {})
  } finally {
    // A previous poll cannot unlock a newer generation's pending read.
    if (pairPollRequest === request) pairPollRequest = null
  }
}

async function onPairAccept() {
  if (!active || pairOperation?.kind === 'accept') return
  const input = /** @type {HTMLInputElement | null} */ (document.getElementById('fd-pair-code'))
  const note = document.getElementById('fd-pair-note')
  const btn = /** @type {HTMLButtonElement | null} */ (document.getElementById('fd-pair-accept'))
  const submittedValue = String(input?.value ?? '')
  const code = submittedValue.trim()
  if (!/^\d{6}$/.test(code)) {
    showPairNote(note, '配对码是 6 位数字')
    return
  }
  const operation = beginPairOperation('accept', btn)
  if (!operation) return
  try {
    const r = /** @type {{ok?:boolean, peer?:{self_id?:string, name?:string}, reason?:string}} */ (
      await invokeApi('POST', '/v1/pair/accept', { code }))
    if (!isPairOperationCurrent(operation)) return
    if (r?.ok) {
      stopPairTimers()
      hidePairPanel()
      showPairNote(note, `配对成功：已和 ${r.peer?.name ?? r.peer?.self_id ?? '对方'} 成为邻居`, 'success')
      if (input && input.value === submittedValue) input.value = ''
      refresh().catch(() => {})
    } else {
      showPairNote(note, PAIR_FAIL_COPY[String(r?.reason)] ?? `配对失败：${String(r?.reason ?? '未知错误')}`)
    }
  } catch (err) {
    if (isPairOperationCurrent(operation)) showPairNote(note, pairErrText(err))
  } finally {
    if (pairOperation === operation) releasePairOperation()
  }
}

// Test seams — onInboundToggle is module-private (wired via addEventListener
// in initA2AAgentsTab), so unit tests reach it through these thin re-exports
// rather than simulating real DOM events.
export const __onInboundToggleForTest = onInboundToggle
export const __onMailboxActionForTest = onMailboxAction
export const __onPairStartForTest = onPairStart
export const __onPairAcceptForTest = onPairAccept
export const __checkPairLandedForTest = checkPairLanded
export const __stopPairTimersForTest = stopPairTimers

// ── Test modal ────────────────────────────────────────────────────────────
// Lets the operator validate either direction of the A2A loop without
// dropping to the CLI. Inbound: posts via daemon to its own /a2a/notify
// (notification lands in WeChat chat). Outbound: posts to the registered
// agent's URL via /v1/a2a/send.

let testAgentId = ''

/** @param {string} id */
async function openTestModal(id) {
  if (!active) return
  const modal = document.getElementById('a2a-test-modal')
  if (!(modal instanceof HTMLDialogElement)) return
  testSession = { id, generation: pageGeneration }
  const title = document.getElementById('a2a-test-title')
  if (title) title.textContent = `测试连通 · ${id}`
  const textInput = document.getElementById('a2a-test-text')
  if (textInput) textInput.value = `test from ${id} via wechat-cc`
  const result = document.getElementById('a2a-test-result')
  if (result) { result.textContent = ''; result.className = 'a2a-test-result' }
  if (!modal.open) modal.showModal()
  syncTestButtons()
}
function isTestCurrent(session) {
  const modal = document.getElementById('a2a-test-modal')
  return !!session && testSession === session && isPageCurrent(session.generation)
    && modal instanceof HTMLDialogElement && modal.open
}
function syncTestButtons() {
  if (!isTestCurrent(testSession)) return
  for (const id of ['a2a-test-inbound', 'a2a-test-outbound']) {
    const button = document.getElementById(id)
    if (button) button.disabled = testSending.has(testSession.id)
  }
}

/** @param {boolean} outbound */
async function runTest(outbound) {
  const session = testSession
  if (!isTestCurrent(session) || testSending.has(session.id)) return
  const textInput = document.getElementById('a2a-test-text')
  const result = document.getElementById('a2a-test-result')
  if (!result) return
  const text = textInput?.value || `test from ${session.id} via wechat-cc`
  const operation = {}
  testSending.set(session.id, operation)
  syncTestButtons()
  result.textContent = 'sending…'
  result.className = 'a2a-test-result pending'
  try {
    const r = await invokeApi('POST', '/v1/a2a/test', { agent_id: session.id, text, outbound })
    if (!isTestCurrent(session)) return
    if (r?.ok) {
      const dir = r.direction === 'in' ? 'inbound' : 'outbound'
      const status = r.http_status ? ` (HTTP ${r.http_status})` : ''
      result.textContent = `${dir} delivered${status}` + (r.direction === 'in' ? ` — check your WeChat chat for [A2A:${session.id}] ${text}` : '')
      result.className = 'a2a-test-result ok'
    } else {
      const status = r?.http_status ? ` (HTTP ${r.http_status})` : ''
      result.textContent = `${r?.direction ?? 'test'} failed: ${r?.error ?? 'unknown error'}${status}`
      result.className = 'a2a-test-result fail'
    }
    if (isTestCurrent(session)) refresh().catch(() => {})
  } catch (err) {
    if (!isTestCurrent(session)) return
    result.textContent = `request failed: ${readErrorText(err)}`
    result.className = 'a2a-test-result fail'
  } finally {
    if (testSending.get(session.id) === operation) testSending.delete(session.id)
    syncTestButtons()
  }
}

function closeTestModal() {
  testSession = null
  const modal = document.getElementById('a2a-test-modal')
  if (modal instanceof HTMLDialogElement && modal.open) modal.close()
}

function openAddModal() {
  if (!active) return
  const modal = document.getElementById('a2a-add-modal')
  if (!(modal instanceof HTMLDialogElement)) return
  const preview = /** @type {HTMLElement | null} */ (modal.querySelector('#a2a-add-preview'))
  const success = /** @type {HTMLElement | null} */ (modal.querySelector('#a2a-add-success'))
  const form    = /** @type {HTMLFormElement | null} */ (modal.querySelector('#a2a-add-form'))
  if (preview) preview.hidden = true
  if (success) success.hidden = true
  if (form) { form.hidden = false; form.reset() }
  invalidateAddSession()
  addSession = { generation: pageGeneration }
  const submit = form?.querySelector('button[type="submit"]')
  if (submit) { submit.disabled = false; submit.textContent = '看看是谁 →' }
  syncInstallButton()
  if (!modal.open) modal.showModal()
}

function invalidateAddSession() {
  addSession = null
  previewOperation = null
  previewedCard = null
  previewedUrl = ''
}
function isAddCurrent(session) {
  const modal = document.getElementById('a2a-add-modal')
  return !!session && addSession === session && isPageCurrent(session.generation)
    && modal instanceof HTMLDialogElement && modal.open
}
function syncInstallButton() {
  const preview = document.getElementById('a2a-add-preview')
  const id = preview?.querySelector('input[name="id"]')?.value?.trim() ?? ''
  const button = document.getElementById('a2a-install-confirm')
  if (button) {
    button.disabled = addInstalling.has(id)
    button.textContent = button.disabled ? '连接中…' : '连上'
  }
}
function closeAddModal(refreshList = true) {
  invalidateAddSession()
  const modal = document.getElementById('a2a-add-modal')
  if (modal instanceof HTMLDialogElement && modal.open) modal.close()
  if (refreshList && active) refresh().catch(() => {})
}

/** @param {SubmitEvent} e */
async function onPreviewSubmit(e) {
  e.preventDefault()
  const session = addSession
  if (!isAddCurrent(session) || previewOperation) return
  const operation = { session }
  previewOperation = operation
  const form = /** @type {HTMLFormElement} */ (e.target)
  const urlInput = /** @type {HTMLInputElement} */ (form.elements.namedItem('url'))
  const url = urlInput.value
  const submitBtn = /** @type {HTMLButtonElement | null} */ (form.querySelector('button[type="submit"]'))
  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = '找它中…' }
  try {
    const resp = /** @type {Record<string, any>} */ (await invokeApi('POST', '/v1/a2a/preview', { url }))
    if (!isAddCurrent(session) || previewOperation !== operation) return
    if (resp && 'error' in resp) { showToast(String(resp.error)); return }
    previewedCard = resp
    previewedUrl = url

    const nameEl = document.getElementById('a2a-preview-name')
    const descEl = document.getElementById('a2a-preview-description')
    const capsEl = document.getElementById('a2a-preview-capabilities')
    if (nameEl) nameEl.textContent = String(resp.name ?? '')
    if (descEl) descEl.textContent = String(resp.description ?? '')
    if (capsEl) {
      capsEl.innerHTML = ''
      const caps = Array.isArray(resp.capabilities) ? resp.capabilities : []
      for (const c of caps) {
        const li = document.createElement('li')
        li.textContent = `${c.name}${c.description ? ' — ' + c.description : ''}`
        capsEl.appendChild(li)
      }
    }

    form.hidden = true
    const preview = /** @type {HTMLElement | null} */ (document.getElementById('a2a-add-preview'))
    if (preview) {
      preview.hidden = false
      const idInput = /** @type {HTMLInputElement | null} */ (preview.querySelector('input[name="id"]'))
      if (idInput) idInput.value = slugify(String(resp.name ?? ''))
    }
    syncInstallButton()
  } catch (err) {
    if (isAddCurrent(session)) showToast(`没找到对方的 CC：${readErrorText(err)}`)
  } finally {
    if (previewOperation === operation) {
      previewOperation = null
      if (isAddCurrent(session) && submitBtn) { submitBtn.disabled = false; submitBtn.textContent = '看看是谁 →' }
    }
  }
}

async function onInstallConfirm() {
  const session = addSession
  if (!isAddCurrent(session)) return
  const preview = /** @type {HTMLElement | null} */ (document.getElementById('a2a-add-preview'))
  if (!preview || preview.hidden || !previewedCard) return
  const idInput = /** @type {HTMLInputElement | null} */ (preview.querySelector('input[name="id"]'))
  const keyInput = /** @type {HTMLInputElement | null} */ (preview.querySelector('input[name="outbound_key"]'))
  const id = idInput?.value?.trim() ?? ''
  const outboundKey = keyInput?.value?.trim() ?? ''
  if (!id) { showToast('先给它起个短名（英文或数字）。'); return }

  if (addInstalling.has(id)) return
  const operation = {}
  addInstalling.set(id, operation)
  const card = previewedCard
  const url = previewedUrl
  const confirmBtn = document.getElementById('a2a-install-confirm')
  if (confirmBtn instanceof HTMLButtonElement) { confirmBtn.disabled = true; confirmBtn.textContent = '连接中…' }
  try {
    const r = /** @type {Record<string, any>} */ (await invokeApi('POST', '/v1/a2a/install', {
      id,
      name: /** @type {any} */ (card).name,
      url,
      outbound_api_key: outboundKey,
    }))
    if (!isAddCurrent(session)) return
    if (!r || !r.ok) {
      showToast(String(r?.error ?? 'install failed'))
      return
    }
    const info = /** @type {Record<string, any>} */ (await invokeApi('GET', '/v1/a2a/info').catch(() => null))
    if (!isAddCurrent(session)) return
    preview.hidden = true
    const success = /** @type {HTMLElement | null} */ (document.getElementById('a2a-add-success'))
    if (success) success.hidden = false
    const curlPre = document.getElementById('a2a-add-curl')
    if (curlPre) {
      const baseUrl = info?.base_url ?? '<wechat-cc-base-url>'
      curlPre.textContent =
        `curl -X POST ${baseUrl}/a2a/notify \\\n` +
        `  -H "Authorization: Bearer ${r.inbound_api_key}" \\\n` +
        `  -H "Content-Type: application/json" \\\n` +
        `  -d '{"agent_id":"${id}","text":"hello"}'`
    }
  } catch (err) {
    if (isAddCurrent(session)) showToast(`没连上：${readErrorText(err)}`)
  } finally {
    if (addInstalling.get(id) === operation) addInstalling.delete(id)
    if (isAddCurrent(addSession)) syncInstallButton()
  }
}

/** @param {string} id */
async function openActivityDrawer(id) {
  if (!active) return
  const generation = pageGeneration
  const revision = ++activityRevision
  const drawer = /** @type {HTMLElement | null} */ (document.getElementById('a2a-activity-drawer'))
  const titleEl = document.getElementById('a2a-activity-title')
  if (!drawer || !titleEl) return
  titleEl.textContent = `${id} · 最近往来`
  const ul = document.getElementById('a2a-activity-list')
  if (ul) ul.innerHTML = '<li class="empty">加载中…</li>'
  drawer.hidden = false

  let r
  try {
    r = await invokeApi('GET', `/v1/a2a/activity?agent_id=${encodeURIComponent(id)}&limit=50`)
    if (!Array.isArray(r?.events)) throw new Error('返回内容不完整')
  } catch (err) {
    if (isPageCurrent(generation) && activityRevision === revision && !drawer.hidden && ul) ul.innerHTML = `<li class="empty">往来记录暂时读不到：${escapeHtml(readErrorText(err))}</li>`
    return
  }
  if (!isPageCurrent(generation) || activityRevision !== revision || drawer.hidden || !ul) return
  ul.innerHTML = ''
  const events = r?.events ?? []
  if (events.length === 0) {
    ul.innerHTML = '<li class="empty">No activity yet.</li>'
  } else {
    for (const ev of events) {
      const li = document.createElement('li')
      li.className = `event ${ev.direction}`
      const arrow = ev.direction === 'in' ? '←' : '→'
      const statusNote = ev.status === 'ok' ? '' : ` [${ev.status}${ev.http_status ? ' ' + ev.http_status : ''}]`
      li.innerHTML = `<time>${escapeHtml(String(ev.ts))}</time> ${arrow} ${escapeHtml(String(ev.text))}${escapeHtml(statusNote)}`
      ul.appendChild(li)
    }
  }
}

function closeActivityDrawer() {
  activityRevision++
  const drawer = document.getElementById('a2a-activity-drawer')
  if (drawer) drawer.hidden = true
}

// ── utilities ─────────────────────────────────────────────────────────────

/** @param {string} s */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, m => (
    /** @type {Record<string,string>} */ ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[m] ?? m
  ))
}

/** @param {string} s */
function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

import { showToast } from "../view.js"
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
import { initHuntBag, renderHuntBag } from './journal.js'
import { initPeople, renderPeople } from './people.js'
import { initWishes, refreshWishes } from './wishes.js'

// ── module-level state ────────────────────────────────────────────────────
/** @type {Record<string, unknown> | null} */
let previewedCard = null
let previewedUrl = ''

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
  if (!btn || btn.disabled) return
  btn.disabled = true
  const original = btn.textContent
  btn.textContent = '启用中…'
  try {
    const r = /** @type {{enabled?:boolean, restart_required?:boolean}} */ (
      await invokeApi('POST', '/v1/social/enable', { enabled: true }))
    if (!r || r.enabled !== true) throw new Error('启用未生效')
    btn.textContent = '已启用'
    showToast(r.restart_required ? '社交已启用 —— 重启守护进程后生效' : '社交已启用')
  } catch (err) {
    btn.disabled = false
    btn.textContent = original
    showToast(`启用失败:${err instanceof Error ? err.message : String(err)}`)
  }
}

export async function initA2AAgentsTab() {
  const list = document.getElementById('a2a-agents-list')
  if (!list) return

  // Load initial list.
  await refresh().catch(err => {
    if (list) list.innerHTML = `<li class="empty">加载失败：${escapeHtml(String(err?.message ?? err))}</li>`
  })

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
  // signal. ESC is handled natively by showModal().
  document.getElementById('a2a-add-modal-close')?.addEventListener('click', closeAddModal)
  document.getElementById('a2a-add-modal')?.addEventListener('click', (e) => {
    if (e.target instanceof HTMLDialogElement) closeAddModal()
  })
  document.getElementById('a2a-test-modal-close')?.addEventListener('click', closeTestModal)
  document.getElementById('a2a-test-modal')?.addEventListener('click', (e) => {
    if (e.target instanceof HTMLDialogElement) closeTestModal()
  })
  document.getElementById('a2a-activity-close')?.addEventListener('click', () => {
    const drawer = document.getElementById('a2a-activity-drawer')
    if (drawer) drawer.hidden = true
  })
  document.getElementById('a2a-test-inbound')?.addEventListener('click', () => runTest(false))
  document.getElementById('a2a-test-outbound')?.addEventListener('click', () => runTest(true))
  document.getElementById('a2a-test-close')?.addEventListener('click', closeTestModal)
  // Delegated click handler on the list container (attached ONCE; not per
  // refresh — duplicating would multiply calls per click).
  list.addEventListener('click', onCardAction)

  // 觅食台 — inbound toggle, pairing.
  document.getElementById('fd-inbound-toggle')?.addEventListener('click', onInboundToggle)
  document.getElementById('fd-inbound-toggle')?.addEventListener('keydown', (e) => {
    if (e instanceof KeyboardEvent && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onInboundToggle() }
  })
  document.getElementById('fd-pair-start')?.addEventListener('click', onPairStart)
  document.getElementById('fd-pair-accept')?.addEventListener('click', onPairAccept)
  document.getElementById('fd-mailbox')?.addEventListener('click', onMailboxAction)
  initHuntBag()
  initPeople()
  initWishes()
}

export async function refresh() {
  const [listResp, inbound, mailResp, huntResp, peopleResp] = await Promise.all([
    /** @type {Promise<{agents?:Array<any>}|null>}   */ (invokeApi('GET', '/v1/a2a/list').catch(() => null)),
    /** @type {Promise<any>}                          */ (invokeApi('GET', '/v1/social/inbound').catch(() => null)),
    /** @type {Promise<{channels?:Array<any>}|null>} */ (invokeApi('GET', '/v1/penpal/channels').catch(() => null)),
    /** @type {Promise<{items?:Array<any>}|null>}    */ (invokeApi('GET', '/v1/journal').catch(() => null)),
    /** @type {Promise<{relationships?:Array<any>}|null>} */ (invokeApi('GET', '/v1/social/relationships').catch(() => null)),
  ])

  // keep the server-status banner (best-effort, as before)
  const banner = document.getElementById('a2a-server-banner')
  if (banner) {
    const info = /** @type {Record<string, any>} */ (await invokeApi('GET', '/v1/a2a/info').catch(() => null))
    renderServerBanner(info, banner)
  }

  renderForageDesk({
    agents: listResp ? (listResp.agents ?? []) : null,
    inbound,
    mailbox: mailResp ? (mailResp.channels ?? []) : null,
  })
  // 背包自己渲染 —— 打猎和社交觅食是两条独立的链路,社交没启用时背包
  // 照样有东西(它不依赖任何 peer)。
  renderHuntBag({ items: huntResp ? (huntResp.items ?? []) : null })
  renderPeople({ relationships: peopleResp ? (peopleResp.relationships ?? []) : null })
  // 心愿自己拉自己的:回信是**别人**什么时候回就什么时候到,不刷这一块的话,
  // 「几张回信」会一直停在派出去那一刻的 0。
  await refreshWishes()
  // 折叠区的小字:几封未读 —— 让折着的东西不至于被忘掉
  const sub = document.getElementById('fd-tools-sub')
  if (sub) {
    const unread = (mailResp ? (mailResp.channels ?? []) : []).reduce(/** @param {number} a @param {any} c */ (a, c) => a + (Number(c.unread) || 0), 0)
    sub.textContent = unread ? `${unread} 封未读` : ''
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
    banner.innerHTML = '<span class="dot off"></span> 连不上你的 bot——daemon 没在跑？'
  } else if (!info.enabled) {
    banner.innerHTML = '<span class="dot off"></span> 觅食网还没开通 — 在 <code>agent-config.json</code> 加 <code>"a2a_listen": { "port": 8717 }</code> 后重启 daemon'
  } else {
    const url = String(info.base_url ?? '')
    banner.innerHTML = `<span class="dot on"></span> 你的 bot 在线，朋友的 bot 能找到它
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
    list.innerHTML = '<li class="empty">还没连上朋友的 bot — 生成一个配对码念给朋友，就能连上。</li>'
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
  const agents = Array.isArray(data.agents) ? data.agents : []
  // mailbox 是这里仅剩的、依赖「社交」总开关的数据源(seek/echo 链路已撤下)——
  // 用它的 null 与否当「社交功能是否启用」的信号。
  const socialWired = data.mailbox != null

  // ── hero status ──────────────────────────────────────────────────────
  const status = document.getElementById('fd-hero-status')
  if (status) {
    const n = agents.length
    status.innerHTML =
      `<svg class="fd-frog" viewBox="0 0 30 30" fill="none" aria-hidden="true">` +
      `<ellipse cx="15" cy="19" rx="10" ry="8" fill="#8AA36F"/>` +
      `<circle cx="10" cy="10" r="4.2" fill="#8AA36F"/><circle cx="20" cy="10" r="4.2" fill="#8AA36F"/>` +
      `<circle cx="10" cy="10" r="2" fill="#fff"/><circle cx="20" cy="10" r="2" fill="#fff"/>` +
      `<circle cx="10.6" cy="10.4" r="1" fill="#3B3125"/><circle cx="20.6" cy="10.4" r="1" fill="#3B3125"/>` +
      `<path d="M11 20 q4 3 8 0" stroke="#3B3125" stroke-width="1.3" stroke-linecap="round"/></svg>` +
      `<span class="fd-status-line"><span>连着 <b>${n} 位</b>朋友的 bot</span></span>`
  }
  const note = document.getElementById('fd-social-note')
  if (note) {
    if (socialWired) { note.hidden = true; note.textContent = '' }
    else { note.hidden = false; note.textContent = '社交功能未启用 —— 在 §③ 打开「让朋友的 bot 能找到我」并重启守护进程即可。' }
  }

  // ── ✉️ mailbox ───────────────────────────────────────────────────────
  // 有线程展开时跳过整块重建:回信输入框里可能有未寄出的草稿,而 refresh()
  // 会被许多无关操作触发(暂停 agent/揭晓/配对轮询…)。收起后的下一次
  // refresh 正常重建对齐服务端。
  const mailbox = document.getElementById('fd-mailbox')
  const mbCount = document.getElementById('fd-mailbox-count')
  const chans = Array.isArray(data.mailbox) ? data.mailbox : []
  const mailThreadOpen = !!(openMailThreadEl && !openMailThreadEl.hidden)
  if (mailbox && !mailThreadOpen) {
    openMailThreadEl = null   // 整块重建换掉了旧节点,清引用防 stale
  }
  if (mailbox && !mailThreadOpen) {
    if (data.mailbox == null) {
      mailbox.innerHTML = renderSocialOffState('笔友信箱还没开 —— ')
    } else if (chans.length === 0) {
      mailbox.innerHTML = `<div class="fd-empty">还没有笔友 —— 等一张明信片揭晓牵线后，就能在这里通信了。</div>`
    } else {
      mailbox.innerHTML = chans.map(c => renderMailChannel(c)).join('')
    }
  }
  if (mbCount && !mailThreadOpen) {
    const totalUnread = chans.reduce((s, c) => s + (Number(c.unread) || 0), 0)
    mbCount.textContent = totalUnread ? `${totalUnread} 封未读` : ''
  }

  // ── ③ net: inbound toggle + peers summary + agent cards ──────────────
  const toggle = document.getElementById('fd-inbound-toggle')
  if (toggle) {
    const on = !!(data.inbound && data.inbound.enabled)
    toggle.classList.toggle('fd-on', on)
    toggle.setAttribute('aria-checked', on ? 'true' : 'false')
  }
  const peers = document.getElementById('fd-peers')
  const peersCount = document.getElementById('fd-peers-count')
  if (peers) {
    const shown = agents.slice(0, 4)
    let html = shown.map(a => `<span class="fd-peer">${escapeHtml(lastGlyph(a.name || a.id))}</span>`).join('')
    if (agents.length > 4) html += `<span class="fd-peer">+${agents.length - 4}</span>`
    peers.innerHTML = html
  }
  if (peersCount) peersCount.textContent = `连着 ${agents.length} 位朋友的 bot`

  // preserved agent-management surface
  const list = document.getElementById('a2a-agents-list')
  if (list) renderAgents(agents, list)
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
    `<div class="fd-mail-head" data-action="mail-toggle" data-id="${escapeHtml(c.id)}">` +
    `<span class="fd-mail-peer">${escapeHtml(c.peer_label || '笔友')}</span>` +
    (c.title ? `<span class="fd-mail-title">「${escapeHtml(c.title)}」</span>` : '') +
    (unread ? `<span class="fd-mail-unread">${unread}</span>` : '') +
    (c.last_preview ? `<span class="fd-mail-preview">${escapeHtml(c.last_preview)}</span>` : '') +
    `</div>` +
    `<div class="fd-mail-thread" hidden></div>` +
    `</div>`
}

/** @param {Array<any>} letters — 路由返回 newest-first;渲染 reverse 成正序。
 *  @param {string} channelId */
function renderMailThread(letters, channelId) {
  const bubbles = letters.slice().reverse().map(l =>
    `<div class="fd-mail-bubble ${l.direction === 'out' ? 'fd-out' : 'fd-in'}">` +
    `<div class="fd-mail-text">${escapeHtml(l.plaintext ?? '')}</div>` +
    `<div class="fd-mail-time">${escapeHtml(fdRelTime(l.created_at))}</div>` +
    `</div>`).join('')
  return `<div class="fd-mail-bubbles">${bubbles || '<div class="fd-empty">还没有信 —— 写下第一封吧。</div>'}</div>` +
    `<div class="fd-mail-replyrow">` +
    `<input class="fd-mail-input" placeholder="写封信…" maxlength="2000">` +
    `<button class="fd-btn fd-btn-primary" data-action="mail-send" data-id="${escapeHtml(channelId)}">寄出</button>` +
    `</div>` +
    `<div class="fd-mail-note" hidden></div>`
}

// ── event handlers ────────────────────────────────────────────────────────

/** @param {MouseEvent} e */
async function onCardAction(e) {
  const target = e.target
  if (!(target instanceof HTMLButtonElement)) return
  const action = target.dataset.action
  // 社交总开关不针对某个 peer,所以没有 data-id —— 必须在下面那个
  // "没有 id 就返回" 的守卫之前处理掉。
  if (action === 'social-enable') { await onSocialEnableClick(target); return }
  const id = target.dataset.id
  if (!action || !id) return

  if (action === 'pause') {
    const card = target.closest('.a2a-agent-card')
    const wasPaused = card?.classList.contains('paused')
    try {
      await invokeApi('POST', '/v1/a2a/pause', { id, paused: !wasPaused })
      await refresh()
    } catch (err) {
      showToast(`${wasPaused ? '恢复' : '暂停'}失败：${err instanceof Error ? err.message : String(err)}`)
    }
  } else if (action === 'remove') {
    if (!confirm(`断开和「${id}」的连接？之后可以随时重新配对。`)) return
    try {
      await invokeApi('POST', '/v1/a2a/remove', { id })
      await refresh()
    } catch (err) {
      showToast(`断开失败：${err instanceof Error ? err.message : String(err)}`)
    }
  } else if (action === 'activity') {
    await openActivityDrawer(id).catch(err =>
      showToast(`往来记录打不开：${err instanceof Error ? err.message : String(err)}`)
    )
  } else if (action === 'test') {
    await openTestModal(id).catch(err =>
      showToast(`打不开测试窗口：${err instanceof Error ? err.message : String(err)}`)
    )
  }
}

// ✉️ 信箱 — 展开看信(即读即清未读) + 回信。同时只展开一个线程。
/** @type {any} */
let openMailThreadEl = null

const MAIL_FAIL_COPY = /** @type {Record<string, string>} */ ({
  channel_not_open: '这条信道还没打开 —— 双方都揭晓后才能通信',
  no_route: '找不到通往对方的路 —— 稍后再试',
  send_failed: '寄出失败 —— 对方的 bot 暂时联系不上，稍后再试',
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
  if (target.dataset.action === 'mail-toggle') return openMailThread(target)
  if (target.dataset.action === 'mail-send') return sendMailReply(target)
}

/** @param {any} target */
async function openMailThread(target) {
  const card = typeof target.closest === 'function' ? target.closest('.fd-mail-chan') : null
  const thread = card ? card.querySelector('.fd-mail-thread') : null
  const id = target.dataset.id
  if (!card || !thread || !id) return
  if (!thread.hidden) { thread.hidden = true; thread.innerHTML = ''; openMailThreadEl = null; return }
  if (openMailThreadEl && openMailThreadEl !== thread) { openMailThreadEl.hidden = true; openMailThreadEl.innerHTML = '' }
  openMailThreadEl = thread
  thread.hidden = false
  thread.innerHTML = '<div class="fd-empty">加载中…</div>'
  try {
    const r = /** @type {{letters?:Array<any>}} */ (await invokeApi('GET', `/v1/penpal/letters?channel_id=${encodeURIComponent(id)}`))
    thread.innerHTML = renderMailThread(r?.letters ?? [], id)
    // 展开即读:后端清 + 本地摘角标(fire-and-forget,失败不打断看信)。
    invokeApi('POST', '/v1/penpal/letters/read', { channel_id: id }).catch(() => {})
    const badge = card.querySelector('.fd-mail-unread')
    if (badge && typeof badge.remove === 'function') badge.remove()
  } catch (err) {
    thread.innerHTML = `<div class="fd-empty">看信失败：${escapeHtml(err instanceof Error ? err.message : String(err))}</div>`
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
  const card = typeof target.closest === 'function' ? target.closest('.fd-mail-chan') : null
  if (!id || !card) return
  const input = card.querySelector('.fd-mail-input')
  const note = card.querySelector('.fd-mail-note')
  const text = String(input?.value ?? '').trim()
  if (!text) { if (note) { note.hidden = false; note.textContent = '先写点什么' } return }
  const pending = mailRetry[id]
  if (pending && pending.text === text) return resendMailReply(target, id, pending, card)
  delete mailRetry[id]   // 文本改了 ⇒ 当新信寄;旧的落库行维持现状
  target.disabled = true
  try {
    const r = /** @type {{ok?:boolean, error?:string, letter_id?:string}} */ (
      await invokeApi('POST', '/v1/penpal/letters', { channel_id: id, text }))
    if (r?.ok) {
      const bubbles = card.querySelector('.fd-mail-bubbles')
      if (bubbles) bubbles.innerHTML += `<div class="fd-mail-bubble fd-out"><div class="fd-mail-text">${escapeHtml(text)}</div><div class="fd-mail-time">刚刚</div></div>`
      if (input) input.value = ''
      if (note) { note.hidden = true; note.textContent = '' }
    } else if (r?.error === 'send_failed' && typeof r?.letter_id === 'string') {
      mailRetry[id] = { letterId: r.letter_id, text }
      if (note) { note.hidden = false; note.textContent = '寄出失败 —— 对方的 bot 暂时联系不上，再点一次「寄出」会重试同一封' }
    } else {
      if (note) { note.hidden = false; note.textContent = MAIL_FAIL_COPY[String(r?.error)] ?? `寄出失败：${String(r?.error ?? '未知错误')}` }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (note) { note.hidden = false; note.textContent = msg === 'penpal_not_wired' ? `笔友功能未启用 —— ${SOCIAL_OFF_HINT}到「觅食网」区块可以启用。` : `寄出失败：${msg}` }
  } finally {
    target.disabled = false
  }
}

/** 重投同一封(见 mailRetry 注释)。成功才乐观追加气泡 —— 原发失败时没追加过。
 *  气泡/清空用 pending.text(重投的真实内容),不能等 await 回来再读输入框:
 *  在途中用户可能改了字,重读会把没寄过的内容画进线程、还吞掉新草稿。
 *  @param {any} target  @param {string} channelId
 *  @param {{ letterId: string, text: string }} pending  @param {any} card */
async function resendMailReply(target, channelId, pending, card) {
  const input = card.querySelector('.fd-mail-input')
  const note = card.querySelector('.fd-mail-note')
  target.disabled = true
  try {
    const r = /** @type {{ok?:boolean, error?:string}} */ (
      await invokeApi('POST', '/v1/penpal/letters/resend', { letter_id: pending.letterId }))
    if (r?.ok) {
      delete mailRetry[channelId]
      const bubbles = card.querySelector('.fd-mail-bubbles')
      if (bubbles) bubbles.innerHTML += `<div class="fd-mail-bubble fd-out"><div class="fd-mail-text">${escapeHtml(pending.text)}</div><div class="fd-mail-time">刚刚</div></div>`
      // 只有输入框仍是这封信的内容才清空 —— 在途中打的新草稿不动。
      if (input && String(input.value ?? '').trim() === pending.text) input.value = ''
      if (note) { note.hidden = true; note.textContent = '' }
    } else if (r?.error === 'send_failed') {
      // 落库行还在,登记保留 —— 下次点击继续重投同一封。
      if (note) { note.hidden = false; note.textContent = '还是没寄出去 —— 稍后再点一次「寄出」重试同一封' }
    } else {
      // channel_not_open / unknown_letter 等:重投救不了,放弃登记走人话文案。
      delete mailRetry[channelId]
      if (note) { note.hidden = false; note.textContent = MAIL_FAIL_COPY[String(r?.error)] ?? `寄出失败：${String(r?.error ?? '未知错误')}` }
    }
  } catch (err) {
    if (note) { note.hidden = false; note.textContent = `寄出失败：${err instanceof Error ? err.message : String(err)}` }
  } finally {
    target.disabled = false
  }
}

async function onInboundToggle() {
  const toggle = document.getElementById('fd-inbound-toggle')
  const note = document.getElementById('fd-inbound-note')
  if (!toggle) return
  const next = !toggle.classList.contains('fd-on')
  try {
    const r = /** @type {{enabled?:boolean, restart_required?:boolean, error?:string}} */ (
      await invokeApi('POST', '/v1/social/inbound', { enabled: next }))
    const enabled = !!r?.enabled
    toggle.classList.toggle('fd-on', enabled)
    toggle.setAttribute('aria-checked', enabled ? 'true' : 'false')
    if (note) {
      note.hidden = false
      note.textContent = r?.restart_required
        ? (enabled ? '已开启 —— 需重启守护进程后，别人的心愿才能真正传到你这。' : '已关闭 —— 需重启守护进程后生效。')
        : (enabled ? '已开启。' : '已关闭。')
    }
  } catch (err) {
    if (note) { note.hidden = false; note.textContent = `切换失败：${err instanceof Error ? err.message : String(err)}` }
  }
}

// 配对码 — start(生成 6 位码,完成靠后端轮询引擎异步收边)+ accept(同步出结果)。
// 码展示期间每 15s 拉一次 agent 列表,出现新条目即判定配对完成。

/** @type {ReturnType<typeof setInterval> | null} */
let pairCountdownTimer = null
/** @type {ReturnType<typeof setInterval> | null} */
let pairPollTimer = null

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

function stopPairTimers() {
  if (pairCountdownTimer) { clearInterval(pairCountdownTimer); pairCountdownTimer = null }
  if (pairPollTimer) { clearInterval(pairPollTimer); pairPollTimer = null }
}

async function onPairStart() {
  const note = document.getElementById('fd-pair-note')
  const btn = /** @type {HTMLButtonElement | null} */ (document.getElementById('fd-pair-start'))
  stopPairTimers()
  if (note) { note.hidden = true; note.textContent = '' }
  if (btn) btn.disabled = true
  try {
    // 先快照现有 agent id,轮询时用差集判断新边落地。
    // 快照失败(before === null)要 fail-closed:直接中止,不然轮询会把任何已有
    // 老友都当成刚配对成功的新边(误判)。`{agents:[]}` 才是真正的“确实没有朋友”。
    const before = /** @type {{agents?:Array<any>}|null} */ (await invokeApi('GET', '/v1/a2a/list').catch(() => null))
    if (before === null) {
      if (note) { note.hidden = false; note.textContent = '暂时读不到现有朋友列表，稍后再试' }
      return
    }
    const knownIds = new Set((before.agents ?? []).map(a => String(a.id)))
    const r = /** @type {{ok?:boolean, code?:string, expiresAt?:number, reason?:string}} */ (
      await invokeApi('POST', '/v1/pair/start'))
    if (!r?.ok) {
      if (note) { note.hidden = false; note.textContent = PAIR_FAIL_COPY[String(r?.reason)] ?? `配对失败：${String(r?.reason ?? '未知错误')}` }
      return
    }
    renderPairPanel(String(r.code ?? ''), Number(r.expiresAt) || 0)
    pairCountdownTimer = setInterval(() => updatePairCountdown(Number(r.expiresAt) || 0), 1000)
    pairPollTimer = setInterval(() => { checkPairLanded(knownIds).catch(() => {}) }, 15_000)
  } catch (err) {
    if (note) { note.hidden = false; note.textContent = pairErrText(err) }
  } finally {
    if (btn) btn.disabled = false
  }
}

/** @param {string} code  @param {number} expiresAt */
function renderPairPanel(code, expiresAt) {
  const panel = document.getElementById('fd-pair-panel')
  if (!panel) return
  panel.hidden = false
  panel.innerHTML = `<div class="fd-pair-code">${escapeHtml(code)}</div>` +
    `<div class="fd-pair-cap">念给朋友 —— 对方在他的觅食台输入，或运行 <code>wechat-cc pair ${escapeHtml(code)}</code></div>` +
    `<div class="fd-pair-count" id="fd-pair-countdown"></div>`
  updatePairCountdown(expiresAt)
}

/** @param {number} expiresAt */
function updatePairCountdown(expiresAt) {
  const left = Math.floor((expiresAt - Date.now()) / 1000)
  if (left <= 0) {
    stopPairTimers()
    const panel = document.getElementById('fd-pair-panel')
    if (panel) { panel.hidden = true; panel.innerHTML = '' }
    const note = document.getElementById('fd-pair-note')
    if (note) { note.hidden = false; note.textContent = '配对码已过期 —— 需要时再生成一个。' }
    return
  }
  const el = document.getElementById('fd-pair-countdown')
  if (el) el.textContent = `有效期还剩 ${Math.floor(left / 60)} 分 ${left % 60} 秒`
}

/**
 * 轮询判定:agent 列表出现快照之外的新 id ⇒ 对方接受了码,配对完成。
 * @param {Set<string>} knownIds
 */
async function checkPairLanded(knownIds) {
  const r = /** @type {{agents?:Array<any>}|null} */ (await invokeApi('GET', '/v1/a2a/list').catch(() => null))
  const fresh = (r?.agents ?? []).find(a => !knownIds.has(String(a.id)))
  if (!fresh) return
  stopPairTimers()
  const panel = document.getElementById('fd-pair-panel')
  if (panel) { panel.hidden = true; panel.innerHTML = '' }
  const note = document.getElementById('fd-pair-note')
  if (note) { note.hidden = false; note.textContent = `🎉 配对成功：已和 ${fresh.name || fresh.id} 成为邻居` }
  refresh().catch(() => {})
}

async function onPairAccept() {
  const input = /** @type {HTMLInputElement | null} */ (document.getElementById('fd-pair-code'))
  const note = document.getElementById('fd-pair-note')
  const btn = /** @type {HTMLButtonElement | null} */ (document.getElementById('fd-pair-accept'))
  const code = String(input?.value ?? '').trim()
  if (!/^\d{6}$/.test(code)) {
    if (note) { note.hidden = false; note.textContent = '配对码是 6 位数字' }
    return
  }
  if (btn) { btn.disabled = true; btn.textContent = '配对中…' }
  try {
    const r = /** @type {{ok?:boolean, peer?:{self_id?:string, name?:string}, reason?:string}} */ (
      await invokeApi('POST', '/v1/pair/accept', { code }))
    if (r?.ok) {
      // 接受方也可能有一份自己发起的、还在倒计时/轮询的配对码——接受成功后
      // 那份 stale 状态必须清掉,否则过期定时器事后会用“配对码已过期”盖掉这条
      // 成功提示,轮询定时器还可能重复触发一次“配对成功”消息。
      stopPairTimers()
      const panel = document.getElementById('fd-pair-panel')
      if (panel) { panel.hidden = true; panel.innerHTML = '' }
      if (note) { note.hidden = false; note.textContent = `🎉 已和 ${r.peer?.name ?? r.peer?.self_id ?? '对方'} 成为邻居` }
      if (input) input.value = ''
      refresh().catch(() => {})
    } else {
      if (note) { note.hidden = false; note.textContent = PAIR_FAIL_COPY[String(r?.reason)] ?? `配对失败：${String(r?.reason ?? '未知错误')}` }
    }
  } catch (err) {
    if (note) { note.hidden = false; note.textContent = pairErrText(err) }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '配对' }
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
  testAgentId = id
  const modal = document.getElementById('a2a-test-modal')
  if (!(modal instanceof HTMLDialogElement)) return
  const title = document.getElementById('a2a-test-title')
  if (title) title.textContent = `测试连通 · ${id}`
  const textInput = /** @type {HTMLInputElement | null} */ (document.getElementById('a2a-test-text'))
  if (textInput) textInput.value = `test from ${id} via wechat-cc`
  const result = document.getElementById('a2a-test-result')
  if (result) { result.textContent = ''; result.className = 'a2a-test-result' }
  modal.showModal()
}

/** @param {boolean} outbound */
async function runTest(outbound) {
  const textInput = /** @type {HTMLInputElement | null} */ (document.getElementById('a2a-test-text'))
  const result = document.getElementById('a2a-test-result')
  if (!result) return
  const text = textInput?.value || `test from ${testAgentId} via wechat-cc`
  result.textContent = 'sending…'
  result.className = 'a2a-test-result pending'
  try {
    const r = /** @type {Record<string, any>} */ (await invokeApi('POST', '/v1/a2a/test', {
      agent_id: testAgentId, text, outbound,
    }))
    if (r?.ok) {
      const dir = r.direction === 'in' ? 'inbound' : 'outbound'
      const status = r.http_status ? ` (HTTP ${r.http_status})` : ''
      result.textContent = `✅ ${dir} delivered${status}` +
        (r.direction === 'in'
          ? ` — check your WeChat chat for [A2A:${testAgentId}] ${text}`
          : '')
      result.className = 'a2a-test-result ok'
    } else {
      const errMsg = r?.error ?? 'unknown error'
      const status = r?.http_status ? ` (HTTP ${r.http_status})` : ''
      result.textContent = `❌ ${r?.direction ?? 'test'} failed: ${errMsg}${status}`
      result.className = 'a2a-test-result fail'
    }
  } catch (err) {
    result.textContent = `❌ request failed: ${err instanceof Error ? err.message : String(err)}`
    result.className = 'a2a-test-result fail'
  }
  // Refresh the agent list (counts may have updated from this test).
  refresh().catch(() => {})
}

function closeTestModal() {
  const modal = document.getElementById('a2a-test-modal')
  if (modal instanceof HTMLDialogElement) modal.close()
}

function openAddModal() {
  const modal = document.getElementById('a2a-add-modal')
  if (!(modal instanceof HTMLDialogElement)) return
  const preview = /** @type {HTMLElement | null} */ (modal.querySelector('#a2a-add-preview'))
  const success = /** @type {HTMLElement | null} */ (modal.querySelector('#a2a-add-success'))
  const form    = /** @type {HTMLFormElement | null} */ (modal.querySelector('#a2a-add-form'))
  if (preview) preview.hidden = true
  if (success) success.hidden = true
  if (form) { form.hidden = false; form.reset() }
  previewedCard = null
  previewedUrl = ''
  modal.showModal()
}

function closeAddModal() {
  const modal = document.getElementById('a2a-add-modal')
  if (modal instanceof HTMLDialogElement) modal.close()
  refresh().catch(err => console.error('a2a refresh after modal close failed', err))
}

/** @param {SubmitEvent} e */
async function onPreviewSubmit(e) {
  e.preventDefault()
  const form = /** @type {HTMLFormElement} */ (e.target)
  const urlInput = /** @type {HTMLInputElement} */ (form.elements.namedItem('url'))
  const url = urlInput.value
  const submitBtn = /** @type {HTMLButtonElement | null} */ (form.querySelector('button[type="submit"]'))
  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = '找它中…' }
  try {
    const resp = /** @type {Record<string, any>} */ (await invokeApi('POST', '/v1/a2a/preview', { url }))
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
  } catch (err) {
    showToast(`没找到对方 bot：${err instanceof Error ? err.message : String(err)}`)
  } finally {
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = '看看是谁 →' }
  }
}

async function onInstallConfirm() {
  const preview = /** @type {HTMLElement | null} */ (document.getElementById('a2a-add-preview'))
  if (!preview || !previewedCard) return
  const idInput = /** @type {HTMLInputElement | null} */ (preview.querySelector('input[name="id"]'))
  const keyInput = /** @type {HTMLInputElement | null} */ (preview.querySelector('input[name="outbound_key"]'))
  const id = idInput?.value?.trim() ?? ''
  const outboundKey = keyInput?.value?.trim() ?? ''
  if (!id) { showToast('先给它起个短名（英文或数字）。'); return }

  const confirmBtn = document.getElementById('a2a-install-confirm')
  if (confirmBtn instanceof HTMLButtonElement) { confirmBtn.disabled = true; confirmBtn.textContent = '连接中…' }
  try {
    const r = /** @type {Record<string, any>} */ (await invokeApi('POST', '/v1/a2a/install', {
      id,
      name: /** @type {any} */ (previewedCard).name,
      url: previewedUrl,
      outbound_api_key: outboundKey,
    }))
    if (!r || !r.ok) {
      showToast(String(r?.error ?? 'install failed'))
      return
    }
    const info = /** @type {Record<string, any>} */ (await invokeApi('GET', '/v1/a2a/info').catch(() => null))
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
    showToast(`没连上：${err instanceof Error ? err.message : String(err)}`)
  } finally {
    if (confirmBtn instanceof HTMLButtonElement) { confirmBtn.disabled = false; confirmBtn.textContent = '连上' }
  }
}

/** @param {string} id */
async function openActivityDrawer(id) {
  const drawer = /** @type {HTMLElement | null} */ (document.getElementById('a2a-activity-drawer'))
  const titleEl = document.getElementById('a2a-activity-title')
  if (!drawer || !titleEl) return
  titleEl.textContent = `${id} · 最近往来`
  const ul = document.getElementById('a2a-activity-list')
  if (ul) ul.innerHTML = '<li class="empty">加载中…</li>'
  drawer.hidden = false

  const r = /** @type {{ events?: Array<any> }} */ (
    await invokeApi('GET', `/v1/a2a/activity?agent_id=${encodeURIComponent(id)}&limit=50`)
  )
  if (!ul) return
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

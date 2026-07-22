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

// ── module-level state ────────────────────────────────────────────────────
/** @type {Record<string, unknown> | null} */
let previewedCard = null
let previewedUrl = ''

// ── public API ────────────────────────────────────────────────────────────

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

  // 觅食台 — reveal (delegated), inbound toggle, sow hint.
  document.getElementById('fd-postcards')?.addEventListener('click', onPostcardAction)
  document.getElementById('fd-inbound-toggle')?.addEventListener('click', onInboundToggle)
  document.getElementById('fd-inbound-toggle')?.addEventListener('keydown', (e) => {
    if (e instanceof KeyboardEvent && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onInboundToggle() }
  })
  // #fd-sow / #a2a-add-btn are re-rendered by renderForageDesk, so the sow
  // action is delegated from the hero container instead of bound to the node.
  document.getElementById('fd-hero-status')?.addEventListener('click', (e) => {
    if (e.target instanceof HTMLElement && e.target.closest('#fd-sow')) {
      const compose = document.getElementById('fd-compose')
      if (compose) compose.hidden = false
      const topic = /** @type {HTMLInputElement | null} */ (document.getElementById('fd-compose-topic'))
      if (topic && typeof topic.focus === 'function') topic.focus()
    }
  })
  document.getElementById('fd-compose-form')?.addEventListener('submit', onComposeSubmit)
  document.getElementById('fd-compose')?.addEventListener('click', onSeekAction)
  document.getElementById('fd-wishes')?.addEventListener('click', onSeekAction)
}

export async function refresh() {
  const wishes = document.getElementById('fd-wishes')
  if (wishes && !wishes.innerHTML) wishes.innerHTML = '<div class="fd-empty">加载中…</div>'

  const [listResp, seeksResp, echoesResp, inbound] = await Promise.all([
    /** @type {Promise<{agents?:Array<any>}|null>} */ (invokeApi('GET', '/v1/a2a/list').catch(() => null)),
    /** @type {Promise<{seeks?:Array<any>}|null>}  */ (invokeApi('GET', '/v1/social/seeks').catch(() => null)),
    /** @type {Promise<{echoes?:Array<any>}|null>} */ (invokeApi('GET', '/v1/social/echoes').catch(() => null)),
    /** @type {Promise<any>}                        */ (invokeApi('GET', '/v1/social/inbound').catch(() => null)),
  ])

  // keep the server-status banner (best-effort, as before)
  const banner = document.getElementById('a2a-server-banner')
  if (banner) {
    const info = /** @type {Record<string, any>} */ (await invokeApi('GET', '/v1/a2a/info').catch(() => null))
    renderServerBanner(info, banner)
  }

  renderForageDesk({
    agents: listResp ? (listResp.agents ?? []) : null,
    seeks:  seeksResp ? (seeksResp.seeks ?? []) : null,
    echoes: echoesResp ? (echoesResp.echoes ?? []) : null,
    inbound,
  })
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
    banner.innerHTML = '<span class="dot off"></span> A2A 状态未知（daemon 未启动？）'
  } else if (!info.enabled) {
    banner.innerHTML = '<span class="dot off"></span> A2A 入站服务器已禁用 — 编辑 <code>agent-config.json</code> 加 <code>"a2a_listen": { "port": 8717 }</code> 后重启 daemon'
  } else {
    const url = String(info.base_url ?? '')
    banner.innerHTML = `<span class="dot on"></span> A2A 服务器运行中，外部 agent 调用此地址：<code class="a2a-base-url">${escapeHtml(url)}/a2a/notify</code>`
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
    list.innerHTML = '<li class="empty">No agents registered. Click "+ Add Agent" to install one.</li>'
    return
  }
  for (const a of agents) {
    const li = document.createElement('li')
    li.className = 'a2a-agent-card' + (a.paused ? ' paused' : '')
    li.dataset.id = a.id
    li.innerHTML = `
      <header class="a2a-card-head">
        <span class="dot ${a.paused ? 'off' : 'on'}"></span>
        <strong>${escapeHtml(a.id)}</strong> · ${escapeHtml(a.name)}
      </header>
      <div class="a2a-card-url">${escapeHtml(a.url)}</div>
      <div class="a2a-card-counts">↓ ${a.counts?.inbound ?? 0} · ↑ ${a.counts?.outbound ?? 0}</div>
      <div class="a2a-card-actions">
        <button class="btn ghost" data-action="pause" data-id="${escapeHtml(a.id)}">${a.paused ? 'Resume' : 'Pause'}</button>
        <button class="btn ghost" data-action="test" data-id="${escapeHtml(a.id)}">Test</button>
        <button class="btn ghost" data-action="activity" data-id="${escapeHtml(a.id)}">Activity</button>
        <button class="btn danger" data-action="remove" data-id="${escapeHtml(a.id)}">Remove</button>
      </div>
    `
    list.appendChild(li)
  }
}

/**
 * Render the whole 觅食台 from live data.
 * @param {{ agents:Array<any>|null, seeks:Array<any>|null, echoes:Array<any>|null, inbound:any }} data
 */
export function renderForageDesk(data) {
  const agents = Array.isArray(data.agents) ? data.agents : []
  const seeks  = Array.isArray(data.seeks) ? data.seeks : []
  const echoes = Array.isArray(data.echoes) ? data.echoes : []
  const socialWired = data.seeks != null || data.echoes != null
  const seekById = new Map(seeks.map(s => [s.id, s]))

  // ── hero status ──────────────────────────────────────────────────────
  const status = document.getElementById('fd-hero-status')
  if (status) {
    const n = agents.length
    const asked = seeks.reduce((sum, s) => sum + (Number(s.peers_asked) || 0), 0)
    const echoCount = echoes.length
    const askFrag = socialWired
      ? `<span>替你问过 <b class="fd-num">${asked}</b> 个</span><i class="fd-dot-sep"></i>` +
        `<span><b style="color:var(--fd-clay-deep)">${echoCount}</b> 条带回音了</span>`
      : `<span>社交觅食未启用</span>`
    status.innerHTML =
      `<svg class="fd-frog" viewBox="0 0 30 30" fill="none" aria-hidden="true">` +
      `<ellipse cx="15" cy="19" rx="10" ry="8" fill="#8AA36F"/>` +
      `<circle cx="10" cy="10" r="4.2" fill="#8AA36F"/><circle cx="20" cy="10" r="4.2" fill="#8AA36F"/>` +
      `<circle cx="10" cy="10" r="2" fill="#fff"/><circle cx="20" cy="10" r="2" fill="#fff"/>` +
      `<circle cx="10.6" cy="10.4" r="1" fill="#3B3125"/><circle cx="20.6" cy="10.4" r="1" fill="#3B3125"/>` +
      `<path d="M11 20 q4 3 8 0" stroke="#3B3125" stroke-width="1.3" stroke-linecap="round"/></svg>` +
      `<span class="fd-status-line"><span>连着 <b>${n} 位</b>朋友的 bot</span><i class="fd-dot-sep"></i>${askFrag}</span>` +
      `<button class="fd-btn fd-btn-primary fd-sow" id="fd-sow" type="button">＋ 撒一个新心愿</button>`
  }
  const note = document.getElementById('fd-social-note')
  if (note) {
    if (socialWired) { note.hidden = true; note.textContent = '' }
    else { note.hidden = false; note.textContent = '社交觅食功能未启用 —— 在 §③ 打开「让朋友的 bot 能找到我」并重启守护进程即可。' }
  }

  // ── ① wishes ─────────────────────────────────────────────────────────
  const wishes = document.getElementById('fd-wishes')
  const wishCount = document.getElementById('fd-wishes-count')
  if (wishes) {
    if (seeks.length === 0) {
      wishes.innerHTML = `<div class="fd-empty">还没有派出去的心愿。在微信里跟 CC 说「帮我悄悄找…」，它就会替你撒出去。</div>`
    } else {
      wishes.innerHTML = seeks.map(s => renderWish(s)).join('')
    }
  }
  if (wishCount) {
    const active = seeks.filter(s => s.status === 'foraging').length
    wishCount.textContent = seeks.length ? `${active} 条在外面` : ''
  }

  // ── ② postcards ──────────────────────────────────────────────────────
  const postcards = document.getElementById('fd-postcards')
  const pcCount = document.getElementById('fd-postcards-count')
  if (postcards) {
    if (echoes.length === 0) {
      postcards.innerHTML = `<div class="fd-empty">还没有带回明信片。你的 bot 一有回音，就会出现在这里。</div>`
    } else {
      postcards.innerHTML = echoes.map(e => renderPostcard(e, seekById.get(e.seek_id))).join('')
    }
  }
  if (pcCount) {
    const pending = echoes.filter(e => e.status === 'pending').length
    pcCount.textContent = pending ? `${pending} 张待你揭晓` : (echoes.length ? '已处理' : '')
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
/** @param {number} n → "朋友 → 的朋友 → …" */
function fdDegreePath(n) {
  const parts = ['朋友']
  for (let i = 1; i < n; i++) parts.push('的朋友')
  return parts.join(' → ')
}
/** @param {number} n */
function fdDegBar(n) {
  // 1-hop today: deg 1 lit, 2/3 dashed "next" (待开).
  return [1, 2, 3].map(d =>
    `<i class="fd-deg ${d <= n ? 'fd-lit' : 'fd-next'}"></i>`).join('')
}

/** @param {any} s */
function renderWish(s) {
  if (s.status === 'proposed') return renderProposedWish(s)
  if (s.status === 'cancelled') return renderCancelledWish(s)
  const kindCls = s.kind === 'fun' ? 'fd-fun' : 'fd-seek'
  const kindTxt = s.kind === 'fun' ? '朋友间小乐趣' : '求物求人'
  const echoed = s.status === 'echoed' || s.status === 'connected'
  const right = echoed
    ? `<span class="fd-echo-badge">🎉 有回音！</span><div class="fd-deg-cap">↓ 见下方明信片</div>`
    : `<div class="fd-forage"><span class="fd-pulse"></span>觅食中</div>` +
      `<div class="fd-degree"><span class="fd-deg-track">${fdDegBar(Number(s.hop) || 1)}</span></div>` +
      `<div class="fd-deg-cap">第 ${Number(s.hop) || 1} 度 · 问了 ${Number(s.peers_asked) || 0} 个</div>`
  return `<div class="fd-wish">` +
    `<span class="fd-kind ${kindCls}">${kindTxt}</span>` +
    `<div class="fd-title">${escapeHtml(s.topic || '')}</div>` +
    `<div class="fd-meta"><span class="fd-lock">🔒 匿名传播</span><i class="fd-dot-sep"></i><span>撒出去 ${escapeHtml(fdRelTime(s.created_at))}</span></div>` +
    `<div class="fd-rightcol">${right}</div>` +
    `</div>`
}

/**
 * 待确认提案 —— 隐私锁:只渲染 redacted*,原始 topic 绝不进 DOM(所见即所发,
 * 展示的就是确认后会广播的字节)。redacted_topic 为 null 只可能是 P4 之前的
 * 老数据:给兜底文案,引导取消后重新发起。
 * @param {any} s
 */
function renderProposedWish(s) {
  const shown = s.redacted_topic
    ? `「${escapeHtml(s.redacted_topic)}」`
    : '（缺少预览文本 —— 取消后重新发起）'
  const cityFrag = s.redacted_city ? `<span>📍 ${escapeHtml(s.redacted_city)}</span><i class="fd-dot-sep"></i>` : ''
  return `<div class="fd-wish fd-proposed">` +
    `<span class="fd-kind fd-seek">待确认</span>` +
    `<div class="fd-title">${shown}</div>` +
    `<div class="fd-meta"><span class="fd-lock">🕶️ 外面只会看到上面这句</span><i class="fd-dot-sep"></i>${cityFrag}<span>提案于 ${escapeHtml(fdRelTime(s.created_at))}</span></div>` +
    `<div class="fd-rightcol"><div class="fd-pc-actions">` +
    `<button class="fd-btn fd-btn-primary" data-action="seek-confirm" data-id="${escapeHtml(s.id)}">确认派出</button>` +
    `<button class="fd-btn fd-btn-wait" data-action="seek-cancel" data-id="${escapeHtml(s.id)}">取消</button>` +
    `</div></div></div>`
}

/** @param {any} s — 已取消:灰显、无操作(cancelled 从未广播,本地展示原文无隐私问题)。 */
function renderCancelledWish(s) {
  return `<div class="fd-wish fd-cancelled">` +
    `<span class="fd-kind">已取消</span>` +
    `<div class="fd-title">「${escapeHtml(s.redacted_topic || s.topic || '')}」</div>` +
    `<div class="fd-meta"><span>取消于 ${escapeHtml(fdRelTime(s.updated_at || s.created_at))}</span></div>` +
    `</div>`
}

/** @param {any} e  @param {any} seek */
function renderPostcard(e, seek) {
  const deg = Number(e.degree) || 1
  const topic = seek ? seek.topic : ''
  const bodyTopic = topic ? `回应了你的「<b>${escapeHtml(topic)}</b>」——` : ''
  if (e.status === 'revealed') {
    return `<div class="fd-postcard fd-connected">` +
      `<div class="fd-stamp">从第 ${deg} 度<br>带回</div>` +
      `<div class="fd-pc-eyebrow">🎉 已牵线</div>` +
      `<div class="fd-masked fd-revealed"><div class="fd-mask-av">✓</div><div class="fd-who">${escapeHtml(e.peer_masked || '')}<small>身份已互相亮出</small></div></div>` +
      `<p class="fd-pc-body">${bodyTopic}「${escapeHtml(e.content || '')}」</p>` +
      `<div class="fd-outcome">已牵线 · 可以直接联系了</div>` +
      `</div>`
  }
  if (e.status === 'declined') {
    return `<div class="fd-postcard">` +
      `<div class="fd-stamp">从第 ${deg} 度<br>带回</div>` +
      `<div class="fd-masked"><div class="fd-mask-av">?</div><div class="fd-who">${escapeHtml(e.peer_masked || `${deg}度外的某人`)}<small>${escapeHtml(fdDegreePath(deg))}</small></div></div>` +
      `<p class="fd-pc-body">${bodyTopic}「${escapeHtml(e.content || '')}」</p>` +
      `<div class="fd-outcome fd-retry">这条已谢绝</div>` +
      `</div>`
  }
  // pending
  return `<div class="fd-postcard" data-echo-id="${escapeHtml(e.id)}">` +
    `<div class="fd-stamp">从第 ${deg} 度<br>带回</div>` +
    `<div class="fd-pc-eyebrow">🐸 你的 bot 带回一张明信片</div>` +
    `<div class="fd-masked"><div class="fd-mask-av">?</div><div class="fd-who">${escapeHtml(e.peer_masked || `${deg}度外的某人`)}<small>${escapeHtml(fdDegreePath(deg))}</small></div></div>` +
    `<p class="fd-pc-body">${bodyTopic}「${escapeHtml(e.content || '')}」</p>` +
    `<div class="fd-pc-actions"><button class="fd-btn fd-btn-reveal" data-action="reveal" data-id="${escapeHtml(e.id)}">揭晓牵线</button><button class="fd-btn fd-btn-wait" data-action="wait">再等等</button></div>` +
    `<div class="fd-reveal-note">🔒 你点了之后，对方也点「同意」，才互相亮身份和联系方式</div>` +
    `</div>`
}

/**
 * Last visible glyph of a name (handles surrogate pairs) — for common CN
 * nicknames like 老王/小李 (老/小 + surname prefix pattern) this surfaces
 * the surname rather than the generic 老/小 prefix.
 * @param {string} s
 */
function lastGlyph(s) { const g = Array.from(String(s || '?')); return g[g.length - 1] || '?' }

// ── event handlers ────────────────────────────────────────────────────────

/** @param {MouseEvent} e */
async function onCardAction(e) {
  const target = e.target
  if (!(target instanceof HTMLButtonElement)) return
  const action = target.dataset.action
  const id = target.dataset.id
  if (!action || !id) return

  if (action === 'pause') {
    const card = target.closest('.a2a-agent-card')
    const wasPaused = card?.classList.contains('paused')
    try {
      await invokeApi('POST', '/v1/a2a/pause', { id, paused: !wasPaused })
      await refresh()
    } catch (err) {
      alert(`Failed to ${wasPaused ? 'resume' : 'pause'} agent: ${err instanceof Error ? err.message : String(err)}`)
    }
  } else if (action === 'remove') {
    if (!confirm(`Remove agent '${id}'?`)) return
    try {
      await invokeApi('POST', '/v1/a2a/remove', { id })
      await refresh()
    } catch (err) {
      alert(`Failed to remove agent: ${err instanceof Error ? err.message : String(err)}`)
    }
  } else if (action === 'activity') {
    await openActivityDrawer(id).catch(err =>
      alert(`Failed to load activity: ${err instanceof Error ? err.message : String(err)}`)
    )
  } else if (action === 'test') {
    await openTestModal(id).catch(err =>
      alert(`Failed to open test dialog: ${err instanceof Error ? err.message : String(err)}`)
    )
  }
}

// 觅食台 — postcard reveal + inbound toggle. Guards are duck-typed
// (`target?.dataset`) rather than `instanceof HTMLButtonElement` so these
// handlers stay directly testable against the bare-object DOM stub used in
// a2a-agents.test.ts (no jsdom, no HTMLButtonElement in that environment).

/** @param {MouseEvent} e */
async function onPostcardAction(e) {
  const target = /** @type {any} */ (e.target)
  if (!target || !target.dataset) return
  const action = target.dataset.action
  const card = typeof target.closest === 'function' ? target.closest('.fd-postcard') : null
  if (action === 'wait') {
    // "再等等" — passive; collapse the actions with a soft note.
    if (card) {
      const actions = card.querySelector('.fd-pc-actions')
      if (actions) actions.remove()
      const note = card.querySelector('.fd-reveal-note')
      if (note) note.textContent = '好，先放着 —— 有进展你的 bot 会再提醒你。'
    }
    return
  }
  if (action !== 'reveal') return
  const id = target.dataset.id
  if (!id || !card) return
  target.disabled = true
  target.textContent = '揭晓中…'
  try {
    const r = /** @type {{outcome?:{state?:string}, error?:string}} */ (
      await invokeApi('POST', '/v1/social/echoes/reveal', { id }))
    const state = r?.outcome?.state
    const actions = card.querySelector('.fd-pc-actions')
    const note = card.querySelector('.fd-reveal-note')
    if (state === 'connected') {
      if (actions) actions.remove()
      card.classList.add('fd-connected')
      if (note) { note.className = 'fd-outcome'; note.textContent = '🎉 已牵线 · 对方也同意了，可以直接联系了' }
    } else if (state === 'awaiting_peer') {
      if (actions) actions.remove()
      if (note) { note.className = 'fd-outcome fd-wait'; note.textContent = '已揭晓，等对方回揭 —— 对方同意后就会互相亮身份' }
    } else if (state === 'peer_unreachable') {
      target.disabled = false
      target.textContent = '再试一次揭晓'
      if (note) { note.className = 'fd-outcome fd-retry'; note.textContent = '暂时联系不上对方的 bot，等下再试' }
    } else {
      target.disabled = false
      target.textContent = '揭晓牵线'
      if (note) { note.className = 'fd-reveal-note'; note.textContent = `揭晓失败：${escapeHtml(String(r?.error ?? '未知错误'))}` }
    }
  } catch (err) {
    target.disabled = false
    target.textContent = '揭晓牵线'
    const note = card.querySelector('.fd-reveal-note')
    if (note) { note.className = 'fd-reveal-note'; note.textContent = `揭晓失败：${escapeHtml(err instanceof Error ? err.message : String(err))}` }
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

// 觅愿撰写 — propose→脱敏预览→confirm/cancel。守卫同样鸭子类型(测试
// 环境是 bare-object stub)。invokeApi 对 503 会 throw Error('social_not_wired')。

/** @param {unknown} err */
function composeErrText(err) {
  const msg = err instanceof Error ? err.message : String(err)
  if (msg === 'social_not_wired') return '社交觅食未启用 —— 先在命令行运行 wechat-cc social enable 并重启守护进程。'
  return `派心愿失败：${msg}`
}

/** @param {SubmitEvent} e */
async function onComposeSubmit(e) {
  e.preventDefault()
  const topicInput = /** @type {HTMLInputElement | null} */ (document.getElementById('fd-compose-topic'))
  const cityInput = /** @type {HTMLInputElement | null} */ (document.getElementById('fd-compose-city'))
  const note = document.getElementById('fd-compose-note')
  const btn = /** @type {HTMLButtonElement | null} */ (document.getElementById('fd-compose-submit'))
  const topic = String(topicInput?.value ?? '').trim()
  const city = String(cityInput?.value ?? '').trim()
  if (!topic) {
    if (note) { note.hidden = false; note.textContent = '先写下你想找什么' }
    return
  }
  if (btn) btn.disabled = true
  try {
    const r = /** @type {{ok?:boolean, intent_id?:string, redacted?:string, redacted_city?:string, reason?:string}} */ (
      await invokeApi('POST', '/v1/social/seek/propose', city ? { topic, city } : { topic }))
    if (r?.ok) {
      renderProposePreview(r)
      if (note) { note.hidden = true; note.textContent = '' }
    } else {
      if (note) { note.hidden = false; note.textContent = `没能生成预览：${String(r?.reason ?? '未知错误')}` }
    }
  } catch (err) {
    if (note) { note.hidden = false; note.textContent = composeErrText(err) }
  } finally {
    if (btn) btn.disabled = false
  }
}

/**
 * 脱敏预览卡 —— 隐私锁:只渲染 redacted / redacted_city,原始 topic 绝不进 DOM。
 * @param {{intent_id?:string, redacted?:string, redacted_city?:string}} r
 */
function renderProposePreview(r) {
  const preview = document.getElementById('fd-preview')
  if (!preview) return
  const cityLine = r.redacted_city ? `<div class="fd-preview-city">📍 ${escapeHtml(r.redacted_city)}</div>` : ''
  preview.hidden = false
  preview.innerHTML = `<div class="fd-preview-card" data-intent-id="${escapeHtml(String(r.intent_id ?? ''))}">` +
    `<div class="fd-preview-eyebrow">🕶️ 外面只会看到这个</div>` +
    `<div class="fd-preview-topic">「${escapeHtml(String(r.redacted ?? ''))}」</div>` + cityLine +
    `<div class="fd-preview-actions">` +
    `<button class="fd-btn fd-btn-primary" data-action="seek-confirm" data-id="${escapeHtml(String(r.intent_id ?? ''))}">确认派出</button>` +
    `<button class="fd-btn fd-btn-wait" data-action="seek-cancel" data-id="${escapeHtml(String(r.intent_id ?? ''))}">算了，取消</button>` +
    `</div>` +
    `<div class="fd-preview-note">确认后，你的 bot 才会真的把它撒出去。</div>` +
    `</div>`
}

/** @param {boolean} confirmed */
function clearComposePreview(confirmed) {
  const preview = document.getElementById('fd-preview')
  if (preview) { preview.hidden = true; preview.innerHTML = '' }
  const note = document.getElementById('fd-compose-note')
  if (confirmed) {
    const compose = document.getElementById('fd-compose')
    const topicInput = /** @type {HTMLInputElement | null} */ (document.getElementById('fd-compose-topic'))
    const cityInput = /** @type {HTMLInputElement | null} */ (document.getElementById('fd-compose-city'))
    if (topicInput) topicInput.value = ''
    if (cityInput) cityInput.value = ''
    if (compose) compose.hidden = true
    if (note) { note.hidden = true; note.textContent = '' }
  } else {
    if (note) { note.hidden = false; note.textContent = '已取消 —— 想改改措辞再派也行。' }
  }
}

/**
 * Delegated:预览卡与(Task 2 起)心愿列表里 proposed 行的 确认/取消。
 * @param {MouseEvent} e
 */
async function onSeekAction(e) {
  const target = /** @type {any} */ (e.target)
  if (!target || !target.dataset) return
  const action = target.dataset.action
  const id = target.dataset.id
  if ((action !== 'seek-confirm' && action !== 'seek-cancel') || !id) return
  const note = document.getElementById('fd-compose-note')
  target.disabled = true
  try {
    const path = action === 'seek-confirm' ? '/v1/social/seek/confirm' : '/v1/social/seek/cancel'
    const r = /** @type {{ok?:boolean, reason?:string}} */ (await invokeApi('POST', path, { id }))
    if (r?.ok) {
      clearComposePreview(action === 'seek-confirm')
      await refresh().catch(() => {})
    } else {
      target.disabled = false
      if (note) { note.hidden = false; note.textContent = `${action === 'seek-confirm' ? '确认' : '取消'}失败：${String(r?.reason ?? '未知错误')}` }
    }
  } catch (err) {
    target.disabled = false
    if (note) { note.hidden = false; note.textContent = composeErrText(err) }
  }
}

// Test seams — onPostcardAction/onInboundToggle are module-private (wired
// via addEventListener in initA2AAgentsTab), so unit tests reach them
// through these thin re-exports rather than simulating real DOM events.
export const __onPostcardActionForTest = onPostcardAction
export const __onInboundToggleForTest = onInboundToggle
export const __onComposeSubmitForTest = onComposeSubmit
export const __onSeekActionForTest = onSeekAction

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
  if (title) title.textContent = `Test '${id}'`
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
  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Fetching…' }
  try {
    const resp = /** @type {Record<string, any>} */ (await invokeApi('POST', '/v1/a2a/preview', { url }))
    if (resp && 'error' in resp) { alert(String(resp.error)); return }
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
    alert(`Failed to fetch agent card: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Fetch Agent Card →' }
  }
}

async function onInstallConfirm() {
  const preview = /** @type {HTMLElement | null} */ (document.getElementById('a2a-add-preview'))
  if (!preview || !previewedCard) return
  const idInput = /** @type {HTMLInputElement | null} */ (preview.querySelector('input[name="id"]'))
  const keyInput = /** @type {HTMLInputElement | null} */ (preview.querySelector('input[name="outbound_key"]'))
  const id = idInput?.value?.trim() ?? ''
  const outboundKey = keyInput?.value?.trim() ?? ''
  if (!id) { alert('Please enter a local id (slug) for this agent.'); return }

  const confirmBtn = document.getElementById('a2a-install-confirm')
  if (confirmBtn instanceof HTMLButtonElement) { confirmBtn.disabled = true; confirmBtn.textContent = 'Installing…' }
  try {
    const r = /** @type {Record<string, any>} */ (await invokeApi('POST', '/v1/a2a/install', {
      id,
      name: /** @type {any} */ (previewedCard).name,
      url: previewedUrl,
      outbound_api_key: outboundKey,
    }))
    if (!r || !r.ok) {
      alert(String(r?.error ?? 'install failed'))
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
    alert(`Install failed: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    if (confirmBtn instanceof HTMLButtonElement) { confirmBtn.disabled = false; confirmBtn.textContent = 'Install' }
  }
}

/** @param {string} id */
async function openActivityDrawer(id) {
  const drawer = /** @type {HTMLElement | null} */ (document.getElementById('a2a-activity-drawer'))
  const titleEl = document.getElementById('a2a-activity-title')
  if (!drawer || !titleEl) return
  titleEl.textContent = `${id} — recent activity`
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

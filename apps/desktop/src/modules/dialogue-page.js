// @ts-check
/// <reference lib="dom" />
//
// dialogue-page.js — the "对话" pane, driven by real data.
//
// Replaces the original static designer mockup. Keeps the mockup's visual
// language (the dialogue-* CSS classes, sidebar + stage layout, document-
// style conversation) but every list, message, thread, and search result
// comes from the daemon via CLI JSON commands:
//
//   sessions list-chats        → chat switcher
//   dialogue timeline          → document-style message flow (upward paging)
//   dialogue threads           → facet lenses (任务 / 知识 / 生活)
//   dialogue thread-detail     → per-episode message rendering
//   dialogue search            → in-stage hit list
//   dialogue unlock            → private-thread passphrase gate
//
// Plain JSDoc-typed JS, no framework — same style as sessions.js. The pane
// keeps a little module-scoped state (selected chat, current view, whether
// the user has unlocked private threads this session).

import { escapeHtml } from "../view.js"
import { formatRelativeTimeShort } from "./observations.js"
import { icon } from "./icons.js"
// Shared, Tauri-safe helpers — single source of truth lives in sessions.js.
// attachmentUrl routes through convertFileSrc in packaged Tauri (no
// /attachment HTTP handler exists there); avatarInitial / avatarInfo were
// duplicated here before this refactor.
import { attachmentUrl, avatarInitial, avatarInfo } from "./sessions.js"

/**
 * @typedef {{ invoke: (cmd: string, args: Record<string, unknown>) => Promise<unknown> }} Deps
 * @typedef {{ id: string, chatId: string, ts: string, direction: 'in'|'out', kind: string, text: string, provider?: string, source: string }} Message
 * @typedef {{ id: string, chatId: string, title: string, summary: string, facets: string[], tags: string[], private: boolean, status: 'active'|'dormant'|'done', episodes: Array<{from_ts:string,to_ts:string}>, createdTs: string, lastActive: string }} Thread
 * @typedef {{ from_ts: string, to_ts: string, messages: Message[] }} Episode
 * @typedef {'timeline'|'task'|'knowledge'|'life'} ViewId
 */

const TIMELINE_PAGE = 100

// ── module state ───────────────────────────────────────────────────────
/** @type {string|null} */
let selectedChatId = null
/** @type {ViewId} */
let currentView = "timeline"
// Session-scoped: once the user enters the right passphrase we keep private
// threads visible until the pane is re-initialised / app reloads. Never
// persisted — the lock is re-armed every launch.
let unlocked = false
// true once `dialogue unlock` reports no_lock_configured — there's nothing
// to unlock, so the lock affordance is hidden entirely.
let noLockConfigured = false
/** Chat display name keyed by chat_id (from list-chats), for the human author label. @type {Record<string,string>} */
let chatNames = {}
/** Oldest loaded timeline ts — the cursor for upward paging. @type {string|null} */
let oldestLoadedTs = null
/** Whether older timeline pages exist. */
let timelineHasMore = false
/** Guards concurrent upward-page fetches. */
let pagingInFlight = false
/** Whether the rendered timeline page reaches the actual newest message. */
let timelineShowsNewest = true
/** Whether #dialogue-timeline currently contains the search result list. */
let timelineShowingSearchResults = false
/** Monotonically-increasing load counter — each async loader snapshots this
 *  at entry and bails before any DOM write when a newer load has started. */
let loadSeq = 0

const VIEWS = /** @type {Array<{id: ViewId, label: string}>} */ ([
  { id: "timeline", label: "时间线" },
  { id: "task", label: "任务" },
  { id: "knowledge", label: "知识" },
  { id: "life", label: "生活" },
])

const STATUS_LABEL = { active: "进行中", dormant: "搁置", done: "完结" }

// ── small helpers ──────────────────────────────────────────────────────

/** @param {Deps} deps @param {string[]} args */
async function cli(deps, args) {
  return deps.invoke("wechat_cli_json", { args })
}

/**
 * Human-facing name for the inbound (direction 'in') author of a chat.
 * Falls back to '我' when the chat has no resolved display name.
 * @param {string|null} chatId
 */
function humanName(chatId) {
  if (chatId && chatNames[chatId]) return chatNames[chatId]
  return "我"
}

/**
 * Render an avatar span — custom image when available, else a coloured
 * initial bubble. Reuses the mockup's dialogue-avatar / dialogue-avatar-*
 * classes so the existing CSS keeps working.
 *
 * @param {{ kind: 'user'|'ai', name: string, src?: string|null, avatarKey?: string|null }} arg0
 */
function avatarHtml({ kind, name, src, avatarKey }) {
  const cls = `dialogue-avatar dialogue-avatar-${kind} wechat-avatar`
  if (src) {
    return `<span class="${cls}"><img src="${escapeHtml(src)}" alt="${escapeHtml(name)}" /></span>`
  }
  return `<span class="${cls}">${escapeHtml(avatarInitial(name))}</span>`
}

// ── skeleton ───────────────────────────────────────────────────────────

/** @param {HTMLElement} root */
function renderSkeleton(root) {
  root.innerHTML = `
    <aside class="dialogue-sidebar">
      <div id="dialogue-chat-switcher" class="dialogue-chat-switcher"></div>
      <div class="dialogue-search">
        <span class="dialogue-search-icon">${icon("search-01", { size: 16 })}</span>
        <input id="dialogue-search" type="search" placeholder="搜索对话…" autocomplete="off" />
      </div>
      <nav id="dialogue-views" class="dialogue-views">
        ${VIEWS.map(v => `<button class="dialogue-view-btn${v.id === "timeline" ? " is-active" : ""}" data-view="${v.id}">${v.label}</button>`).join("")}
      </nav>
      <div id="dialogue-groups" class="dialogue-groups" hidden></div>
    </aside>
    <section class="dialogue-stage">
      <div class="dialogue-document">
        <div class="dialogue-document-head">
          <button class="dialogue-action-pill" id="dialogue-export" type="button">
            ${icon("download-01", { size: 16 })}<span>导出 Markdown</span>
          </button>
          <button class="dialogue-action-pill" id="dialogue-refresh" type="button" aria-label="刷新" title="刷新">
            ${icon("refresh", { size: 16 })}<span>刷新</span>
          </button>
        </div>
        <div id="dialogue-timeline" class="dialogue-scroll"></div>
        <div id="dialogue-thread-detail" class="dialogue-scroll" hidden></div>
        <button class="dialogue-latest-button" id="dialogue-latest" type="button" hidden aria-label="回到最新消息">
          ${icon("arrow-down-02", { size: 16 })}<span>回到最新</span>
        </button>
      </div>
    </section>
    <div class="privacy-dialog" id="privacy-dialog" hidden>
      <form class="privacy-card">
        <button class="privacy-close" type="button" aria-label="关闭">${icon("cancel-01", { size: 18 })}</button>
        <span class="privacy-lock-mark">${icon("square-lock-01", { size: 20 })}</span>
        <h2>解锁私密内容</h2>
        <p>部分话题包含较私人的内容，输入密码后才能查看。</p>
        <label for="privacy-password">密码</label>
        <input id="privacy-password" type="password" autocomplete="current-password" placeholder="请输入密码" />
        <span class="privacy-error" hidden>密码不正确，请重新输入</span>
        <button class="privacy-submit" type="submit">解锁私密话题</button>
      </form>
    </div>
  `
}

// ── chat switcher ──────────────────────────────────────────────────────

/**
 * Load the chat list (list-chats) into the sidebar switcher and resolve the
 * selected chat (preserved selection, else most-recent). Mirrors sessions.js
 * loadSessionsChats consumption of list-chats.
 * @param {Deps} deps
 * @returns {Promise<boolean>} true when at least one chat exists
 */
async function loadChats(deps) {
  const switcher = document.getElementById("dialogue-chat-switcher")
  /** @type {Array<{chat_id:string,user_name:string|null,session_count:number,last_used_at?:string}>} */
  let chats = []
  try {
    const resp = /** @type {any} */ (await cli(deps, ["sessions", "list-chats", "--json"]))
    chats = (resp && resp.chats) || []
  } catch (err) {
    console.error("dialogue list-chats failed", err)
  }

  chatNames = {}
  for (const c of chats) {
    const name = c.user_name || (c.chat_id === "_legacy" ? "（早期会话）" : (c.chat_id.split("@")[0] ?? c.chat_id))
    chatNames[c.chat_id] = name
  }

  // list-chats is already sorted most-recent-first. Preserve the user's
  // current selection across refreshes; else fall back to the first chat.
  selectedChatId = (selectedChatId && chats.some(c => c.chat_id === selectedChatId))
    ? selectedChatId
    : (chats[0]?.chat_id ?? null)

  if (switcher) {
    // The sidebar design no longer shows the chat switcher rows.
    switcher.hidden = true
    switcher.innerHTML = ""
  }
  return chats.length > 0
}

// ── timeline ───────────────────────────────────────────────────────────

/**
 * Render a single message as a document-style turn block (reuses the
 * mockup's dialogue-turn markup). command-kind messages render as a muted
 * single-line dialogue-cmd row.
 * @param {Message} m
 * @param {{ userName: string, userAvatar?: string|null, botAvatar?: string|null, userAvatarKey?: string|null, botAvatarKey?: string|null }} ctx
 */
function messageHtml(m, ctx) {
  if (m.kind === "command") {
    return `<div class="dialogue-cmd" data-msg-id="${escapeHtml(m.id)}">${escapeHtml(m.text)}</div>`
  }
  const isUser = m.direction === "in"
  const name = isUser ? ctx.userName : (botLabel(m))
  const avatar = avatarHtml({
    kind: isUser ? "user" : "ai",
    name,
    src: isUser ? ctx.userAvatar : ctx.botAvatar,
    avatarKey: isUser ? ctx.userAvatarKey : ctx.botAvatarKey,
  })
  const author = isUser
    ? `<div class="dialogue-author">${escapeHtml(name)}</div>`
    : `<div class="dialogue-author">${escapeHtml(name)}</div>`
  const body = m.text
    .split("\n")
    .filter(line => line.length > 0)
    .map(line => `<p>${escapeHtml(line)}</p>`)
    .join("") || "<p></p>"
  return `<div class="dialogue-turn" data-msg-id="${escapeHtml(m.id)}">
    ${avatar}
    <div class="dialogue-turn-body">${author}${body}</div>
  </div>`
}

/** Bot display label — provider-aware. @param {Message} m */
function botLabel(m) {
  return "wechat-cc"
}

/** @type {Message[]} loaded timeline messages (ascending), kept for export. */
let loadedMessages = []

/**
 * Load the newest timeline page for the selected chat and render it. Scrolls
 * to bottom (newest at bottom).
 * @param {Deps} deps
 * @param {{ beforeTs?: string, highlightId?: string }} [opts]
 */
async function loadTimeline(deps, opts = {}) {
  const seq = ++loadSeq
  const stage = document.getElementById("dialogue-timeline")
  if (!stage) return
  timelineShowsNewest = !opts.beforeTs
  timelineShowingSearchResults = false
  showTimelineView()
  if (!selectedChatId) {
    if (seq !== loadSeq) return
    stage.innerHTML = `<p class="empty-state">还没有对话。</p>`
    return
  }
  if (seq !== loadSeq) return
  stage.innerHTML = `<p class="empty-state">加载中…</p>`

  const args = ["dialogue", "timeline", "--chat-id", selectedChatId, "--limit", String(TIMELINE_PAGE), "--json"]
  if (opts.beforeTs) args.push("--before", opts.beforeTs)

  let messages = /** @type {Message[]} */ ([])
  let hasMore = false
  try {
    const resp = /** @type {any} */ (await cli(deps, args))
    if (seq !== loadSeq) return
    messages = (resp && resp.messages) || []
    hasMore = !!(resp && resp.hasMore)
  } catch (err) {
    if (seq !== loadSeq) return
    stage.innerHTML = `<p class="empty-state">读取失败：${escapeHtml(err instanceof Error ? err.message : String(err))}</p>`
    return
  }

  loadedMessages = messages
  oldestLoadedTs = messages.length > 0 ? (messages[0]?.ts ?? null) : null
  timelineHasMore = hasMore

  if (messages.length === 0) {
    stage.innerHTML = `<p class="empty-state">这个对话还没有消息。</p>`
    return
  }

  // Resolve avatars once (bot + the inbound human) — best-effort.
  const userName = humanName(selectedChatId)
  const [userInfo, botInfo] = await Promise.all([
    selectedChatId ? avatarInfo(deps, selectedChatId) : Promise.resolve(null),
    avatarInfo(deps, "claude"),
  ])
  if (seq !== loadSeq) return
  const ctx = {
    userName,
    userAvatar: userInfo?.exists ? `${attachmentUrl(userInfo.path)}&v=${Date.now()}` : null,
    botAvatar: botInfo?.exists ? `${attachmentUrl(botInfo.path)}&v=${Date.now()}` : null,
    userAvatarKey: selectedChatId,
    botAvatarKey: "claude",
  }

  stage.innerHTML = messages.map(m => messageHtml(m, ctx)).join("")
  // Newest at bottom — jump there on initial load.
  requestAnimationFrame(() => {
    stage.scrollTop = stage.scrollHeight
    updateLatestButton()
  })

  if (opts.highlightId) flashHit(stage, opts.highlightId)
  wireUpwardPaging(deps, stage, ctx)
}

/**
 * Wire scroll-near-top upward paging: when the user scrolls within 80px of
 * the top and older pages exist, fetch the prior page and prepend it,
 * preserving the visible scroll position.
 * @param {Deps} deps @param {HTMLElement} stage
 * @param {{ userName: string, userAvatar?: string|null, botAvatar?: string|null }} ctx
 */
function wireUpwardPaging(deps, stage, ctx) {
  if (stage.dataset.pagingWired === "1") return
  stage.dataset.pagingWired = "1"
  stage.addEventListener("scroll", async () => {
    updateLatestButton()
    if (stage.scrollTop > 80 || !timelineHasMore || pagingInFlight || !oldestLoadedTs || !selectedChatId) return
    pagingInFlight = true
    const prevHeight = stage.scrollHeight
    try {
      const args = ["dialogue", "timeline", "--chat-id", selectedChatId, "--limit", String(TIMELINE_PAGE), "--before", oldestLoadedTs, "--json"]
      const resp = /** @type {any} */ (await cli(deps, args))
      const older = /** @type {Message[]} */ ((resp && resp.messages) || [])
      timelineHasMore = !!(resp && resp.hasMore)
      if (older.length > 0) {
        oldestLoadedTs = older[0]?.ts ?? oldestLoadedTs
        loadedMessages = [...older, ...loadedMessages]
        stage.insertAdjacentHTML("afterbegin", older.map(m => messageHtml(m, ctx)).join(""))
        // Preserve scroll position so the view doesn't jump, then release the
        // paging lock INSIDE the rAF — clearing it before the queued frame
        // ran let a rapid second scroll fire another fetch that mutated
        // scrollHeight before this correction applied, snapping the view.
        requestAnimationFrame(() => {
          stage.scrollTop = stage.scrollHeight - prevHeight
          pagingInFlight = false
        })
      } else {
        // Nothing prepended — no rAF queued, so release here.
        pagingInFlight = false
      }
    } catch (err) {
      console.error("dialogue upward paging failed", err)
      // Safety clear so an error never wedges paging permanently.
      pagingInFlight = false
    }
  })
}

/** @param {HTMLElement} container @param {string} msgId */
function flashHit(container, msgId) {
  requestAnimationFrame(() => {
    const el = container.querySelector(`[data-msg-id="${cssEscape(msgId)}"]`)
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" })
      el.classList.add("dialogue-hit")
      setTimeout(() => el.classList.remove("dialogue-hit"), 2200)
    }
  })
}

/** Minimal CSS attribute-selector escaping for ids. @param {string} s */
function cssEscape(s) {
  return String(s).replace(/["\\]/g, "\\$&")
}

// ── view switching ─────────────────────────────────────────────────────

function showTimelineView() {
  const timeline = document.getElementById("dialogue-timeline")
  const detail = document.getElementById("dialogue-thread-detail")
  const groups = document.getElementById("dialogue-groups")
  if (timeline) timeline.hidden = false
  if (detail) detail.hidden = true
  if (groups) groups.hidden = true
  updateLatestButton()
}

function showThreadDetailView() {
  const timeline = document.getElementById("dialogue-timeline")
  const detail = document.getElementById("dialogue-thread-detail")
  if (timeline) timeline.hidden = true
  if (detail) detail.hidden = false
  updateLatestButton()
}

/** @param {ViewId} view */
function setActiveViewButton(view) {
  document.querySelectorAll("#dialogue-views .dialogue-view-btn").forEach(el => {
    const btn = /** @type {HTMLElement} */ (el)
    btn.classList.toggle("is-active", btn.dataset.view === view)
  })
}

/**
 * Switch to a view. timeline → message flow. facet views (task/knowledge/
 * life) → thread cards in #dialogue-groups.
 * @param {Deps} deps @param {ViewId} view
 */
async function switchView(deps, view) {
  currentView = view
  setActiveViewButton(view)
  if (view === "timeline") {
    await loadTimeline(deps)
    return
  }
  await loadThreads(deps, view)
}

// ── refresh + auto-refresh ─────────────────────────────────────────────

/** How close to the bottom (px) counts as "at bottom" for auto-refresh. */
const SCROLL_BOTTOM_THRESHOLD = 80

/**
 * Show the return affordance only while the plain timeline is visible and
 * the user is away from its newest edge. An anchored search page is never
 * the real newest page, even when its scrollbar is at the bottom.
 */
function updateLatestButton() {
  const button = /** @type {HTMLButtonElement|null} */ (document.getElementById("dialogue-latest"))
  const stage = /** @type {HTMLElement|null} */ (document.getElementById("dialogue-timeline"))
  if (!button || !stage) return
  const timelineVisible = currentView === "timeline" && !stage.hidden && !timelineShowingSearchResults
  const distanceFromBottom = stage.scrollHeight - stage.scrollTop - stage.clientHeight
  button.hidden = !timelineVisible || (timelineShowsNewest && distanceFromBottom <= SCROLL_BOTTOM_THRESHOLD)
}

/**
 * Re-run the current view's loader. `opts.auto` marks an auto-refresh tick:
 * it skips while an upward-page fetch is in flight, and for the timeline
 * only refreshes when the user is scrolled near the bottom (so we don't
 * yank them away from older messages they're reading). Manual refresh
 * (the button) always reloads.
 * @param {Deps} deps @param {{ auto?: boolean }} [opts]
 */
async function refreshCurrentView(deps, opts = {}) {
  if (opts.auto && pagingInFlight) return
  if (currentView === "timeline") {
    if (opts.auto) {
      const stage = document.getElementById("dialogue-timeline")
      // Skip when the search hit list is showing — a tick would clobber it.
      const searchInput = /** @type {HTMLInputElement|null} */ (document.getElementById("dialogue-search"))
      if ((searchInput?.value?.trim().length ?? 0) >= 2) return
      if (stage) {
        const distFromBottom = stage.scrollHeight - stage.scrollTop - stage.clientHeight
        if (distFromBottom > SCROLL_BOTTOM_THRESHOLD) return
      }
    }
    await loadTimeline(deps)
    return
  }
  await loadThreads(deps, /** @type {any} */ (currentView))
}

/** @type {ReturnType<typeof setInterval>|null} */
let dialogueAutoTimer = null

/**
 * Start the 30s auto-refresh tick. Only re-runs the current view's loader
 * while the dialogue pane is actually visible (the pane is the
 * data-pane="sessions" article). Idempotent — a second call is a no-op.
 * @param {Deps} deps @param {number} [intervalMs]
 */
function startDialogueAutoRefresh(deps, intervalMs = 30000) {
  if (dialogueAutoTimer) return
  dialogueAutoTimer = setInterval(() => {
    const pane = document.querySelector('.dash-pane[data-pane="sessions"]')
    // Pane hidden (user switched away but stop somehow missed) → bail.
    if (pane instanceof HTMLElement && pane.hidden) return
    refreshCurrentView(deps, { auto: true }).catch(err => console.error("dialogue auto-refresh failed", err))
  }, intervalMs)
}

/** Stop the auto-refresh tick. Called from main.js on pane switch-away. */
export function stopDialogueAutoRefresh() {
  if (dialogueAutoTimer) {
    clearInterval(dialogueAutoTimer)
    dialogueAutoTimer = null
  }
}

// ── facet lenses (thread cards) ────────────────────────────────────────

/**
 * Load threads for a facet into #dialogue-groups as cards. Queries WITHOUT
 * --include-private unless the user has unlocked this session.
 * @param {Deps} deps @param {'task'|'knowledge'|'life'} facet
 */
async function loadThreads(deps, facet) {
  const seq = ++loadSeq
  const groups = document.getElementById("dialogue-groups")
  if (!groups) return
  // Facet views show the card list in the sidebar; the stage keeps the
  // timeline area visible (cards open detail there on click).
  groups.hidden = false
  const timeline = document.getElementById("dialogue-timeline")
  const detail = document.getElementById("dialogue-thread-detail")
  if (timeline) timeline.hidden = false
  if (detail) detail.hidden = true

  if (!selectedChatId) {
    if (seq !== loadSeq) return
    groups.innerHTML = `<p class="empty-state">还没有对话。</p>`
    return
  }
  if (seq !== loadSeq) return
  groups.innerHTML = `<p class="empty-state">加载中…</p>`

  const args = ["dialogue", "threads", "--chat-id", selectedChatId, "--facet", facet, "--json"]
  if (unlocked) args.push("--include-private")

  /** @type {Thread[]} */
  let threads = []
  try {
    const resp = /** @type {any} */ (await cli(deps, args))
    if (seq !== loadSeq) return
    threads = (resp && resp.threads) || []
  } catch (err) {
    if (seq !== loadSeq) return
    groups.innerHTML = `<p class="empty-state">读取失败：${escapeHtml(err instanceof Error ? err.message : String(err))}</p>`
    return
  }

  // The lock affordance: three states (hidden entirely when no lock is
  // configured):
  //   • not unlocked → "解锁私密话题" (opens the passphrase dialog)
  //   • unlocked     → "重新锁定" (re-arms the session lock so private
  //                     threads disappear again — mirrors the data-lock
  //                     pattern of the original mockup)
  let lockRow = ""
  if (!noLockConfigured) {
    lockRow = unlocked
      ? `<button class="dialogue-locked-row" data-action="relock">
          <span>${icon("square-unlock-01", { size: 20 })}</span>
          <span>重新锁定</span>
        </button>`
      : `<button class="dialogue-locked-row" data-action="unlock">
          <span>${icon("square-lock-01", { size: 20 })}</span>
          <span>解锁私密话题</span>
        </button>`
  }

  if (threads.length === 0) {
    groups.innerHTML = `<section class="dialogue-group"><div class="dialogue-group-items">${
      lockRow || `<p class="empty-state">这个分类下还没有话题。</p>`
    }</div></section>`
    return
  }

  const cards = threads.map(t => threadCardHtml(t)).join("")
  groups.innerHTML = `<section class="dialogue-group"><div class="dialogue-group-items">${cards}${lockRow}</div></section>`
}

/** @param {Thread} t */
function threadCardHtml(t) {
  const hasTags = t.tags && t.tags.length > 0
  const tagsHtml = hasTags
    ? `<span class="dialogue-topic-tags">${t.tags.map(tag => `<span>${escapeHtml(tag)}</span>`).join("")}</span>`
    : ""
  const status = STATUS_LABEL[t.status] || t.status
  const when = t.lastActive ? escapeHtml(formatRelativeTimeShort(t.lastActive)) : ""
  return `<button class="dialogue-topic${hasTags ? " has-tags" : ""}" data-thread="${escapeHtml(t.id)}">
    <span class="dialogue-topic-main">
      <span class="dialogue-topic-title">${escapeHtml(t.title)}</span>
      ${tagsHtml}
    </span>
    <span class="dialogue-progress">${escapeHtml(status)}${when ? ` · ${when}` : ""}</span>
  </button>`
}

/**
 * Open a thread's detail in the stage: summary + per-episode message
 * rendering, plus a "在时间线中查看" button that switches to the timeline
 * anchored at the thread's last episode.
 * @param {Deps} deps @param {string} threadId
 */
async function openThreadDetail(deps, threadId) {
  const seq = ++loadSeq
  const detail = document.getElementById("dialogue-thread-detail")
  if (!detail) return
  showThreadDetailView()
  if (seq !== loadSeq) return
  detail.innerHTML = `<p class="empty-state">加载中…</p>`

  /** @type {{ thread: Thread, episodes: Episode[] }|null} */
  let data = null
  try {
    const resp = /** @type {any} */ (await cli(deps, ["dialogue", "thread-detail", threadId, "--json"]))
    if (seq !== loadSeq) return
    if (resp && resp.ok === false) { data = null }
    else data = resp
  } catch (err) {
    if (seq !== loadSeq) return
    detail.innerHTML = `<p class="empty-state">读取失败：${escapeHtml(err instanceof Error ? err.message : String(err))}</p>`
    return
  }
  if (!data || !data.thread) {
    detail.innerHTML = `<p class="empty-state">话题不存在或已删除。</p>`
    return
  }

  const t = data.thread
  const userName = humanName(selectedChatId)
  const [userInfo, botInfo] = await Promise.all([
    selectedChatId ? avatarInfo(deps, selectedChatId) : Promise.resolve(null),
    avatarInfo(deps, "claude"),
  ])
  if (seq !== loadSeq) return
  const ctx = {
    userName,
    userAvatar: userInfo?.exists ? `${attachmentUrl(userInfo.path)}&v=${Date.now()}` : null,
    botAvatar: botInfo?.exists ? `${attachmentUrl(botInfo.path)}&v=${Date.now()}` : null,
    userAvatarKey: selectedChatId,
    botAvatarKey: "claude",
  }

  const lastEpisode = data.episodes[data.episodes.length - 1] || null
  const anchorTs = lastEpisode ? lastEpisode.to_ts : ""
  const episodesHtml = data.episodes.map((ep, i) => {
    const body = ep.messages.map(m => messageHtml(m, ctx)).join("") || `<p class="empty-state">（无消息）</p>`
    return `<section class="dialogue-episode">
      <div class="dialogue-episode-head">片段 ${i + 1}</div>
      ${body}
    </section>`
  }).join("")

  const tagsHtml = (t.tags && t.tags.length > 0)
    ? `<span class="dialogue-topic-tags">${t.tags.map(tag => `<span>${escapeHtml(tag)}</span>`).join("")}</span>`
    : ""

  detail.innerHTML = `
    <div class="dialogue-thread-summary">
      <div class="dialogue-thread-title">${escapeHtml(t.title)}</div>
      ${tagsHtml}
      ${t.summary ? `<p class="dialogue-thread-text">${escapeHtml(t.summary)}</p>` : ""}
      <button class="dialogue-action-pill" data-action="anchor-timeline" data-anchor="${escapeHtml(anchorTs)}" type="button">
        ${icon("time-02", { size: 16 })}<span>在时间线中查看</span>
      </button>
    </div>
    ${episodesHtml}
  `
}

// ── privacy unlock ─────────────────────────────────────────────────────

function openPrivacyDialog() {
  const modal = document.getElementById("privacy-dialog")
  if (!modal) return
  modal.hidden = false
  const input = /** @type {HTMLInputElement|null} */ (document.getElementById("privacy-password"))
  if (input) { input.value = ""; setTimeout(() => input.focus(), 0) }
  const err = modal.querySelector(".privacy-error")
  if (err instanceof HTMLElement) err.hidden = true
}

function closePrivacyDialog() {
  const modal = document.getElementById("privacy-dialog")
  if (modal) modal.hidden = true
}

/**
 * Submit the passphrase: call `dialogue unlock`. ok → flip session state,
 * re-query the current facet with --include-private. no_lock_configured →
 * hide the lock affordance entirely.
 * @param {Deps} deps @param {string} passphrase
 */
async function submitUnlock(deps, passphrase) {
  const modal = document.getElementById("privacy-dialog")
  const err = modal?.querySelector(".privacy-error")
  /** @type {{ok:boolean, error?:string}} */
  let result = { ok: false }
  try {
    result = /** @type {any} */ (await cli(deps, ["dialogue", "unlock", "--passphrase", passphrase, "--json"]))
  } catch (e) {
    console.error("dialogue unlock failed", e)
  }
  if (result.ok) {
    unlocked = true
    closePrivacyDialog()
    if (currentView !== "timeline") await loadThreads(deps, /** @type {any} */ (currentView))
    return
  }
  if (result.error === "no_lock_configured") {
    // Nothing to unlock — hide the affordance and just refresh.
    noLockConfigured = true
    closePrivacyDialog()
    if (currentView !== "timeline") await loadThreads(deps, /** @type {any} */ (currentView))
    return
  }
  if (err instanceof HTMLElement) err.hidden = false
  const input = /** @type {HTMLInputElement|null} */ (document.getElementById("privacy-password"))
  if (input) input.select()
}

// ── search ─────────────────────────────────────────────────────────────

/** @type {ReturnType<typeof setTimeout>|null} */
let searchTimer = null

/**
 * Run a search and render hits into the stage. Clicking a hit loads the
 * timeline anchored just after the hit ts with the hit message highlighted.
 * @param {Deps} deps @param {string} query
 */
async function runSearch(deps, query) {
  const seq = ++loadSeq
  const trimmed = (query || "").trim()
  const stage = document.getElementById("dialogue-timeline")
  if (!stage) return
  if (trimmed.length < 2) {
    // Empty / too-short — restore the current view.
    if (currentView === "timeline") await loadTimeline(deps)
    else await loadThreads(deps, /** @type {any} */ (currentView))
    return
  }
  if (!selectedChatId) return
  if (seq !== loadSeq) return
  timelineShowingSearchResults = true
  showTimelineView()
  const groups = document.getElementById("dialogue-groups")
  if (groups) groups.hidden = true
  stage.innerHTML = `<p class="empty-state">搜索中…</p>`
  updateLatestButton()

  /** @type {Message[]} */
  let hits = []
  try {
    const resp = /** @type {any} */ (await cli(deps, ["dialogue", "search", "--chat-id", selectedChatId, trimmed, "--json"]))
    if (seq !== loadSeq) return
    hits = (resp && resp.hits) || []
  } catch (err) {
    if (seq !== loadSeq) return
    stage.innerHTML = `<p class="empty-state">搜索失败：${escapeHtml(err instanceof Error ? err.message : String(err))}</p>`
    return
  }
  if (seq !== loadSeq) return
  if (hits.length === 0) {
    stage.innerHTML = `<p class="empty-state">没找到「${escapeHtml(trimmed)}」。</p>`
    return
  }
  stage.innerHTML = `<div class="dialogue-search-hits">${hits.map(h => searchHitHtml(h)).join("")}</div>`
}

/** @param {Message} h */
function searchHitHtml(h) {
  const who = h.direction === "in" ? humanName(h.chatId) : botLabel(h)
  const snippet = h.text.length > 140 ? h.text.slice(0, 140) + "…" : h.text
  return `<button class="dialogue-hit-row" data-hit-id="${escapeHtml(h.id)}" data-hit-ts="${escapeHtml(h.ts)}">
    <span class="dialogue-hit-who">${escapeHtml(who)}</span>
    <span class="dialogue-hit-text">${escapeHtml(snippet)}</span>
  </button>`
}

/**
 * Jump from a search hit to the timeline: load the page ending just after
 * the hit ts (so the hit is on-page) and flash it.
 * @param {Deps} deps @param {string} hitId @param {string} hitTs
 */
async function openHit(deps, hitId, hitTs) {
  // --before is exclusive; nudge 1ms past the hit ts so the hit itself
  // is included on the page.
  let beforeTs = hitTs
  const ms = new Date(hitTs).getTime()
  if (Number.isFinite(ms)) beforeTs = new Date(ms + 1).toISOString()
  await loadTimeline(deps, { beforeTs, highlightId: hitId })
}

// ── export ─────────────────────────────────────────────────────────────

/** Hard cap on exported messages — guards against runaway loops / huge chats. */
const EXPORT_MAX_MESSAGES = 5000

/**
 * Page through the FULL timeline for the selected chat (oldest→newest),
 * independent of what's currently loaded in the DOM. Loops `dialogue
 * timeline --before` until hasMore=false (or the cap is hit). Returns
 * messages in ascending ts order.
 * @param {Deps} deps @param {string} chatId
 * @returns {Promise<Message[]>}
 */
async function fetchFullTimeline(deps, chatId) {
  /** @type {Message[]} */
  let all = []
  /** @type {string|undefined} */
  let beforeTs = undefined
  // Loop newest-page → older-page; prepend each older page.
  for (let guard = 0; guard < 1000; guard++) {
    const args = ["dialogue", "timeline", "--chat-id", chatId, "--limit", String(TIMELINE_PAGE), "--json"]
    if (beforeTs) args.push("--before", beforeTs)
    const resp = /** @type {any} */ (await cli(deps, args))
    const page = /** @type {Message[]} */ ((resp && resp.messages) || [])
    const hasMore = !!(resp && resp.hasMore)
    if (page.length === 0) break
    all = [...page, ...all]
    if (all.length >= EXPORT_MAX_MESSAGES) {
      console.warn(`dialogue export: hit ${EXPORT_MAX_MESSAGES}-message cap; transcript truncated to the newest messages`)
      all = all.slice(-EXPORT_MAX_MESSAGES)
      break
    }
    if (!hasMore) break
    beforeTs = page[0]?.ts
    if (!beforeTs) break
  }
  return all
}

/**
 * Build a Markdown transcript from the FULL timeline (paged independently
 * of loadedMessages) and trigger a download (Tauri save_text_file, else
 * blob fallback — same approach as sessions.js exportProjectMarkdown).
 * @param {Deps} deps
 */
async function exportMarkdown(deps) {
  if (!selectedChatId) return
  const exportBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById("dialogue-export"))
  const chatId = selectedChatId
  let messages
  if (exportBtn) exportBtn.disabled = true
  try {
    messages = await fetchFullTimeline(deps, chatId)
  } catch (err) {
    console.error("dialogue export: timeline fetch failed", err)
    alert(`导出失败：${err instanceof Error ? err.message : String(err)}`)
    if (exportBtn) exportBtn.disabled = false
    return
  }
  if (messages.length === 0) {
    if (exportBtn) exportBtn.disabled = false
    return
  }
  const name = humanName(chatId)
  const header = `# 对话 — ${name}\n\n`
  const lines = []
  for (const m of messages) {
    if (m.kind === "command") continue
    if (m.direction === "in") {
      lines.push(m.text.split("\n").map(l => `> ${l}`).join("\n"))
    } else {
      lines.push(`**${botLabel(m)}**：${m.text}`)
    }
  }
  const md = header + lines.join("\n\n") + "\n"
  const filename = `dialogue-${name}.md`
  try {
    if (/** @type {any} */ (window).__TAURI__?.core?.invoke) {
      const path = await deps.invoke("save_text_file", { filename, content: md })
      alert(`已导出：${path}`)
    } else {
      const blob = new Blob([md], { type: "text/markdown" })
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = filename
      a.click()
      URL.revokeObjectURL(url)
    }
  } catch (err) {
    console.error("dialogue export failed", err)
    alert(`导出失败：${err instanceof Error ? err.message : String(err)}`)
  } finally {
    if (exportBtn) exportBtn.disabled = false
  }
}

// ── event wiring ───────────────────────────────────────────────────────

/** @param {HTMLElement} root @param {Deps} deps */
function wireEvents(root, deps) {
  // Chat switcher.
  root.querySelector("#dialogue-chat-switcher")?.addEventListener("click", async (ev) => {
    const btn = ev.target instanceof Element ? ev.target.closest("[data-chat]") : null
    if (!(btn instanceof HTMLElement)) return
    const chatId = btn.dataset.chat
    if (!chatId || chatId === selectedChatId) return
    selectedChatId = chatId
    root.querySelectorAll("#dialogue-chat-switcher .dialogue-chat-row").forEach(el => {
      el.classList.toggle("is-active", /** @type {HTMLElement} */ (el).dataset.chat === chatId)
    })
    await switchView(deps, currentView)
  })

  // View nav.
  root.querySelector("#dialogue-views")?.addEventListener("click", (ev) => {
    const btn = ev.target instanceof Element ? ev.target.closest("[data-view]") : null
    if (!(btn instanceof HTMLElement) || !btn.dataset.view) return
    switchView(deps, /** @type {ViewId} */ (btn.dataset.view)).catch(err => console.error("dialogue view switch failed", err))
  })

  // Thread cards + unlock row (in #dialogue-groups).
  root.querySelector("#dialogue-groups")?.addEventListener("click", (ev) => {
    const target = ev.target instanceof Element ? ev.target : null
    if (!target) return
    const unlockBtn = target.closest("[data-action='unlock']")
    if (unlockBtn) { openPrivacyDialog(); return }
    const relockBtn = target.closest("[data-action='relock']")
    if (relockBtn) {
      // Re-arm the session lock and re-render the current facet so private
      // threads drop out again.
      unlocked = false
      if (currentView !== "timeline") {
        loadThreads(deps, /** @type {any} */ (currentView)).catch(err => console.error("dialogue relock reload failed", err))
      }
      return
    }
    const card = target.closest("[data-thread]")
    if (card instanceof HTMLElement && card.dataset.thread) {
      openThreadDetail(deps, card.dataset.thread).catch(err => console.error("dialogue thread detail failed", err))
    }
  })

  // Thread detail "在时间线中查看" anchor.
  root.querySelector("#dialogue-thread-detail")?.addEventListener("click", (ev) => {
    const target = ev.target instanceof Element ? ev.target : null
    const anchor = target?.closest("[data-action='anchor-timeline']")
    if (!(anchor instanceof HTMLElement)) return
    const ts = anchor.dataset.anchor || ""
    setActiveViewButton("timeline")
    currentView = "timeline"
    const groups = document.getElementById("dialogue-groups")
    if (groups) groups.hidden = true
    const ms = new Date(ts).getTime()
    const beforeTs = Number.isFinite(ms) ? new Date(ms + 1).toISOString() : undefined
    loadTimeline(deps, beforeTs ? { beforeTs } : {}).catch(err => console.error("dialogue anchor failed", err))
  })

  // Search hits (delegated on the timeline container).
  root.querySelector("#dialogue-timeline")?.addEventListener("click", (ev) => {
    const target = ev.target instanceof Element ? ev.target : null
    const hit = target?.closest("[data-hit-id]")
    if (!(hit instanceof HTMLElement)) return
    openHit(deps, hit.dataset.hitId || "", hit.dataset.hitTs || "").catch(err => console.error("dialogue open hit failed", err))
  })

  // Search input — 250ms debounce (mirrors sessions.js wireSearch).
  const searchInput = /** @type {HTMLInputElement|null} */ (root.querySelector("#dialogue-search"))
  searchInput?.addEventListener("input", () => {
    if (searchTimer !== null) clearTimeout(searchTimer)
    searchTimer = setTimeout(() => runSearch(deps, searchInput.value), 250)
  })

  // Export.
  root.querySelector("#dialogue-export")?.addEventListener("click", () => {
    exportMarkdown(deps).catch(err => console.error("dialogue export failed", err))
  })

  // Manual refresh — always reloads the current view (ignores the
  // scroll-near-bottom guard the auto-tick uses).
  root.querySelector("#dialogue-refresh")?.addEventListener("click", () => {
    refreshCurrentView(deps).catch(err => console.error("dialogue refresh failed", err))
  })

  // Return to the actual newest message. Search anchors can render an older
  // page whose local bottom is not the conversation's real bottom, so those
  // reload the newest page instead of merely scrolling the current page.
  root.querySelector("#dialogue-latest")?.addEventListener("click", () => {
    const stage = document.getElementById("dialogue-timeline")
    if (!stage) return
    if (!timelineShowsNewest) {
      loadTimeline(deps).catch(err => console.error("dialogue latest load failed", err))
      return
    }
    stage.scrollTo({ top: stage.scrollHeight, behavior: "smooth" })
  })

  // Privacy dialog: close / submit.
  const modal = root.querySelector("#privacy-dialog")
  modal?.addEventListener("click", (ev) => {
    const target = ev.target instanceof Element ? ev.target : null
    if (target?.closest(".privacy-close") || target === modal) closePrivacyDialog()
  })
  root.querySelector(".privacy-card")?.addEventListener("submit", (ev) => {
    ev.preventDefault()
    const input = /** @type {HTMLInputElement|null} */ (document.getElementById("privacy-password"))
    if (!input) return
    submitUnlock(deps, input.value).catch(err => console.error("dialogue unlock failed", err))
  })
}

// ── entry point ────────────────────────────────────────────────────────

/**
 * Initialise the 对话 pane. Idempotent — guarded by root.dataset.ready so
 * re-entry (pane re-switch) doesn't double-wire. On first init it renders
 * the skeleton, wires events, loads the chat list, and shows the timeline.
 * @param {Deps} deps
 */
export function initDialoguePage(deps) {
  const root = document.getElementById("dialogue-root")
  if (!root) return
  // (Re)start the 30s auto-refresh tick on every entry into the pane.
  // main.js stops it on switch-away via stopDialogueAutoRefresh().
  startDialogueAutoRefresh(deps)
  if (root.dataset.ready === "true") {
    // Already mounted — just refresh the current view so re-entering the
    // pane picks up new messages.
    loadChats(deps)
      .then(() => switchView(deps, currentView))
      .catch(err => console.error("dialogue refresh failed", err))
    return
  }
  root.dataset.ready = "true"
  renderSkeleton(root)
  wireEvents(root, deps)
  loadChats(deps)
    .then(() => loadTimeline(deps))
    .catch(err => {
      console.error("dialogue init failed", err)
      const stage = document.getElementById("dialogue-timeline")
      if (stage) stage.innerHTML = `<p class="empty-state">加载失败：${escapeHtml(err instanceof Error ? err.message : String(err))}</p>`
    })
}

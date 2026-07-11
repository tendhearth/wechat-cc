// @ts-check
/// <reference lib="dom" />
//
// converse.js — the "跟 CC 说" pane: a minimal in-app text channel to the
// owner's CC, independent of WeChat. Calls the `agent_converse` Tauri
// command (apps/desktop/src-tauri/src/lib.rs), which drives the owner's
// session directly and returns the whole reply in one shot (no streaming /
// splitting — that's a WeChat-channel concern, not this one).
//
// Deliberately minimal, matching the "keep desktop UI simple" convention:
// an in-memory message list (not persisted, not paged from the daemon —
// the read-only 对话 pane already covers full transcript history) plus a
// compose row. Same vanilla-JS module shape as dialogue-page.js / logs.js.

import { escapeHtml } from "../view.js"
import { formatInvokeError } from "../ipc.js"

/**
 * @typedef {{ invoke: (cmd: string, args: Record<string, unknown>) => Promise<unknown> }} Deps
 * @typedef {{ id: number, role: 'user'|'cc'|'error', text: string, pending?: boolean }} ConverseMsg
 */

// ── module state ───────────────────────────────────────────────────────
// In-memory only — reset on app reload, preserved across pane switches
// (the DOM isn't torn down, just hidden; see initConversePage's
// dataset.ready guard, mirroring dialogue-page.js / a2a-agents.js).
/** @type {ConverseMsg[]} */
let messages = []
let nextId = 1
let sending = false

// ── skeleton ───────────────────────────────────────────────────────────

/** @param {HTMLElement} root */
function renderSkeleton(root) {
  root.innerHTML = `
    <div id="converse-scroll" class="converse-scroll"></div>
    <div class="converse-compose">
      <textarea id="converse-input" class="converse-textarea" placeholder="跟 CC 说点什么…" rows="1"></textarea>
      <button id="converse-send" class="btn primary converse-send-btn" type="button">发送</button>
    </div>
  `
}

// ── rendering ──────────────────────────────────────────────────────────

/** @param {ConverseMsg} m */
function messageHtml(m) {
  if (m.role === "error") {
    return `<div class="converse-error-line">${escapeHtml(m.text)}</div>`
  }
  const roleCls = m.role === "user" ? "converse-msg-user" : "converse-msg-cc"
  const pendingCls = m.pending ? " is-pending" : ""
  return `<div class="converse-msg ${roleCls}${pendingCls}">
    <div class="converse-bubble">${escapeHtml(m.text)}</div>
  </div>`
}

function renderMessages() {
  const scroll = document.getElementById("converse-scroll")
  if (!scroll) return
  scroll.innerHTML = messages.length === 0
    ? `<p class="empty-state">跟 CC 说点什么吧——直接在这里聊，不走微信。</p>`
    : messages.map(messageHtml).join("")
  requestAnimationFrame(() => { scroll.scrollTop = scroll.scrollHeight })
}

// ── send ───────────────────────────────────────────────────────────────

/** @param {Deps} deps */
async function sendMessage(deps) {
  if (sending) return
  const input = /** @type {HTMLTextAreaElement|null} */ (document.getElementById("converse-input"))
  const sendBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById("converse-send"))
  if (!input || !sendBtn) return
  const text = input.value.trim()
  if (!text) return

  messages.push({ id: nextId++, role: "user", text })
  const pendingId = nextId++
  messages.push({ id: pendingId, role: "cc", text: "…", pending: true })
  sending = true
  sendBtn.disabled = true
  input.disabled = true
  renderMessages()

  try {
    const reply = await deps.invoke("agent_converse", { text })
    messages = messages.filter(m => m.id !== pendingId)
    messages.push({ id: nextId++, role: "cc", text: String(reply ?? "") })
    // Only clear the compose box on success — an error leaves the typed
    // text in place so the user doesn't lose it and can just retry.
    input.value = ""
  } catch (err) {
    messages = messages.filter(m => m.id !== pendingId)
    const raw = formatInvokeError(err)
    const friendly = /session_busy/.test(raw)
      ? "CC 正在忙（可能在回微信），稍等再试"
      : raw
    messages.push({ id: nextId++, role: "error", text: friendly })
  } finally {
    sending = false
    sendBtn.disabled = false
    input.disabled = false
    renderMessages()
    input.focus()
  }
}

// ── event wiring ───────────────────────────────────────────────────────

/** @param {HTMLElement} root @param {Deps} deps */
function wireEvents(root, deps) {
  root.querySelector("#converse-send")?.addEventListener("click", () => {
    sendMessage(deps).catch(err => console.error("converse send failed", err))
  })

  const input = /** @type {HTMLTextAreaElement|null} */ (root.querySelector("#converse-input"))
  input?.addEventListener("keydown", (ev) => {
    if (ev instanceof KeyboardEvent && ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault()
      sendMessage(deps).catch(err => console.error("converse send failed", err))
    }
  })
}

// ── entry point ────────────────────────────────────────────────────────

/**
 * Initialise the "跟 CC 说" pane. Idempotent — guarded by root.dataset.ready
 * so re-entry (pane re-switch) doesn't double-wire or wipe the in-memory
 * message list. On first init it renders the skeleton and wires events.
 * @param {Deps} deps
 */
export function initConversePage(deps) {
  const root = document.getElementById("converse-root")
  if (!root) return
  if (root.dataset.ready === "true") {
    const input = document.getElementById("converse-input")
    if (input instanceof HTMLElement) input.focus()
    return
  }
  root.dataset.ready = "true"
  renderSkeleton(root)
  wireEvents(root, deps)
  renderMessages()
  const input = document.getElementById("converse-input")
  if (input instanceof HTMLElement) input.focus()
}

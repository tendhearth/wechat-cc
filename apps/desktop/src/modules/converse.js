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
 * @typedef {{ id: number, role: 'user'|'cc'|'error'|'system', text: string, pending?: boolean }} ConverseMsg
 */

// ── module state ───────────────────────────────────────────────────────
// In-memory only — reset on app reload, preserved across pane switches
// (the DOM isn't torn down, just hidden; see initConversePage's
// dataset.ready guard, mirroring dialogue-page.js / a2a-agents.js).
/** @type {ConverseMsg[]} */
let messages = []
let nextId = 1
let sending = false

// Voice-out (Stage 1): 🔊 toggle persisted across app restarts, default OFF.
// `no_voice_config` is expected to fire on every reply once the daemon has
// no voice configured, so we surface it once per pane session rather than
// spamming a muted note after each turn.
let voiceOut = localStorage.getItem("cc.voiceOut") === "1"
let voiceConfigWarned = false

// ── skeleton ───────────────────────────────────────────────────────────

/** @param {HTMLElement} root */
function renderSkeleton(root) {
  root.innerHTML = `
    <div id="converse-scroll" class="converse-scroll"></div>
    <div class="converse-compose">
      <button id="converse-voice-toggle" class="converse-voice-toggle" type="button" aria-pressed="false" title="自动朗读 CC 的回复">🔊 语音</button>
      <textarea id="converse-input" class="converse-textarea" placeholder="跟 CC 说点什么…" rows="1"></textarea>
      <button id="converse-send" class="btn primary converse-send-btn" type="button">发送</button>
    </div>
  `
}

/** Reflect `voiceOut` on the toggle button (class + aria-pressed). */
function syncVoiceToggleUI() {
  const btn = document.getElementById("converse-voice-toggle")
  if (!btn) return
  btn.classList.toggle("is-on", voiceOut)
  btn.setAttribute("aria-pressed", String(voiceOut))
}

/** @param {boolean} v */
function setVoiceOut(v) {
  voiceOut = v
  localStorage.setItem("cc.voiceOut", v ? "1" : "0")
  syncVoiceToggleUI()
}

// ── rendering ──────────────────────────────────────────────────────────

/** @param {ConverseMsg} m */
function messageHtml(m) {
  if (m.role === "error") {
    return `<div class="converse-error-line">${escapeHtml(m.text)}</div>`
  }
  if (m.role === "system") {
    return `<div class="converse-system-line">${escapeHtml(m.text)}</div>`
  }
  const roleCls = m.role === "user" ? "converse-msg-user" : "converse-msg-cc"
  const pendingCls = m.pending ? " is-pending" : ""
  // Replay is only meaningful for a real CC reply — not the "…" placeholder
  // and not the user's own bubble.
  const replayBtn = m.role === "cc" && !m.pending
    ? `<button class="voice-replay-btn" type="button" data-msg-id="${m.id}" title="朗读">▶</button>`
    : ""
  return `<div class="converse-msg ${roleCls}${pendingCls}">
    <div class="converse-bubble">${escapeHtml(m.text)}</div>
    ${replayBtn}
  </div>`
}

// ── voice-out (Stage 1) ───────────────────────────────────────────────

/**
 * Speak `text` via the `agent_speak` Tauri command and play the resulting
 * audio. Used both for autoplay (toggle ON, after a reply renders) and for
 * the per-bubble ▶ replay button (works regardless of the toggle).
 *
 * No path here throws: `agent_speak` failures surface as a muted system
 * note (deduped for `no_voice_config`); a rejected `.play()` (e.g. browser
 * autoplay policy) is swallowed silently — the ▶ button is the fallback.
 * @param {Deps} deps @param {string} text
 */
async function speakAndPlay(deps, text) {
  /** @type {any} */
  let res
  try {
    res = await deps.invoke("agent_speak", { text })
  } catch (err) {
    const raw = formatInvokeError(err)
    if (/no_voice_config/.test(raw)) {
      if (voiceConfigWarned) return
      voiceConfigWarned = true
      messages.push({ id: nextId++, role: "system", text: "🔇 未配置语音" })
    } else {
      messages.push({ id: nextId++, role: "system", text: "🔇 语音失败" })
    }
    renderMessages()
    return
  }

  try {
    const audioB64 = String(res?.audio_b64 ?? "")
    const mime = String(res?.mime ?? "audio/mpeg")
    if (!audioB64) return
    const bytes = Uint8Array.from(atob(audioB64), ch => ch.charCodeAt(0))
    const blob = new Blob([bytes], { type: mime })
    const url = URL.createObjectURL(blob)
    const audio = new Audio(url)
    const cleanup = () => URL.revokeObjectURL(url)
    audio.addEventListener("ended", cleanup, { once: true })
    audio.addEventListener("error", cleanup, { once: true })
    try {
      await audio.play()
    } catch {
      cleanup()
    }
  } catch {
    // Decode failure — no crash, no error note; the ▶ replay button
    // remains as the manual fallback.
  }
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
    const replyText = String(reply ?? "")
    if (replyText.trim() === "") {
      // Bubble replies mean a turn can legitimately produce no text output
      // (e.g. the agent only sent stickers/files to WeChat). Don't render a
      // blank CC bubble for that — show a muted system note instead.
      messages.push({ id: nextId++, role: "system", text: "（CC 这轮没有用文字回复）" })
    } else {
      messages.push({ id: nextId++, role: "cc", text: replyText })
      // Fire-and-forget: autoplay must not block clearing the "sending"
      // state or the compose box. Errors are handled inside speakAndPlay.
      if (voiceOut) speakAndPlay(deps, replyText).catch(() => {})
    }
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

  root.querySelector("#converse-voice-toggle")?.addEventListener("click", () => {
    setVoiceOut(!voiceOut)
  })

  // Delegated: bubbles (and their ▶ buttons) are re-created on every
  // renderMessages(), so bind once on the scroll container rather than
  // per-bubble.
  root.querySelector("#converse-scroll")?.addEventListener("click", (ev) => {
    const target = ev.target
    if (!(target instanceof HTMLElement)) return
    const btn = target.closest(".voice-replay-btn")
    if (!(btn instanceof HTMLElement)) return
    const id = Number(btn.dataset.msgId)
    const msg = messages.find(m => m.id === id)
    if (!msg) return
    speakAndPlay(deps, msg.text).catch(() => {})
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
  syncVoiceToggleUI()
  renderMessages()
  const input = document.getElementById("converse-input")
  if (input instanceof HTMLElement) input.focus()
}

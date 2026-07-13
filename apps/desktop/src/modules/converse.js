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
 * @typedef {{ getUserMedia: (c: MediaStreamConstraints) => Promise<MediaStream>, makeRecorder: (s: MediaStream) => MediaRecorder }} MediaDeps
 * @typedef {{ invoke: (cmd: string, args: Record<string, unknown>) => Promise<unknown>, media?: MediaDeps }} Deps
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

// Voice-in (Stage 2): push-to-talk mic capture → agent_transcribe → auto-send.
/** @type {MediaRecorder|null} */
let mediaRecorder = null
/** @type {Blob[]} */
let recordedChunks = []
let recording = false
let transcribing = false

// ── skeleton ───────────────────────────────────────────────────────────

/** @param {HTMLElement} root */
function renderSkeleton(root) {
  root.innerHTML = `
    <div id="converse-scroll" class="converse-scroll"></div>
    <div class="converse-compose">
      <button id="converse-voice-toggle" class="converse-voice-toggle" type="button" aria-pressed="false" title="自动朗读 CC 的回复">🔊 语音</button>
      <button id="converse-mic" class="converse-mic" type="button" aria-pressed="false" title="按一下开始说，再按一下结束（语音转文字）">🎤 说话</button>
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

// ── voice-in (mic capture → transcribe → auto-send) ─────────────────────

/** Reflect recording/transcribing state on the mic button. */
function reflectMic() {
  const btn = document.getElementById("converse-mic")
  if (!btn) return
  btn.classList.toggle("is-recording", recording)
  btn.setAttribute("aria-pressed", String(recording))
  btn.textContent = transcribing ? "⏳ 识别中" : recording ? "⏹ 结束" : "🎤 说话"
  btn.toggleAttribute("disabled", transcribing)
}

/** Read a Blob as bare base64 (no data: prefix). @param {Blob} blob */
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onloadend = () => resolve(String(r.result).split(",")[1] ?? "")
    r.onerror = () => reject(r.error ?? new Error("read failed"))
    r.readAsDataURL(blob)
  })
}

/**
 * Toggle mic capture. First press starts recording; second press stops and
 * transcribes the clip via `agent_transcribe`, drops the text into the compose
 * box, and auto-sends it. All failures surface as a muted system/error note —
 * never a crash. `deps.media` is injectable for tests (defaults to the
 * browser's navigator.mediaDevices + MediaRecorder).
 * @param {Deps} deps
 */
async function toggleMic(deps) {
  if (transcribing) return
  if (recording) { try { mediaRecorder?.stop() } catch { /* already stopped */ } return }

  const md = deps.media ?? {
    getUserMedia: (c) => navigator.mediaDevices.getUserMedia(c),
    makeRecorder: (s) => new MediaRecorder(s),
  }
  let stream
  try {
    stream = await md.getUserMedia({ audio: true })
  } catch (err) {
    messages.push({ id: nextId++, role: "system", text: "麦克风用不了（权限或设备问题）" })
    renderMessages()
    return
  }

  recordedChunks = []
  mediaRecorder = md.makeRecorder(stream)
  mediaRecorder.addEventListener("dataavailable", (ev) => {
    const e = /** @type {BlobEvent} */ (ev)
    if (e.data && e.data.size > 0) recordedChunks.push(e.data)
  })
  mediaRecorder.addEventListener("stop", async () => {
    stream.getTracks().forEach(t => t.stop())
    recording = false
    const type = mediaRecorder?.mimeType || "audio/webm"
    const blob = new Blob(recordedChunks, { type })
    if (blob.size === 0) { reflectMic(); return }
    transcribing = true
    reflectMic()
    try {
      const b64 = await blobToBase64(blob)
      const text = String(await deps.invoke("agent_transcribe", { audio_b64: b64, mime: type }))
      transcribing = false
      reflectMic()
      if (text.trim() === "") {
        messages.push({ id: nextId++, role: "system", text: "（没听清，再说一次？）" })
        renderMessages()
        return
      }
      const input = /** @type {HTMLTextAreaElement|null} */ (document.getElementById("converse-input"))
      if (input) input.value = text
      await sendMessage(deps)   // auto-send the transcript
    } catch (err) {
      transcribing = false
      reflectMic()
      const raw = formatInvokeError(err)
      const friendly = /no_stt_config/.test(raw) ? "语音识别还没配置（去设置里填 STT 网关）" : raw
      messages.push({ id: nextId++, role: "error", text: friendly })
      renderMessages()
    }
  })
  mediaRecorder.start()
  recording = true
  reflectMic()
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

  root.querySelector("#converse-mic")?.addEventListener("click", () => {
    toggleMic(deps).catch(err => console.error("converse mic failed", err))
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

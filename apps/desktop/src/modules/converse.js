import { icon } from "./icons.js"
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

// Voice-in (Stage 2): push-to-talk mic capture → agent_transcribe → editable draft.
/** @type {MediaRecorder|null} */
let mediaRecorder = null
/** @type {Blob[]} */
let recordedChunks = []
let recording = false
let transcribing = false
let requestingMic = false
let discardRecording = false
let recordingStarted = 0
let recordingTimer = null

// ── skeleton ───────────────────────────────────────────────────────────

/** @param {HTMLElement} root */
function renderSkeleton(root) {
  root.innerHTML = `
    <div id="converse-scroll" class="converse-scroll"></div>
    <div class="converse-compose">
      <textarea id="converse-input" class="converse-textarea" aria-label="消息" placeholder="跟 CC 说点什么…" rows="2"></textarea>
      <div id="converse-recording" class="converse-recording" hidden>
        <button id="converse-cancel-recording" type="button">取消</button>
        <span class="converse-recording-dot" aria-hidden="true"></span>
        <span id="converse-recording-label" role="status">正在听…</span>
        <span id="converse-recording-time">00:00</span>
      </div>
      <div class="converse-toolbar">
        <button id="converse-mic" class="converse-mic" type="button" aria-pressed="false">${icon("mic-01")}<span>语音输入</span></button>
        <button id="converse-voice-toggle" class="converse-voice-toggle" type="button" aria-pressed="false" title="自动朗读 CC 的回复"><span class="converse-switch" aria-hidden="true"></span>朗读回复</button>
        <button id="converse-send" aria-label="发送消息" class="btn primary converse-send-btn" type="button">${icon("sent")}<span>发送</span></button>
      </div>
      <p id="converse-recording-hint" class="converse-recording-hint" hidden>结束后可检查文字再发送</p>
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
    ? `<button class="voice-replay-btn" type="button" data-msg-id="${m.id}" aria-label="朗读这条回复" title="朗读">${icon("play")} </button>`
    : ""
  return `<div class="converse-msg ${roleCls}${pendingCls}">
    ${m.role === "cc" ? '<img class="converse-avatar" src="./assets/pet/cc-v1/canonical/lit/front.png" alt="CC" width="32" height="32" />' : ""}
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
      messages.push({ id: nextId++, role: "system", text: "尚未配置朗读服务" })
    } else {
      messages.push({ id: nextId++, role: "system", text: "暂时无法朗读" })
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

// ── voice-in (mic capture → transcribe → editable draft) ─────────────────────

/** Reflect recording/transcribing state on the mic button. */
function reflectMic() {
  const btn = document.getElementById("converse-mic")
  if (!btn) return
  btn.classList.toggle("is-recording", recording)
  btn.setAttribute("aria-pressed", String(recording))
  const busy = recording || transcribing || requestingMic
  btn.innerHTML = `${icon(recording ? "stop" : "mic-01")}<span>${transcribing ? "识别中…" : requestingMic ? "等待麦克风…" : recording ? "结束录音" : "语音输入"}</span>`
  btn.toggleAttribute("disabled", transcribing || requestingMic || sending)
  const panel = document.getElementById("converse-recording")
  if (panel) panel.hidden = !busy
  const label = document.getElementById("converse-recording-label")
  if (label) label.textContent = transcribing ? "正在转成文字…" : requestingMic ? "等待麦克风权限…" : "正在听…"
  const cancel = document.getElementById("converse-cancel-recording")
  if (cancel) cancel.hidden = !recording
  const hint = document.getElementById("converse-recording-hint")
  if (hint) hint.hidden = !busy
  const input = document.getElementById("converse-input")
  if (input) input.hidden = busy
  const send = document.getElementById("converse-send")
  if (send) send.toggleAttribute("disabled", busy || sending)

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
 * box for review before sending. All failures surface as a muted system/error note —
 * never a crash. `deps.media` is injectable for tests (defaults to the
 * browser's navigator.mediaDevices + MediaRecorder).
 * @param {Deps} deps
 */
async function toggleMic(deps) {
  if (transcribing || requestingMic || sending) return
  if (recording) { try { mediaRecorder?.stop() } catch { /* already stopped */ } return }

  const md = deps.media ?? {
    getUserMedia: (c) => navigator.mediaDevices.getUserMedia(c),
    makeRecorder: (s) => new MediaRecorder(s),
  }
  let stream
  requestingMic = true
  reflectMic()
  try {
    stream = await md.getUserMedia({ audio: true })
  } catch (err) {
    requestingMic = false
    reflectMic()
    messages.push({ id: nextId++, role: "system", text: "麦克风用不了（权限或设备问题）" })
    renderMessages()
    return
  }

  requestingMic = false
  discardRecording = false
  recordedChunks = []
  try { mediaRecorder = md.makeRecorder(stream) } catch {
    stream.getTracks().forEach(t => t.stop())
    reflectMic()
    messages.push({ id: nextId++, role: "error", text: "无法启动录音，请检查设备后重试" })
    renderMessages()
    return
  }
  mediaRecorder.addEventListener("dataavailable", (ev) => {
    const e = /** @type {BlobEvent} */ (ev)
    if (e.data && e.data.size > 0) recordedChunks.push(e.data)
  })
  mediaRecorder.addEventListener("stop", async () => {
    stream.getTracks().forEach(t => t.stop())
    recording = false
    clearInterval(recordingTimer)
    if (discardRecording) { recordedChunks = []; reflectMic(); return }
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
      if (input) {
        input.value = [input.value.trim(), text.trim()].filter(Boolean).join("\n")
        input.focus()
      }
    } catch (err) {
      transcribing = false
      reflectMic()
      const raw = formatInvokeError(err)
      const friendly = /no_stt_config/.test(raw) ? "语音识别还没配置（去设置里填 STT 网关）" : raw
      messages.push({ id: nextId++, role: "error", text: friendly })
      renderMessages()
    }
  })
  try { mediaRecorder.start() } catch {
    stream.getTracks().forEach(t => t.stop())
    reflectMic()
    messages.push({ id: nextId++, role: "error", text: "无法启动录音，请重试" })
    renderMessages()
    return
  }
  recording = true
  recordingStarted = Date.now()
  const updateTime = () => {
    const seconds = Math.floor((Date.now() - recordingStarted) / 1000)
    const clock = document.getElementById("converse-recording-time")
    if (clock) clock.textContent = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`
  }
  updateTime()
  recordingTimer = setInterval(updateTime, 1000)
  reflectMic()
}

// First-visit filler (2026-08-23 UI review #4): the pane used to be one
// placeholder line at the top and 500px of void — an empty screen should
// be an invitation to act. CC's companion vignette + three starters that
// map to things the bot can actually do; clicking one fills the compose
// box (never auto-sends — the send stays the owner's move).
const STARTERS = [
  "今天有什么要跟进的事吗？",
  "说说你最近对我的观察。",
  "陪我随便聊两句。",
]

function emptyStateHtml() {
  return `<div class="converse-empty">
    <img class="converse-empty-art" src="./assets/pet/cc-v1/canonical/lit/front.png" alt="CC" width="190" height="190" />
    <h2>CC 在这儿</h2>
    <p>想说什么都可以。</p>
    <div class="converse-starters">
      ${STARTERS.map(t => `<button class="converse-starter" type="button" data-starter="${escapeHtml(t)}">${escapeHtml(t)}</button>`).join("")}
    </div>
  </div>`
}

function renderMessages() {
  const scroll = document.getElementById("converse-scroll")
  if (!scroll) return
  scroll.innerHTML = messages.length === 0
    ? emptyStateHtml()
    : messages.map(messageHtml).join("")
  requestAnimationFrame(() => { scroll.scrollTop = scroll.scrollHeight })
}

// ── send ───────────────────────────────────────────────────────────────

/** @param {Deps} deps */
async function sendMessage(deps) {
  if (sending || recording || transcribing || requestingMic) return
  const input = /** @type {HTMLTextAreaElement|null} */ (document.getElementById("converse-input"))
  const sendBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById("converse-send"))
  if (!input || !sendBtn) return
  const text = input.value.trim()
  if (!text) return

  messages.push({ id: nextId++, role: "user", text })
  const pendingId = nextId++
  messages.push({ id: pendingId, role: "cc", text: "…", pending: true })
  sending = true
  reflectMic()
  sendBtn.disabled = true
  input.disabled = true
  renderMessages()

  // A turn legitimately takes 1-3 minutes when the owner session cold-starts
  // — a bare "…" for that long reads as "it's broken". Stage the pending
  // copy over time so the wait explains itself.
  const PENDING_STAGES = [
    [8_000, "正在想…"],
    [30_000, "还在想——第一次开口要先热身，可能要一两分钟。"],
    [90_000, "在认真组织语言，再等等我。"],
  ]
  const pendingTimers = PENDING_STAGES.map(([delay, copy]) => setTimeout(() => {
    const m = messages.find(x => x.id === pendingId)
    if (m && m.pending) { m.text = String(copy); renderMessages() }
  }, Number(delay)))

  try {
    const reply = await deps.invoke("agent_converse", { text })
    pendingTimers.forEach(clearTimeout)
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
    pendingTimers.forEach(clearTimeout)
    messages = messages.filter(m => m.id !== pendingId)
    const raw = formatInvokeError(err)
    const friendly = /session_busy/.test(raw)
      ? "CC 正在忙（可能在回微信），稍等再试"
      : /timed out/i.test(raw)
        ? "这轮想得太久，连接先断开了——回复可能已经发到微信；也可以再试一次"
        : raw
    messages.push({ id: nextId++, role: "error", text: friendly })
  } finally {
    sending = false
    reflectMic()
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
    if (ev instanceof KeyboardEvent && ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
      ev.preventDefault()
      sendMessage(deps).catch(err => console.error("converse send failed", err))
    }
  })

  root.querySelector("#converse-voice-toggle")?.addEventListener("click", () => {
    setVoiceOut(!voiceOut)
  })

  root.querySelector("#converse-cancel-recording")?.addEventListener("click", () => {
    if (!recording) return
    discardRecording = true
    mediaRecorder?.stop()
  })

  root.querySelector("#converse-mic")?.addEventListener("click", () => {
    toggleMic(deps).catch(err => console.error("converse mic failed", err))
  })

  // Delegated: bubbles (and their ▶ buttons) are re-created on every
  // renderMessages(), so bind once on the scroll container rather than
  // per-bubble.
  root.querySelector("#converse-scroll")?.addEventListener("click", (ev) => {
    const target = ev.target
    if (!(target instanceof Element)) return
    const starter = target.closest(".converse-starter")
    if (starter instanceof HTMLElement) {
      const input = /** @type {HTMLTextAreaElement|null} */ (document.getElementById("converse-input"))
      if (input) {
        input.value = starter.dataset.starter ?? starter.textContent ?? ""
        input.focus()
        input.dispatchEvent(new Event("input", { bubbles: true }))
      }
      return
    }
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
export function initConversePage(deps, { focus = true } = {}) {
  const root = document.getElementById("converse-root")
  if (!root) return
  if (root.dataset.ready === "true") {
    const input = document.getElementById("converse-input")
    if (focus && input instanceof HTMLElement) input.focus()
    return
  }
  root.dataset.ready = "true"
  renderSkeleton(root)
  wireEvents(root, deps)
  syncVoiceToggleUI()
  renderMessages()
  const input = document.getElementById("converse-input")
  if (focus && input instanceof HTMLElement) input.focus()
}

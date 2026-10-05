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
import { renderWorkbenchMarkdown, renderWorkbenchUserText } from "./workbench-markdown.js"
import { paintConversation, syncConversationLatest, showConversationLatest, conversationInteractionActive } from "./converse-reading.js"

/**
 * @typedef {{ getUserMedia: (c: MediaStreamConstraints) => Promise<MediaStream>, makeRecorder: (s: MediaStream) => MediaRecorder }} MediaDeps
 * @typedef {{ invoke: (cmd: string, args: Record<string, unknown>) => Promise<unknown>, media?: MediaDeps, invokeWorkbenchApi?: (method: 'GET'|'POST', path: string, body?: Record<string, unknown>) => Promise<unknown>, onDelegate?: (draft: import('./task-entry.js').Draft) => Promise<import('./task-entry.js').EntryResult|null>, onSend?: () => void }} Deps
 * @typedef {{ kind: 'voice', text: string } | { kind: 'sticker', label: string, file?: string, image?: string } | { kind: 'file', name: string, ref?: string }} ReplyAttachment
 * @typedef {{ id: number, role: 'user'|'cc'|'error'|'system', text: string, pending?: boolean, at?: number, source?: string, attachments?: ReplyAttachment[], narration?: string[], images?: string[] }} ConverseMsg
 */

// ── module state ───────────────────────────────────────────────────────
// In-memory only — reset on app reload, preserved across pane switches
// (the DOM isn't torn down, just hidden; see initConversePage's
// dataset.ready guard, mirroring dialogue-page.js / a2a-agents.js).
/** @type {ConverseMsg[]} */
let messages = []
let nextId = 1
let sending = false
let delegating = false
// 此刻里拖进 / 粘进来、还没发出去的图(2026-10-05)。url 是本页的 blob 预览,发出去时只带 mime + base64。
/** @type {{ id: number, mime: string, data_b64: string, url: string, name: string }[]} */
let pendingImages = []
let nextImageId = 1
const IMAGE_MIMES = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/heic"]
const IMAGE_MAX = 4
const IMAGE_MAX_BYTES = 10 * 1024 * 1024
// 「此刻」页的气泡要显示 CC 最近一句真话:订阅者每次渲染都拿到当前消息表。
/** @type {Set<(msgs: ConverseMsg[]) => void>} */
const listeners = new Set()

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

/** @param {HTMLElement} root @param {Deps} deps */
function renderSkeleton(root, deps) {
  root.innerHTML = `
    <div id="converse-scroll" class="converse-scroll"></div>
    <button id="converse-latest" class="converse-latest" type="button" hidden>有新回复 · 回到最新</button>
    <div class="converse-compose">
      <div id="converse-images" class="converse-images" aria-label="要一起发的图片" hidden></div>
      <p id="converse-image-note" class="converse-image-note" role="status" hidden></p>
      <textarea id="converse-input" class="converse-textarea" aria-label="消息" placeholder="跟 CC 说点什么…可以拖进或粘贴截图" rows="2"></textarea>
      <div id="converse-recording" class="converse-recording" hidden>
        <button id="converse-cancel-recording" type="button">取消</button>
        <span class="converse-recording-dot" aria-hidden="true"></span>
        <span id="converse-recording-label" role="status">正在听…</span>
        <span id="converse-recording-time">00:00</span>
      </div>
      <div class="converse-toolbar">
        <button id="converse-mic" class="converse-mic" type="button" aria-pressed="false">${icon("mic-01")}<span>语音输入</span></button>
        <button id="converse-voice-toggle" class="converse-voice-toggle" type="button" aria-pressed="false" title="自动朗读 CC 的回复"><span class="converse-switch" aria-hidden="true"></span>朗读回复</button>
        <button id="converse-delegate" class="btn converse-delegate-btn" type="button" disabled${deps.onDelegate ? '' : ' hidden'}>交给 CC 做</button>
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

/**
 * agent_converse 的回包 → 统一的回复对象(回复交付,2026-10-04)。新 Rust 回 `{ reply, attachments, narration }`
 * (文件只带一次性 ref,路径不进网页);老 Rust 回裸字符串。认不得的附件逐条丢掉。
 * @param {unknown} res @returns {{ reply: string, attachments: ReplyAttachment[], narration: string[] }}
 */
export function normalizeConverseReply(res) {
  if (typeof res === "string" || res == null) return { reply: String(res ?? ""), attachments: [], narration: [] }
  const o = /** @type {Record<string, unknown>} */ (res)
  /** @type {ReplyAttachment[]} */
  const attachments = []
  for (const a of Array.isArray(o.attachments) ? o.attachments : []) {
    if (!a || typeof a !== "object") continue
    const x = /** @type {Record<string, unknown>} */ (a)
    if (x.kind === "voice" && typeof x.text === "string") attachments.push({ kind: "voice", text: x.text })
    else if (x.kind === "sticker" && typeof x.label === "string") attachments.push({ kind: "sticker", label: x.label, ...(typeof x.file === "string" ? { file: x.file } : {}), ...(typeof x.image === "string" && x.image.startsWith("data:image/") ? { image: x.image } : {}) })
    else if (x.kind === "file" && typeof x.name === "string") attachments.push({ kind: "file", name: x.name, ...(typeof x.ref === "string" ? { ref: x.ref } : {}) })
  }
  const narration = (Array.isArray(o.narration) ? o.narration : []).filter(n => typeof n === "string" && n.trim() !== "").map(String)
  return { reply: typeof o.reply === "string" ? o.reply : "", attachments, narration }
}

/**
 * 过程:最后的话之前 CC 写下的过程话。灰、默认收起;说清它没发到微信(不假装它是回复)。
 * @param {ConverseMsg} m
 */
function narrationHtml(m) {
  const lines = m.narration ?? []
  if (!lines.length) return ""
  return `<details class="converse-process" data-msg-id="${m.id}">
    <summary title="CC 在最后回复之前写下的过程话,只在这里显示,没有发到微信">过程 · ${lines.length} 段</summary>
    <ol class="converse-process-lines">${lines.map(l => `<li>${escapeHtml(l)}</li>`).join("")}</ol>
  </details>`
}

/**
 * 附件:语音(点了才合成、播放)、表情(本地表情是一张图;联网表情 daemon 不替你取图,只写情绪)、
 * 文件(名字 + 在访达中显示 —— 只显示不打开,打开附件可能直接运行程序)。
 * @param {ConverseMsg} m
 */
function attachmentsHtml(m) {
  const list = m.attachments ?? []
  if (!list.length) return ""
  const items = list.map((a, i) => {
    if (a.kind === "voice") {
      return `<div class="converse-att converse-att-voice">
        <button class="converse-att-play" type="button" data-msg-id="${m.id}" data-att="${i}" aria-label="播放语音">${icon("play")}<span>语音</span></button>
        <span class="converse-att-text">${escapeHtml(a.text)}</span>
      </div>`
    }
    if (a.kind === "sticker") {
      return a.image
        ? `<img class="converse-att-sticker" src="${escapeHtml(a.image)}" alt="表情:${escapeHtml(a.label)}" title="${escapeHtml(a.label)}" />`
        : `<div class="converse-att converse-att-sticker-label">${icon("smile")}<span>表情 · ${escapeHtml(a.label)}</span></div>`
    }
    return `<div class="converse-att converse-att-file">
      ${icon("attachment")}<span class="converse-att-name">${escapeHtml(a.name)}</span>
      ${a.ref ? `<button class="converse-att-reveal" type="button" data-file-ref="${escapeHtml(a.ref)}">在访达中显示</button>` : ""}
    </div>`
  })
  return `<div class="converse-attachments">${items.join("")}</div>`
}

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
  const markdown = m.role === "cc" && !m.pending
  const bubble = `<div class="converse-bubble${markdown ? ' cc-readable-markdown wb-markdown' : m.role==='user' ? ' cc-user-bubble' : ''}">${markdown ? renderWorkbenchMarkdown(m.text) : m.role==='user' ? renderWorkbenchUserText(m.text,`converse:${m.id}`) : escapeHtml(m.text)}</div>`
  // 主人发的图:缩略图跟在自己那条气泡上(只是本页的预览,刷新后历史里是「[图片 ×N]」)。
  const userImages = m.role === "user" && m.images?.length
    ? `<div class="converse-user-images">${m.images.map(src => `<img src="${escapeHtml(src)}" alt="你发的图片" />`).join("")}</div>`
    : ""
  const extras = m.role === "cc" && ((m.attachments?.length ?? 0) > 0 || (m.narration?.length ?? 0) > 0)
  // 带附件 / 过程的回复:过程在上、回复居中、附件在下,一列排;没有的照旧(样式与测试不动)。
  // 朗读按钮永远贴着正文最后一行(带附件时放进正文那一行里),不随附件块漂。
  const body = extras
    ? `<div class="converse-cc-body">${narrationHtml(m)}${m.text.trim() ? `<div class="converse-cc-line">${bubble}${replayBtn}</div>` : ""}${attachmentsHtml(m)}</div>`
    : bubble
  return `<div class="converse-msg ${roleCls}${pendingCls}">
    ${m.role === "cc" ? '<img class="converse-avatar" src="./assets/pet/cc-v1/canonical/lit/front.png" alt="CC" width="32" height="32" />' : ""}
    ${userImages ? `<div class="converse-user-body">${userImages}${m.text.trim() ? body : ""}</div>` : body}
    ${extras || !m.text.trim() ? "" : replayBtn}
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
  btn.toggleAttribute("disabled", transcribing || requestingMic || sending || delegating)
  const panel = document.getElementById("converse-recording")
  if (panel) panel.hidden = !busy
  const label = document.getElementById("converse-recording-label")
  if (label) label.textContent = transcribing ? "正在转成文字…" : requestingMic ? "等待麦克风权限…" : "正在听…"
  const cancel = document.getElementById("converse-cancel-recording")
  if (cancel) cancel.hidden = !recording
  const hint = document.getElementById("converse-recording-hint")
  if (hint) hint.hidden = !busy
  const input = /** @type {HTMLTextAreaElement|null} */ (document.getElementById("converse-input"))
  if (input) input.hidden = busy
  const send = document.getElementById("converse-send")
  if (send) send.toggleAttribute("disabled", busy || sending || delegating)
  const delegate = document.getElementById("converse-delegate")
  if (delegate) delegate.toggleAttribute("disabled", busy || sending || delegating || !input?.value.trim())
}

/** 等系统麦克风授权的上限:系统弹框等人点,给足时间;超时就说清楚去哪儿看。 */
const MIC_REQUEST_TIMEOUT_MS = 30_000
const MIC_SETTINGS_PATH = "系统设置 › 隐私与安全性 › 麦克风"

/**
 * 麦克风拿不到时给主人的一句话 —— 按 getUserMedia 的错误名分开说,每句都能照做。
 * @param {unknown} err
 */
export function micFailureText(err) {
  const name = err && typeof err === "object" && "name" in err ? String(/** @type {{name: unknown}} */ (err).name) : ""
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") {
    return `麦克风权限没开:去 ${MIC_SETTINGS_PATH},打开 wechat-cc,再点一次「语音输入」。`
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") {
    return "没找到可用的麦克风:接上麦克风,或在系统设置 › 声音 › 输入里选一个设备后再试。"
  }
  if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError") {
    return "麦克风被别的应用占着或暂时打不开,关掉占用它的应用后再试。"
  }
  if (name === "MicTimeout") {
    return `一直没拿到麦克风:看看屏幕上有没有系统的授权弹框;没有的话去 ${MIC_SETTINGS_PATH},打开 wechat-cc。`
  }
  if (name === "MicUnsupported") {
    return "这个版本的桌面 app 用不了麦克风,更新到最新版后再试。"
  }
  return `麦克风用不了:去 ${MIC_SETTINGS_PATH} 看看 wechat-cc 是否已打开,或检查输入设备。`
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
  if (transcribing || requestingMic || sending || delegating) return
  if (recording) { try { mediaRecorder?.stop() } catch { /* already stopped */ } return }

  const md = deps.media ?? {
    getUserMedia: (c) => {
      if (!navigator.mediaDevices?.getUserMedia) return Promise.reject(Object.assign(new Error("no mediaDevices"), { name: "MicUnsupported" }))
      return navigator.mediaDevices.getUserMedia(c)
    },
    makeRecorder: (s) => new MediaRecorder(s),
  }
  let stream
  requestingMic = true
  reflectMic()
  // 2026-10-04:签名 + hardened runtime 的包缺麦克风 entitlement / 用途说明时,系统会
  // 静默拒绝 —— 以前这里只推一条很淡的 system 小字,主人看到的是「点了没反应」。
  // 现在:拒绝/没设备/被占用各说一句能照做的话(error 级,醒目);迟迟没有回应也不
  // 无限转圈,超时就告诉主人去哪儿看。
  let micTimer
  const request = Promise.resolve().then(() => md.getUserMedia({ audio: true }))
  try {
    stream = await Promise.race([
      request,
      new Promise((_, reject) => { micTimer = setTimeout(() => reject(Object.assign(new Error("mic timeout"), { name: "MicTimeout" })), MIC_REQUEST_TIMEOUT_MS) }),
    ])
  } catch (err) {
    // 超时之后系统才放行的话,别让麦克风一直开着。
    if (/** @type {{name?: string}} */ (err)?.name === "MicTimeout") request.then(s => s.getTracks().forEach(t => t.stop()), () => {})
    requestingMic = false
    reflectMic()
    messages.push({ id: nextId++, role: "error", text: micFailureText(err) })
    renderMessages()
    return
  } finally {
    clearTimeout(micTimer)
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
        reflectMic()
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

// 「一件事」:微信 / 手机 / 桌面三处跟 CC 说的话是同一条流。首次打开时把主人那条对话
// 最近的记录拉进来(GET /v1/matter/owner-chat),这样在微信或手机上聊过的,桌面也看得到。
// 只在还没有任何本地消息时填充;拉不到就保持空白,不打断本地对话。
/** @param {Deps} deps */
async function loadSharedHistory(deps) {
  if (!deps.invokeWorkbenchApi || messages.length) return
  try {
    const detail = /** @type {{events?:Array<{kind:string,text:string,createdAt:number,source?:string}>}|null} */ (await deps.invokeWorkbenchApi("GET", "/v1/matter/owner-chat"))
    const events = (detail?.events ?? []).filter(e => e.kind === "user" || e.kind === "text")
    if (!events.length || messages.length) return
    for (const e of events) messages.push({ id: nextId++, role: e.kind === "user" ? "user" : "cc", text: e.text, at: e.createdAt, source: e.source })
    renderMessages()
  } catch { /* 没有登记处或读不到:桌面照旧从空白开始 */ }
}

function renderMessages({ follow = false } = {}) {
  const scroll = document.getElementById("converse-scroll")
  if (scroll) {
    paintConversation(scroll,messages,messageHtml,emptyStateHtml(),{follow,latest:/** @type {HTMLButtonElement|null} */(document.getElementById("converse-latest"))})
  }
  for (const cb of listeners) {
    try { cb(messages) } catch (err) { console.error("converse subscriber threw", err) }
  }
}

/** 订阅消息表;订阅即回放当前。 @param {(msgs: ConverseMsg[]) => void} cb @returns {() => void} */
export function subscribeConverse(cb) {
  listeners.add(cb)
  cb(messages)
  return () => { listeners.delete(cb) }
}

/** home 只露输入框与发送;chat 是完整对话。 @param {'home'|'chat'} mode */
export function setConverseMode(mode) {
  const root = document.getElementById("converse-root")
  if (root) root.dataset.converseMode = mode
}

// ── send ───────────────────────────────────────────────────────────────

/** @param {Deps} deps */
async function sendMessage(deps) {
  if (sending || delegating || recording || transcribing || requestingMic) return
  const input = /** @type {HTMLTextAreaElement|null} */ (document.getElementById("converse-input"))
  const sendBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById("converse-send"))
  if (!input || !sendBtn) return
  const text = input.value.trim()
  const images = pendingImages
  if (!text && !images.length) return
  deps.onSend?.()

  messages.push({ id: nextId++, role: "user", text, at: Date.now(), ...(images.length ? { images: images.map(i => i.url) } : {}) })
  pendingImages = []
  renderPendingImages()
  const pendingId = nextId++
  messages.push({ id: pendingId, role: "cc", text: "…", pending: true })
  sending = true
  reflectMic()
  sendBtn.disabled = true
  input.disabled = true
  renderMessages({ follow: true })

  // A turn legitimately takes 1-3 minutes when the owner session cold-starts
  // — a bare "…" for that long reads as "it's broken". Stage the pending
  // copy over time so the wait explains itself.
  const PENDING_STAGES = [
    [8_000, "还在等待 CC 的回复…"],
    [30_000, "还没收到回复，你可以先查看上面的内容。"],
    [90_000, "这次等待较久，收到回复后会显示在这里。"],
  ]
  const pendingTimers = PENDING_STAGES.map(([delay, copy]) => setTimeout(() => {
    const m = messages.find(x => x.id === pendingId)
    if (m && m.pending) { m.text = String(copy); renderMessages() }
  }, Number(delay)))

  try {
    const res = normalizeConverseReply(await deps.invoke("agent_converse", images.length ? { text, images: images.map(({ mime, data_b64 }) => ({ mime, data_b64 })) } : { text }))
    pendingTimers.forEach(clearTimeout)
    messages = messages.filter(m => m.id !== pendingId)
    const replyText = res.reply
    const extras = { ...(res.attachments.length ? { attachments: res.attachments } : {}), ...(res.narration.length ? { narration: res.narration } : {}) }
    if (replyText.trim() === "") {
      // 只有附件(一张表情、一段语音)也是回复:照常画 CC 那一行,只是没有文字气泡。
      // 什么都没有(或只有过程话)⇒ 灰色一句说明,过程照样能展开看。
      if (res.attachments.length) messages.push({ id: nextId++, role: "cc", text: "", at: Date.now(), ...extras })
      else {
        if (res.narration.length) messages.push({ id: nextId++, role: "cc", text: "", at: Date.now(), narration: res.narration })
        messages.push({ id: nextId++, role: "system", text: "（CC 这轮没有用文字回复）" })
      }
    } else {
      messages.push({ id: nextId++, role: "cc", text: replyText, at: Date.now(), ...extras })
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
    // 没发出去:图放回输入框上方,和文字一样不丢,直接再点发送就行。
    if (images.length && !pendingImages.length) { pendingImages = images; renderPendingImages() }
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
    const scroll=document.getElementById("converse-scroll")
    const focused=document.activeElement
    if((!focused || focused===input || focused===document.body) && (!scroll || !conversationInteractionActive(scroll)))input.focus()
  }
}

// ── images (2026-10-05) ────────────────────────────────────────────────

/** @param {string} text */
function imageNote(text) {
  const note = document.getElementById("converse-image-note")
  if (!note) return
  note.textContent = text
  note.hidden = !text
}

function renderPendingImages() {
  const host = document.getElementById("converse-images")
  if (!host) return
  host.hidden = pendingImages.length === 0
  host.innerHTML = pendingImages.map(img => `<span class="converse-image-chip"><img src="${escapeHtml(img.url)}" alt="${escapeHtml(img.name)}" /><button type="button" data-remove-image="${img.id}" aria-label="移除这张图片">×</button></span>`).join("")
}

/** 读进来的文件里挑图片,超过张数 / 大小 / 格式的说一句,不悄悄丢。
 * @param {FileList|File[]|null|undefined} files @returns {Promise<boolean>} 有没有收下至少一张 */
export async function addImages(files) {
  const list = Array.from(files ?? [])
  if (!list.length) return false
  let skipped = ""
  let added = 0
  for (const file of list) {
    if (!IMAGE_MIMES.includes(file.type)) { skipped = "只支持 PNG、JPEG、WebP、GIF、HEIC 图片"; continue }
    if (file.size > IMAGE_MAX_BYTES) { skipped = "单张图片不能超过 10MB"; continue }
    if (pendingImages.length >= IMAGE_MAX) { skipped = `一次最多 ${IMAGE_MAX} 张`; break }
    const data_b64 = await new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""))
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(file)
    })
    pendingImages.push({ id: nextImageId++, mime: file.type, data_b64: String(data_b64), url: URL.createObjectURL(file), name: file.name || "截图" })
    added++
  }
  imageNote(skipped)
  renderPendingImages()
  return added > 0
}

// ── event wiring ───────────────────────────────────────────────────────

/** Offer visible public discussion as unchecked preview candidates.
 * @param {Deps} deps */
async function delegateDraft(deps) {
  if (!deps.onDelegate || sending || delegating || recording || transcribing || requestingMic) return
  const input = /** @type {HTMLTextAreaElement|null} */ (document.getElementById("converse-input"))
  if (!input?.value.trim()) return
  const draft = input.value
  delegating = true
  input.disabled = true
  reflectMic()
  let accepted = false
  try {
    const result = await deps.onDelegate({text: draft, visibleMessages: messages.flatMap(message => (message.role === 'user' || message.role === 'cc') && !message.pending && message.text.trim() ? [{role: message.role, text: message.text}] : [])})
    accepted = !!result
    if (accepted && input.value === draft) input.value = ""
  } catch {
    messages.push({ id: nextId++, role: "system", text: "暂时无法交给 CC 做，要求已保留，请稍后再试。" })
    renderMessages()
  } finally {
    delegating = false
    input.disabled = false
    reflectMic()
    if (!accepted) input.focus()
  }
}

/** @param {HTMLElement} root @param {Deps} deps */
function wireEvents(root, deps) {
  const scroll=root.querySelector("#converse-scroll")
  const latest=/** @type {HTMLButtonElement|null} */(root.querySelector("#converse-latest"))
  if(scroll instanceof HTMLElement){
    scroll.addEventListener("scroll",()=>syncConversationLatest(scroll,latest),{passive:true})
    latest?.addEventListener("click",()=>showConversationLatest(scroll,latest))
  }
  root.querySelector("#converse-delegate")?.addEventListener("click", () => { void delegateDraft(deps) })
  root.querySelector("#converse-send")?.addEventListener("click", () => {
    sendMessage(deps).catch(err => console.error("converse send failed", err))
  })

  const input = /** @type {HTMLTextAreaElement|null} */ (root.querySelector("#converse-input"))
  input?.addEventListener("input", reflectMic)
  input?.addEventListener("keydown", (ev) => {
    if (ev instanceof KeyboardEvent && ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
      ev.preventDefault()
      sendMessage(deps).catch(err => console.error("converse send failed", err))
    }
  })

  // 截图:粘贴(⌘V)或拖进对话区都收;只拦图片,文字照常粘。
  input?.addEventListener("paste", (ev) => {
    const files = /** @type {ClipboardEvent} */ (ev).clipboardData?.files
    if (!files?.length || ![...files].some(f => f.type.startsWith("image/"))) return
    ev.preventDefault()
    void addImages(files).then(() => input.focus())
  })
  root.addEventListener("dragover", (ev) => {
    const types = /** @type {DragEvent} */ (ev).dataTransfer?.types
    if (types && [...types].includes("Files")) { ev.preventDefault(); root.classList.add("is-dragover") }
  })
  root.addEventListener("dragleave", (ev) => { if (ev.target === root) root.classList.remove("is-dragover") })
  root.addEventListener("drop", (ev) => {
    const files = /** @type {DragEvent} */ (ev).dataTransfer?.files
    root.classList.remove("is-dragover")
    if (!files?.length) return
    ev.preventDefault()
    void addImages(files).then(added => { if (added) input?.focus() })
  })
  root.querySelector("#converse-images")?.addEventListener("click", (ev) => {
    const btn = /** @type {HTMLElement} */ (ev.target).closest("[data-remove-image]")
    if (!(btn instanceof HTMLElement)) return
    const id = Number(btn.dataset.removeImage)
    const gone = pendingImages.find(i => i.id === id)
    if (gone) URL.revokeObjectURL(gone.url)
    pendingImages = pendingImages.filter(i => i.id !== id)
    imageNote("")
    renderPendingImages()
    input?.focus()
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

  // Delegated so appended and updated replies share one handler.
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
    const play = target.closest(".converse-att-play")
    if (play instanceof HTMLElement) {
      const msg = messages.find(m => m.id === Number(play.dataset.msgId))
      const att = msg?.attachments?.[Number(play.dataset.att)]
      if (att?.kind === "voice") speakAndPlay(deps, att.text).catch(() => {})
      return
    }
    const reveal = target.closest(".converse-att-reveal")
    if (reveal instanceof HTMLElement) {
      const ref = reveal.dataset.fileRef ?? ""
      Promise.resolve(deps.invoke("reveal_reply_file", { token: ref })).catch(err => {
        const raw = formatInvokeError(err)
        messages.push({ id: nextId++, role: "system", text: /reply_file_missing/.test(raw) ? "这个文件已经不在原来的位置了" : /reply_file_unknown/.test(raw) ? "重新打开应用后找不到这个文件了,可以在微信或文件夹里找" : "暂时无法在访达中显示" })
        renderMessages()
      })
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
  renderSkeleton(root, deps)
  wireEvents(root, deps)
  syncVoiceToggleUI()
  reflectMic()
  renderMessages()
  void loadSharedHistory(deps)
  const input = document.getElementById("converse-input")
  if (focus && input instanceof HTMLElement) input.focus()
}

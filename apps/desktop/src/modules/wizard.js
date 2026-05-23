// @ts-check
/// <reference lib="dom" />
// Setup-page renderer — single page, no step navigation.
//
// Owns:
//   .agent-card * (cards + state + meta)
//   #scan-bind (gated on ≥1 agent installed)
//   #wsl-tip (folded; shown only if doctor reports WSL)
//   #wizard-foot-dot / #wizard-foot-text (status pill)
//   #install-strip + #setup-error (transient UI states for the
//                                  install→scan flow)

import { daemonStatusLine } from "../view.js"

// Track whether the scan button was disabled on the previous render so we
// can flash it once when an agent first becomes available — gives the user
// a visual cue that the page just unlocked after they installed an agent
// in another terminal. Defaults to `true` so the very first paint of the
// page (which always starts with the button disabled in HTML) is treated
// as a no-op transition.
let scanWasDisabled = true

/** @typedef {{ ok?: boolean, path?: string | null, version?: string | null }} CheckLike */
/**
 * Cursor's doctor probe doesn't use {ok, path, version} — it surfaces
 * apiKeySet + sdkInstalled separately so the card can tell users
 * exactly which leg is missing (env var vs npm install).
 * @typedef {{ ok?: boolean, apiKeySet?: boolean, sdkInstalled?: boolean }} CursorCheckLike
 */
/** @typedef {{ wslDetected?: boolean, checks?: { claude?: CheckLike, codex?: CheckLike, cursor?: CursorCheckLike, daemon?: unknown } }} DoctorReport */

/** @param {DoctorReport} report */
export function renderSetupPage(report) {
  renderAgentCards(report)
  renderWslTip(report)
  refreshScanButton(report)
  updateFooterStatus(report.checks?.daemon)
}

/** @param {DoctorReport} report */
function renderAgentCards(report) {
  // claude / codex use the binary-on-PATH probe shape {ok, path, version}
  for (const provider of /** @type {const} */ (["claude", "codex"])) {
    const check = report.checks?.[provider]
    const card = document.getElementById(`agent-card-${provider}`)
    const state = document.getElementById(`agent-state-${provider}`)
    const meta = document.getElementById(`${provider}-meta`)
    const installLink = /** @type {HTMLElement | null} */ (card?.querySelector(".install-link") ?? null)
    if (!card || !state || !meta) continue
    const installed = !!check?.ok
    card.classList.toggle("installed", installed)
    card.classList.toggle("missing", !installed)
    state.textContent = installed ? "✓ 已安装" : "✗ 未安装"
    meta.textContent = installed ? (check?.path || "已检测到") : "未在 PATH 上"
    if (installLink) installLink.hidden = installed
  }
  // cursor uses the SDK + API-key probe shape — meta reports which leg is missing
  renderCursorCard(report.checks?.cursor)
}

/** @param {CursorCheckLike | undefined} check */
function renderCursorCard(check) {
  const card = document.getElementById("agent-card-cursor")
  const state = document.getElementById("agent-state-cursor")
  const meta = document.getElementById("cursor-meta")
  const installLink = /** @type {HTMLElement | null} */ (card?.querySelector(".install-link") ?? null)
  if (!card || !state || !meta) return
  const installed = !!check?.ok
  card.classList.toggle("installed", installed)
  card.classList.toggle("missing", !installed)
  state.textContent = installed ? "✓ 已就绪" : "✗ 未就绪"
  if (installed) {
    meta.textContent = "SDK + API key 就绪"
  } else if (check?.sdkInstalled && !check?.apiKeySet) {
    meta.textContent = "缺少 CURSOR_API_KEY（设到 shell / systemd 环境）"
  } else if (!check?.sdkInstalled && check?.apiKeySet) {
    meta.textContent = "缺少 @cursor/sdk（运行 bun add @cursor/sdk）"
  } else {
    meta.textContent = "未配置 — 需要 @cursor/sdk + CURSOR_API_KEY"
  }
  // Install link hidden only when fully ready; useful any time SDK isn't
  // installed (the link points at Cursor SDK docs, which cover both steps).
  if (installLink) installLink.hidden = installed
}

/** @param {DoctorReport} report */
function renderWslTip(report) {
  const tip = /** @type {HTMLElement | null} */ (document.getElementById("wsl-tip"))
  if (!tip) return
  tip.hidden = !report.wslDetected
}

/** @param {DoctorReport} report */
export function refreshScanButton(report) {
  const btn = /** @type {HTMLButtonElement | null} */ (document.getElementById("scan-bind"))
  if (!btn) return
  const claudeOk = !!report.checks?.claude?.ok
  const codexOk = !!report.checks?.codex?.ok
  const cursorOk = !!report.checks?.cursor?.ok
  const anyAgent = claudeOk || codexOk || cursorOk
  btn.disabled = !anyAgent
  if (anyAgent) btn.removeAttribute("title")
  else btn.title = "先装一个 agent · 本页会自动检测"

  // Inline hint sits below the button; visible only while disabled.
  const hint = document.getElementById("scan-hint")
  if (hint) hint.hidden = anyAgent

  // Disabled → enabled transition: flash the button once. Restart the
  // animation by toggling the class with a reflow in between.
  if (scanWasDisabled && anyAgent) {
    btn.classList.remove("flash")
    void btn.offsetWidth
    btn.classList.add("flash")
  }
  scanWasDisabled = !anyAgent
}

/** @param {unknown} daemon */
export function updateFooterStatus(daemon) {
  const line = daemonStatusLine(daemon)
  for (const id of ["wizard-foot-dot", "dash-rail-dot"]) {
    const el = document.getElementById(id)
    if (el) el.className = `dot ${line.cls}`
  }
  for (const id of ["wizard-foot-text", "dash-rail-text"]) {
    const el = document.getElementById(id)
    if (el) el.textContent = line.text
  }
}

// Setup error strip + install progress strip — transient UI used by
// the scan-bind flow (handleScanClick in main.js).

/**
 * @param {string} message
 * @param {string | null | undefined} details
 */
export function showSetupError(message, details) {
  const strip = /** @type {HTMLElement | null} */ (document.getElementById("setup-error"))
  const msgEl = document.getElementById("setup-error-msg")
  const bodyEl = /** @type {HTMLElement | null} */ (document.getElementById("setup-error-details-body"))
  if (!strip || !msgEl) return
  msgEl.textContent = message
  if (bodyEl) {
    bodyEl.textContent = details || ""
    bodyEl.hidden = true
  }
  strip.hidden = false
}

export function clearSetupError() {
  const strip = /** @type {HTMLElement | null} */ (document.getElementById("setup-error"))
  if (strip) strip.hidden = true
}

/** @param {string} [label] */
export function showInstallStrip(label) {
  const strip = /** @type {HTMLElement | null} */ (document.getElementById("install-strip"))
  const labelEl = document.getElementById("install-strip-label")
  if (!strip) return
  if (labelEl && label) labelEl.textContent = label
  strip.hidden = false
}

export function hideInstallStrip() {
  const strip = /** @type {HTMLElement | null} */ (document.getElementById("install-strip"))
  if (strip) strip.hidden = true
}

// @ts-check
/// <reference lib="dom" />
/** @typedef {import('../../../../src/cli/schema').SetupQrJsonOutputT} SetupQrJson */
/** @typedef {import('../../../../src/cli/schema').SetupPollOutputT} SetupPoll */
/**
 * @typedef {{ invoke: (cmd: string, args: Record<string, unknown>) => Promise<unknown>, mock: boolean }} Deps
 * @typedef {{ setup: SetupQrJson | null, currentBaseUrl: string | null, qrTimer: ReturnType<typeof setInterval> | null, qrErrors: number }} QrState
 */

// QR / setup-poll module. Owns the wizard's bind-WeChat screen lifecycle:
// fetch a QR payload via `setup --qr-json`, render it via the qrcode_svg
// command (or the test-shim's placeholder), poll setup-poll every 2s
// until confirmed/expired, then swap the QR for a checkmark + accountId.
//
// Owns: #qr-box, #qr-title, #qr-message, #qr-poll, #qr-ttl, #qr-raw,
//       #continue-service, #qr-refresh
// Reads from / writes to a passed-in `state` bag for setup + qrTimer +
// currentBaseUrl + qrErrors so main.js can clear it on mode switch.

import { pollAdvance, escapeHtml } from "../view.js"

const POLL_INTERVAL_MS = 2000
const MAX_POLL_ERRORS = 5
/** @type {WeakMap<QrState,{generation:number,polling:boolean}>} */
const lifecycles = new WeakMap()
/** @param {QrState} state */
function lifecycle(state) {
  let current = lifecycles.get(state)
  if (!current) { current = {generation:0,polling:false}; lifecycles.set(state,current) }
  return current
}
/** Invalidate pending setup/poll/render work when leaving or replacing a scan.
 * @param {QrState} state */
export function stopQr(state) {
  if (state.qrTimer != null) clearInterval(state.qrTimer)
  state.qrTimer = null; state.setup = null; state.currentBaseUrl = null; state.qrErrors = 0
  const current = lifecycle(state); current.generation++; current.polling = false
}
/** @param {string} title @param {string} message */
function scanStatus(title, message) {
  const titleEl = document.getElementById('qr-title'), messageEl = document.getElementById('qr-message'), poll = document.getElementById('qr-poll')
  if (titleEl) titleEl.textContent = title
  if (messageEl) messageEl.textContent = message
  if (poll) poll.hidden = !message
}

/**
 * @param {Deps} deps
 * @param {QrState} state
 */
export async function refreshQr(deps, state) {
  stopQr(state)
  const current = lifecycle(state), generation = current.generation
  const active = () => current.generation === generation
  sessionStorage.removeItem("qrPollCount")
  const qrBox = document.getElementById('qr-box')
  const ttlEl = document.getElementById("qr-ttl")
  const rawEl = document.getElementById("qr-raw")
  const rawToggle = document.getElementById('qr-raw-toggle')
  const continueBtn = /** @type {HTMLButtonElement | null} */ (document.getElementById("continue-service"))
  const refreshBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById('qr-refresh'))
  if (continueBtn) continueBtn.disabled = true
  if (refreshBtn) refreshBtn.disabled = true
  if (qrBox) { qrBox.hidden = false; qrBox.textContent = '正在生成…' }
  if (ttlEl) ttlEl.textContent = ''
  if (rawEl) { rawEl.textContent = ''; rawEl.hidden = true; rawEl.classList.remove('show') }
  if (rawToggle) { rawToggle.hidden = false; rawToggle.setAttribute('aria-expanded','false') }
  scanStatus('正在准备二维码', '')
  try {
    const qr = /** @type {SetupQrJson} */ (await deps.invoke('wechat_cli_json', {args:['setup','--qr-json']}))
    if (!active()) return
    if (!qr.qrcode || !qr.qrcode_img_content) throw Error('invalid_qr')
    // Render into a detached host; an old SVG response must not overwrite a newer scan.
    const box = document.createElement('div')
    await renderQrInto(deps, box, qr.qrcode_img_content)
    if (!active()) return
    state.setup = qr
    if (qrBox) qrBox.innerHTML = box.innerHTML
    scanStatus('用微信扫一扫', '扫描后，在手机上确认连接。')
    if (ttlEl) ttlEl.textContent = qr.expires_in_ms ? `${Math.floor(qr.expires_in_ms / 1000)} 秒内有效` : ''
    if (rawEl) rawEl.textContent = JSON.stringify(qr, null, 2)
    state.qrTimer = setInterval(() => { void pollQr(deps,state,generation) }, POLL_INTERVAL_MS)
  } catch (error) {
    if (!active()) return
    if (qrBox) { qrBox.textContent = ''; qrBox.hidden = true }
    scanStatus('二维码没能生成', '请点「刷新二维码」重试。')
    if (rawEl) rawEl.textContent = String(error)
  } finally { if (active() && refreshBtn) refreshBtn.disabled = false }
}

/**
 * @param {Deps} deps
 * @param {HTMLElement} box
 * @param {string} text
 */
async function renderQrInto(deps, box, text) {
  if (deps.mock) {
    box.innerHTML = `<div class="mock-qr" aria-label="${escapeHtml(text)}"><span></span></div>`
    return
  }
  const svg = /** @type {string} */ (await deps.invoke("render_qr_svg", { text }))
  box.innerHTML = svg
}

/**
 * @param {Deps} deps
 * @param {QrState} state @param {number} generation
 */
async function pollQr(deps, state, generation) {
  const current = lifecycle(state)
  if (!state.setup || current.generation !== generation || current.polling) return
  current.polling = true
  const args = ["setup-poll", "--qrcode", state.setup.qrcode, "--json"]
  if (state.currentBaseUrl) args.splice(3, 0, "--base-url", state.currentBaseUrl)
  let result
  try {
    result = /** @type {SetupPoll} */ (await deps.invoke("wechat_cli_json", { args }))
    if (current.generation !== generation) return
    state.qrErrors = 0
  } catch (err) {
    if (current.generation !== generation) return
    state.qrErrors = (state.qrErrors || 0) + 1
    const rawEl = document.getElementById("qr-raw")
    if (rawEl) rawEl.textContent = `轮询失败 (${state.qrErrors}/${MAX_POLL_ERRORS}):\n${err}`
    if (state.qrErrors >= MAX_POLL_ERRORS) {
      if (state.qrTimer != null) clearInterval(state.qrTimer)
      state.qrTimer = null
      scanStatus('连接暂时中断', '请点「刷新二维码」重试。')
    }
    return
  } finally { if (current.generation === generation) current.polling = false }
  const rawEl2 = document.getElementById("qr-raw")
  if (rawEl2) rawEl2.textContent = JSON.stringify(result, null, 2)
  const advance = pollAdvance(state, result)
  if (advance.stopTimer) {
    if (state.qrTimer != null) clearInterval(state.qrTimer)
    state.qrTimer = null
  }
  if (advance.currentBaseUrl !== undefined) state.currentBaseUrl = advance.currentBaseUrl
  if (advance.qrTitle !== undefined) { const el = document.getElementById("qr-title"); if (el) el.textContent = advance.qrTitle }
  if (advance.qrMessage !== undefined) { const el = document.getElementById("qr-message"); if (el) el.textContent = advance.qrMessage }
  const poll = document.getElementById('qr-poll')
  if (poll) poll.hidden = !document.getElementById('qr-message')?.textContent
  if (advance.continueEnabled !== undefined) {
    const btn = /** @type {HTMLButtonElement | null} */ (document.getElementById("continue-service"))
    if (btn) btn.disabled = !advance.continueEnabled
  }
  // After confirmed binding, hide the QR + TTL — leaving the code on screen
  // is confusing (user already scanned, the code is now invalid) and the
  // primary CTA in the header ("继续") tells them what to do next.
  if (result.status === "confirmed") {
    const box = document.getElementById("qr-box")
    if (box) { box.innerHTML = ''; box.hidden = true }
    const ttl = document.getElementById("qr-ttl")
    if (ttl) ttl.textContent = ''
  }
}

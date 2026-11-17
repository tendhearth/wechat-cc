// @ts-check
/// <reference lib="dom" />
/** Desktop-only setup. All provider labels, commands and availability come from daemon. */
import { V1, v1 } from '../daemon-client.js'
import { escapeHtml } from '../view.js'

/** @typedef {{id:string,label:string,installed:boolean,canInstall:boolean,canLogin:boolean,website:string,free:boolean,commands:string[],runtimeSupported?:boolean,supportNote?:string}} SetupProvider */
/** @typedef {{ok:boolean,allowed:boolean,blockedReason:string,providers:SetupProvider[]}} SetupSnapshot */
/** @type {{provider:string, seq:number, snapshot:SetupSnapshot|null, busy:boolean, deadline:number, message:string, recheck:boolean}|null} */
let active = null
let serial = 0
/** @type {ReturnType<typeof setTimeout>|undefined} */
let pollTimer
/** @type {ReturnType<typeof setTimeout>|undefined} */
let deadlineTimer
const INTERVAL = 10_000
const TIMEOUT = 5 * 60_000

export function closeCliSetup() {
  serial++
  active = null
  clearTimeout(pollTimer)
  clearTimeout(deadlineTimer)
}
/** @param {number} seq */
function current(seq) { return active?.seq === seq && !!document.getElementById('brain-setup') }
/** @param {any} deps */
function transport(deps) { return deps.invokeWorkbenchApi ?? deps.invokeApi }
/** @param {any} deps @returns {Promise<SetupSnapshot>} */
async function snapshot(deps) {
  const r = await v1(transport(deps), V1.llm.setup)
  if (!r?.ok || !Array.isArray(r.providers)) throw new Error('setup_unavailable')
  return r
}
/** @param {string} [message] @param {boolean} [recheck] */
function render(message, recheck) {
  const box = document.getElementById('brain-setup'), a = active
  if (!box || !a?.snapshot) return
  if (message !== undefined) a.message = message
  if (recheck !== undefined) a.recheck = recheck
  message = a.message
  recheck = a.recheck
  const r = a.snapshot, p = r.providers.find(p => p.id === a.provider)
  if (!p) { box.textContent = '当前版本还不支持这个接入，请更新 CC。'; return }
  const action = p.installed ? 'login' : 'install'
  const canRun = p.installed ? p.canLogin : p.canInstall
  box.innerHTML = `<div class="brain-setup-title">接入 ${escapeHtml(p.label)}${p.free ? ' <small>免费可用 · 额度有限</small>' : ''}</div>
    <div class="brain-setup-note">${p.runtimeSupported === false ? escapeHtml(p.supportNote || '当前平台暂不能接入。') : '会打开看得见的终端窗口。请在浏览器完成账号授权，CC 会自动检测接入。'}</div>
    ${canRun ? `<button class="brain-recheck" type="button" data-cli-action="${action}" data-provider="${escapeHtml(p.id)}" ${!r.allowed || a.busy ? 'disabled' : ''}>${p.installed ? '登录' : '安装并登录'}</button>` : ''}
    ${!p.canInstall || !canRun ? `<button class="brain-recheck brain-quiet" type="button" data-cli-website="${escapeHtml(p.website)}" ${!r.allowed ? 'disabled' : ''}>打开官网</button>` : ''}
    ${!r.allowed ? `<div class="brain-setup-note">${escapeHtml(r.blockedReason)}</div>` : ''}
    ${p.commands.length ? `<details><summary class="b3-disclosure">复制命令</summary>${p.commands.map(cmd => `<div class="brain-cmd"><code>${escapeHtml(cmd)}</code><button class="brain-copy" type="button" data-copy-cmd="${escapeHtml(cmd)}">复制</button></div>`).join('')}</details>` : ''}
    <div class="brain-setup-status" role="status">${escapeHtml(message)}</div>
    ${recheck ? `<button class="brain-recheck brain-quiet" type="button" data-cli-recheck="${escapeHtml(p.id)}">重新检测</button>` : ''}`
}
/** @param {any} deps @param {string} provider */
export async function openCliSetup(deps, provider) {
  closeCliSetup()
  const box = document.getElementById('brain-setup')
  if (!box) return
  box.hidden = false
  box.textContent = '正在检查接入方式…'
  const seq = ++serial
  active = { provider, seq, snapshot: null, busy: false, deadline: 0, message: '', recheck: false }
  try { const r = await snapshot(deps); if (current(seq)) { active.snapshot = r; render() } }
  catch { if (current(seq)) box.textContent = '暂时读不到接入信息，请稍后重新打开。' }
}
/** @param {any} deps */
export async function openCliChoices(deps) {
  closeCliSetup()
  const seq = serial
  const box = document.getElementById('brain-setup')
  if (!box) return
  box.hidden = false
  box.textContent = '正在读取可接入的账号…'
  try {
    const r = await snapshot(deps)
    if (seq !== serial) return
    box.innerHTML = '<div class="brain-setup-title">选择要接入的账号</div><div class="nb-cli-row">' + r.providers.map(p => `<button class="brain-chip brain-off" type="button" data-brain-setup="${escapeHtml(p.id)}">${escapeHtml(p.label)}${p.free ? ' · 免费可用' : ''}</button>`).join('') + '</div>'
  } catch { if (seq === serial) box.textContent = '暂时读不到接入信息，请稍后再试。' }
}
/** Refresh the existing guard tick; no dial unless a setup session was explicitly started. @param {any} deps */
export async function refreshCliSetupGuard(deps) {
  const a = active
  if (!a || a.busy || a.deadline) return
  const r = await snapshot(deps).catch(() => null)
  if (r && current(a.seq)) { a.snapshot = r; render() }
}
/** @param {string} message */
function stopPolling(message) {
  if (!active) return
  clearTimeout(pollTimer)
  clearTimeout(deadlineTimer)
  active.busy = false
  active.deadline = 0
  // Invalidate any already in-flight health response without losing the card.
  active.seq = ++serial
  render(message, true)
}
/** @param {any} deps @param {number} seq */
async function poll(deps, seq) {
  if (!current(seq) || !active?.deadline) return
  try {
    const r = await snapshot(deps)
    if (!current(seq)) return
    active.snapshot = r
    if (!r.allowed) { stopPolling(r.blockedReason); return }
    const p = r.providers.find(p => p.id === active?.provider)
    if (p?.installed && p.runtimeSupported === false) { stopPolling(p.supportNote || '当前平台暂不能接入。'); return }
    if (p?.installed) {
      const result = await v1(deps.invokeApi, V1.llm.health, { query: { fresh: 1, provider: p.id } }, { timeoutMs: 60_000 })
      if (!current(seq)) return
      if (result?.registered?.includes(p.id) && result?.results?.some((/** @type {any} */ x) => x.provider === p.id && x.ok === true)) {
        clearTimeout(pollTimer); clearTimeout(deadlineTimer)
        active.busy = false; active.deadline = 0
        const box = document.getElementById('brain-setup')
        if (box) box.innerHTML = `<div class="brain-setup-title">${escapeHtml(p.label)} 已接入</div>`
        active = null
        return
      }
    }
  } catch { /* Transient detection failure is not a successful login; bounded by the deadline. */ }
  if (current(seq) && active?.deadline) pollTimer = setTimeout(() => { void poll(deps, seq) }, INTERVAL)
}
/** @param {any} deps */
function beginPolling(deps) {
  if (!active) return
  active.busy = true
  active.deadline = Date.now() + TIMEOUT
  const seq = active.seq
  render('终端已打开，正在等待安装与授权完成…', false)
  deadlineTimer = setTimeout(() => { if (current(seq)) stopPolling('还没检测到接入完成。处理好后可以重新检测。') }, TIMEOUT)
  pollTimer = setTimeout(() => { void poll(deps, seq) }, INTERVAL)
}
/** @param {any} deps @param {string} provider @param {string} action */
export async function startCliSetup(deps, provider, action) {
  const a = active
  if (!a || a.provider !== provider || a.busy || !['install', 'login'].includes(action)) return
  a.busy = true
  render('正在检查网络保护…', false)
  try {
    const r = await snapshot(deps)
    if (!current(a.seq)) return
    a.snapshot = r
    if (!r.allowed) { a.busy = false; render(r.blockedReason); return }
    // Commands are never sent over IPC; the native command rechecks the daemon guard.
    await deps.invoke('open_cli_setup', { provider, action })
    if (current(a.seq)) beginPolling(deps)
  } catch {
    if (current(a.seq)) { a.busy = false; render('没能打开接入终端，请检查网络保护后重试。', true) }
  }
}
/** @param {any} deps @param {string} provider */
export function recheckCliSetup(deps, provider) {
  if (!active || active.provider !== provider || active.busy) return
  beginPolling(deps)
  clearTimeout(pollTimer)
  void poll(deps, active.seq)
}

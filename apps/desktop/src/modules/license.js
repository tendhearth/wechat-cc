// @ts-check
/// <reference lib="dom" />
/**
 * Settings-drawer module: "Pro 会员".
 * Shows Free/Pro status, activates a license key, opens the upgrade checkout.
 * Talks to the daemon's internal-api (same as the plugins market). Wiring is
 * attached ONCE at startup; the status refreshes each time the drawer opens.
 *
 * A key starting "DEV-" unlocks Pro locally (no payment) for testing before
 * Lemon Squeezy is wired.
 */
import { invokeApi } from '../api.js'

// TODO: replace with the real Lemon Squeezy checkout link once the store exists.
const UPGRADE_URL = 'https://tendhearth.lemonsqueezy.com'

export async function initLicense() {
  document.getElementById('license-activate-btn')?.addEventListener('click', onActivate)
  document.getElementById('license-deactivate-btn')?.addEventListener('click', onDeactivate)
  const up = document.getElementById('license-upgrade-link')
  if (up) up.setAttribute('href', UPGRADE_URL)
  await refreshLicense().catch(() => {})
}

export async function refreshLicense() {
  const el = document.getElementById('license-status')
  if (!el) return
  const deact = document.getElementById('license-deactivate-btn')
  try {
    const s = /** @type {Record<string, any>} */ (await invokeApi('GET', '/v1/license/status'))
    if (s?.pro) {
      el.innerHTML = `★ <strong>Pro</strong>${s.expires_at ? ` · 有效期至 ${escapeHtml(String(s.expires_at))}` : ''}`
      el.className = 'license-status pro'
      if (deact) deact.hidden = false
    } else {
      el.textContent = '· Free'
      el.className = 'license-status'
      if (deact) deact.hidden = true
    }
  } catch {
    el.textContent = '状态未知（daemon 未启动？）'
    el.className = 'license-status'
  }
}

async function onActivate() {
  const input = /** @type {HTMLInputElement|null} */ (document.getElementById('license-key-input'))
  const key = input?.value?.trim()
  if (!key) { alert('先填 license key'); return }
  const btn = /** @type {HTMLButtonElement|null} */ (document.getElementById('license-activate-btn'))
  if (btn) { btn.disabled = true; btn.textContent = '激活中…' }
  try {
    const r = /** @type {Record<string, any>} */ (await invokeApi('POST', '/v1/license/activate', { key }))
    if (r?.ok) {
      if (input) input.value = ''
      await refreshLicense()
      alert(r.pro ? '已激活 Pro — 重启 daemon 生效' : `已处理，但当前不是 Pro：${r.reason ?? ''}`)
    } else {
      alert(`激活失败：${r?.error ?? 'unknown'}`)
    }
  } catch (err) {
    alert(`激活失败：${err instanceof Error ? err.message : String(err)}`)
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '激活' }
  }
}

async function onDeactivate() {
  if (!confirm('移除 license，回到 Free？')) return
  try {
    await invokeApi('POST', '/v1/license/deactivate')
    await refreshLicense()
  } catch (err) {
    alert(`移除失败：${err instanceof Error ? err.message : String(err)}`)
  }
}

/** @param {string} s */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, m => (
    /** @type {Record<string,string>} */ ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m] ?? m
  ))
}

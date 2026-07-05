// @ts-check
/// <reference lib="dom" />
/**
 * Dashboard module: "插件" (Plugins) tab.
 * Lists discovered plugins (MCP tool providers like wxvault) with their
 * enabled/ready state and an enable/disable toggle. Mirrors a2a-agents.js:
 * a single delegated click handler on the list (no per-refresh leaks), the
 * shared card / .btn / .dot styling, and invokeApi for daemon calls.
 *
 * Toggling persists to plugins.json but only takes effect on the next daemon
 * spawn (MCP servers are wired at boot), so a toggle surfaces a "restart to
 * apply" note rather than pretending it's live.
 */

import { invokeApi } from '../api.js'

export async function initPluginsTab() {
  const list = document.getElementById('plugins-list')
  if (!list) return
  await refresh().catch(err => {
    list.innerHTML = `<li class="empty">加载失败：${escapeHtml(String(err?.message ?? err))}</li>`
  })
  document.getElementById('plugins-refresh-btn')?.addEventListener('click', () => {
    refresh().catch(err => console.error('plugins refresh failed', err))
  })
  // Delegated click handler (attached ONCE — not per refresh).
  list.addEventListener('click', onCardAction)
}

export async function refresh() {
  const list = document.getElementById('plugins-list')
  if (!list) return
  list.innerHTML = '<li class="empty">加载中…</li>'

  const resp = /** @type {{ plugins?: Array<any> }} */ (await invokeApi('GET', '/v1/plugins/list'))
  const plugins = resp?.plugins ?? []
  list.innerHTML = ''
  if (plugins.length === 0) {
    list.innerHTML =
      '<li class="empty">还没有插件。把插件目录放进 <code>~/.claude/channels/wechat/plugins/</code> 再刷新。</li>'
    return
  }
  for (const p of plugins) {
    const live = p.enabled && p.ready
    const li = document.createElement('li')
    li.className = 'a2a-agent-card' + (live ? '' : ' paused')
    li.dataset.name = p.name
    const tools = Array.isArray(p.tools) && p.tools.length
      ? `<div class="plugin-tools">工具：${p.tools.map(/** @param {string} t */ t => escapeHtml(t)).join(' · ')}</div>`
      : ''
    const warn = (p.enabled && !p.ready)
      ? `<div class="plugin-warn">⚠ 未就绪，暂不提供给 agent：${escapeHtml(String(p.not_ready_reason ?? ''))}</div>`
      : ''
    const desc = p.description
      ? `<div class="a2a-card-url">${escapeHtml(String(p.description))}</div>`
      : ''
    li.innerHTML = `
      <header class="a2a-card-head">
        <span class="dot ${live ? 'on' : 'off'}"></span>
        <strong>${escapeHtml(String(p.display_name ?? p.name))}</strong>
        <span class="plugin-name">${escapeHtml(p.name)}</span>
        ${p.version ? `<span class="plugin-ver">v${escapeHtml(String(p.version))}</span>` : ''}
        <span class="plugin-source">${p.source === 'bundled' ? '内置' : '用户'}</span>
      </header>
      ${desc}
      ${tools}
      ${warn}
      <div class="a2a-card-actions">
        <button class="btn ${p.enabled ? 'ghost' : ''}" data-action="toggle"
                data-name="${escapeHtml(p.name)}" data-enabled="${p.enabled}">
          ${p.enabled ? '停用' : '启用'}
        </button>
      </div>
    `
    list.appendChild(li)
  }
}

/** @param {MouseEvent} e */
async function onCardAction(e) {
  const target = e.target
  if (!(target instanceof HTMLButtonElement)) return
  if (target.dataset.action !== 'toggle') return
  const name = target.dataset.name
  if (!name) return
  const enable = target.dataset.enabled !== 'true'   // flip current state
  target.disabled = true
  try {
    const r = /** @type {Record<string, any>} */ (
      await invokeApi('POST', '/v1/plugins/toggle', { name, enabled: enable })
    )
    showNote(`已${enable ? '启用' : '停用'} ${name} — ${r?.note ?? '重启 daemon 生效'}`)
    await refresh()
  } catch (err) {
    target.disabled = false
    alert(`切换失败：${err instanceof Error ? err.message : String(err)}`)
  }
}

/** @param {string} msg */
function showNote(msg) {
  const note = document.getElementById('plugins-note')
  if (!note) return
  note.textContent = msg
  note.hidden = false
}

/** @param {string} s */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, m => (
    /** @type {Record<string,string>} */ ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[m] ?? m
  ))
}

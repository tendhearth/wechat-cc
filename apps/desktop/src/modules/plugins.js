// @ts-check
/// <reference lib="dom" />
/**
 * Dashboard module: "插件" (Plugins) tab.
 * Lists discovered plugins (MCP tool providers) with their
 * enabled/ready state and an enable/disable toggle. Mirrors a2a-agents.js:
 * a single delegated click handler on the list (no per-refresh leaks), the
 * shared card / .btn / .dot styling, and invokeApi for daemon calls.
 *
 * Toggling persists to plugins.json but only takes effect on the next daemon
 * spawn (MCP servers are wired at boot), so a toggle surfaces a "restart to
 * apply" note rather than pretending it's live.
 */

import { invokeApi } from '../api.js'

/** CLI bridge (invoke("wechat_cli_text"/"wechat_cli_json", {args})) — set in init.
 * Needed to run a plugin's setup via the CLI (`plugin setup <name>`), which
 * streams progress; invokeApi (HTTP) is for the read/toggle routes.
 * @type {((cmd: string, args: Record<string, unknown>) => Promise<any>) | null} */
let cliInvoke = null

/** @param {{ invoke?: (cmd: string, args: Record<string, unknown>) => Promise<any> }} [deps] */
export async function initPluginsTab(deps) {
  cliInvoke = deps?.invoke ?? null
  const list = document.getElementById('plugins-list')
  if (!list) return
  await refresh().catch(err => {
    list.innerHTML = `<li class="empty">加载失败：${escapeHtml(String(err?.message ?? err))}</li>`
  })
  document.getElementById('plugins-refresh-btn')?.addEventListener('click', () => {
    refresh().catch(err => console.error('plugins refresh failed', err))
  })
  // Delegated click handlers (attached ONCE — not per refresh).
  list.addEventListener('click', onCardAction)
  document.getElementById('plugins-market-list')?.addEventListener('click', onMarketAction)
}

export async function refresh() {
  await Promise.all([refreshInstalled(), refreshMarket()])
}

async function refreshInstalled() {
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
        ${(p.has_setup && !p.ready)
          ? `<button class="btn" data-action="setup" data-name="${escapeHtml(p.name)}">连接微信并解密</button>` : ''}
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
  const name = target.dataset.name
  if (!name) return
  if (target.dataset.action === 'setup') { await runSetup(name, target); return }
  if (target.dataset.action !== 'toggle') return
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

/**
 * Run a plugin's setup (`plugin setup <name>`) via the CLI bridge, streaming
 * progress by polling `plugin setup-status` (same pattern as the service-install
 * wizard). For wxvault this is the「连接微信」flow: resign → capture → decrypt.
 * @param {string} name @param {HTMLButtonElement} btn
 */
async function runSetup(name, btn) {
  if (!cliInvoke) { alert('此操作需在桌面 App 内进行'); return }
  btn.disabled = true
  const orig = btn.textContent
  btn.textContent = '进行中…'
  showNote(`正在连接微信并解密（会短暂关闭微信、抠密钥、解密）…`)
  const poll = setInterval(async () => {
    try {
      const s = await cliInvoke('wechat_cli_json', { args: ['plugin', 'setup-status'] })
      if (s && s.running) showNote(`解密中… [${s.stage}/${s.total}] ${escapeHtml(String(s.label ?? ''))}`)
    } catch { /* transient */ }
  }, 700)
  try {
    // Long-running: streams stdout; resolves when setup exits. Text (not JSON) output.
    await cliInvoke('wechat_cli_text', { args: ['plugin', 'setup', name] })
    const s = await cliInvoke('wechat_cli_json', { args: ['plugin', 'setup-status'] }).catch(() => null)
    showNote(s?.ok
      ? `✓ ${name} 解密完成 — 现在可「启用」并重启 daemon 生效`
      : `连接失败：${escapeHtml(String(s?.error ?? '见日志'))}（微信是否已登录？）`)
  } catch (err) {
    showNote(`连接失败：${err instanceof Error ? err.message : String(err)}`)
  } finally {
    clearInterval(poll)
    btn.disabled = false
    btn.textContent = orig
    await refresh()
  }
}

async function refreshMarket() {
  const list = document.getElementById('plugins-market-list')
  const note = document.getElementById('plugins-market-note')
  if (!list) return
  list.innerHTML = '<li class="empty">加载市场中…</li>'
  const resp = /** @type {{ plugins?: Array<any>, error?: string }} */ (
    await invokeApi('GET', '/v1/plugins/registry').catch(err => ({ error: String(err?.message ?? err) }))
  )
  if (note) {
    if (resp?.error) {
      note.hidden = false
      note.innerHTML = `市场暂不可用：${escapeHtml(resp.error)}<br>把 <code>WECHAT_CC_PLUGIN_REGISTRY</code> 指向你的 registry.json（见 docs/registry.example.json）。`
    } else { note.hidden = true }
  }
  const plugins = resp?.plugins ?? []
  list.innerHTML = ''
  if (plugins.length === 0) {
    if (!resp?.error) list.innerHTML = '<li class="empty">市场里还没有插件。</li>'
    return
  }
  for (const p of plugins) {
    const li = document.createElement('li')
    li.className = 'a2a-agent-card'
    let btn
    if (p.update_available) {
      btn = `<button class="btn" data-action="upgrade" data-name="${escapeHtml(p.name)}">更新 → v${escapeHtml(String(p.version))}</button>`
    } else if (p.installed) {
      btn = `<button class="btn ghost" disabled>已安装</button>`
    } else {
      btn = `<button class="btn" data-action="install" data-name="${escapeHtml(p.name)}">安装</button>`
    }
    li.innerHTML = `
      <header class="a2a-card-head">
        <strong>${escapeHtml(String(p.display_name ?? p.name))}</strong>
        <span class="plugin-ver">v${escapeHtml(String(p.version))}</span>
        ${p.author ? `<span class="plugin-source">${escapeHtml(String(p.author))}</span>` : ''}
      </header>
      ${p.description ? `<div class="a2a-card-url">${escapeHtml(String(p.description))}</div>` : ''}
      <div class="a2a-card-actions">${btn}</div>
    `
    list.appendChild(li)
  }
}

/** @param {MouseEvent} e */
async function onMarketAction(e) {
  const target = e.target
  if (!(target instanceof HTMLButtonElement)) return
  const action = target.dataset.action
  const name = target.dataset.name
  if ((action !== 'install' && action !== 'upgrade') || !name) return
  const verb = action === 'upgrade' ? '更新' : '安装'
  target.disabled = true
  target.textContent = `${verb}中…`
  try {
    const r = /** @type {Record<string, any>} */ (await invokeApi('POST', `/v1/plugins/${action}`, { name }))
    if (r?.ok) {
      showNote(action === 'upgrade'
        ? `已更新 ${name} ${r.from ?? ''}→${r.to ?? ''} — 重启 daemon 生效`
        : `已安装 ${name} v${r.version ?? ''} — 默认停用，去上面「启用」并完成 setup 后重启 daemon`)
    } else {
      alert(`${verb}失败：${r?.error ?? 'unknown'}`)
    }
    await refresh()
  } catch (err) {
    alert(`${verb}失败：${err instanceof Error ? err.message : String(err)}`)
    await refresh()
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

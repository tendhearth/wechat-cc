// Dashboard module. Owns the overview pane: daemon hero, bound-accounts
// table (incl. inline two-step delete confirm), footer pid indicator,
// and the smart restart-daemon button.
//
// Owns: #hero-card, #hero-headline, #hero-meta, #accounts-body,
//       #accounts-meta, #dash-pending, #dash-restart,
//       #dash-refresh, #dash-rail-clock (rail-foot wall clock)
// Subscribes to: doctorPoller (renderDashboard + renderRestartButton fire
// on every successful poll automatically).

import { dashboardHero, accountRows, formatRelativeTime, escapeHtml, restartButtonState, deleteAccountConfirmCopy, diagnose } from "../view.js"
import { icon } from "./icons.js"

const USER_CARD_PROVIDERS = ["claude", "codex", "gemini"]

export function renderDashboard(report) {
  const expiredCount = (report.expiredBots || []).length
  const baseHero = dashboardHero({
    daemonAlive: !!report.checks.daemon.alive,
    accountCount: report.checks.accounts.count,
    expiredCount,
    lastProbe: _lastProbe,
  })
  const hero = reconnectHero(baseHero)
  const card = document.getElementById("hero-card")
  if (!card) return
  card.classList.toggle("warn", hero.tone !== "ok")
  document.getElementById("hero-headline").textContent = hero.headline
  document.getElementById("hero-meta").textContent = hero.meta
  const stopBtn = document.getElementById("dash-stop")
  const restartBtn = document.getElementById("dash-restart")
  const rebindBtn = document.getElementById("dash-rebind")
  const testConnBtn = document.getElementById("dash-test-conn")
  if (stopBtn) stopBtn.hidden = hero.state !== "connected"
  if (restartBtn) restartBtn.hidden = hero.state !== "recovering"
  if (rebindBtn) rebindBtn.hidden = hero.state !== "taken_over"
  // "测试本机连接" is only useful when the state is NOT already a confirmed
  // connection — hide it when connected (the hero already says 陪伴中), show it
  // in 失去连接 / 本机未连接 so the user can verify or re-check ownership.
  if (testConnBtn) testConnBtn.hidden = hero.state === "connected"
  syncReconnectControls(hero)

  const accounts = report.checks.accounts.items || []
  const expired = report.expiredBots || []
  const expiredById = Object.fromEntries(expired.map(b => [b.botId, b]))
  const rows = accountRows(accounts, report.userNames || {}, expired, report.checks.access.admins || [])
  const tbody = document.getElementById("accounts-body")
  const current = document.getElementById("accounts-current")

  // Skip re-render if user has an inline confirm open (poll race — the 5s
  // tick would clobber the half-filled "确定删除?" UI otherwise).
  const hasOpenConfirm = tbody.querySelector(".confirm-inline")
  // Pick the admin row for the "当前连接中的用户" slot. Falls back to first
  // row if no admin is in the bound accounts (e.g. access.json admins[] is
  // empty, or admin hasn't re-bound after a fresh install).
  const currentRow = rows.find(r => r.isAdmin) || rows[0]
  if (!hasOpenConfirm && current) {
    if (!currentRow) {
      current.innerHTML = `
        <div class="user-avatar avatar-admin">?</div>
        <div class="user-copy">
          <div class="user-name">还没有连接用户</div>
          <div class="user-sub">打开设置添加微信账号</div>
        </div>
        <span class="provider-chip">${escapeHtml(report.checks.provider.provider || "codex")}</span>
      `
      tbody.innerHTML = ""
    } else {
      // Show honest connection status. For connected state, surface the last
      // successful getUpdates heartbeat when available. For expired, show
      // the expiry timestamp. For taken_over / recovering, keep existing copy.
      const currentExp = expiredById[currentRow.id]
      const heartbeats = report.heartbeats || {}
      const hb = heartbeats[currentRow.id]
      const currentSub = currentRow.expired
        ? `连接已过期${currentExp ? ` · ${formatRelativeTime(currentExp.firstSeenExpiredAt)}` : ""}`
        : hero.state === "connected" && hb
          ? `连接正常 · 上次活动 ${formatRelativeTime(hb)}`
          : "已连接"
      current.innerHTML = `
        <div class="user-avatar avatar-admin">${avatarSvg("admin", currentRow.name)}</div>
        <div class="user-copy">
          <div class="user-name">${escapeHtml(currentRow.name)} <span class="role-pill">管理员</span></div>
          <div class="user-sub">微信私聊，${currentSub}</div>
        </div>
        <button class="provider-switch" aria-haspopup="true" aria-label="切换 provider">
          <span class="provider-chip">${escapeHtml(report.checks.provider.provider || "codex")}</span>
          <span class="provider-chevron">⌄</span>
        </button>
      `
    }
  }

  if (hasOpenConfirm) {
    /* skip */
  } else {
    const subRows = currentRow ? rows.filter(r => r.id !== currentRow.id) : []
    tbody.classList.toggle("is-empty", subRows.length === 0)
    if (subRows.length === 0) {
      tbody.innerHTML = `
        <div class="sub-user-empty" role="status">
          <span class="sub-user-empty-icon" aria-hidden="true">${icon("user-add-01", { size: 28 })}</span>
          <div class="sub-user-empty-title">还没有子用户</div>
          <div class="sub-user-empty-copy">添加后，他们会出现在这里</div>
        </div>
      `
    } else {
      tbody.innerHTML = subRows.map((row, index) => {
      const expEntry = expiredById[row.id]
      // Active: honest "已连接" — daemon has no last-active heartbeat for
      // real accounts, so we don't fake a last-active time.
      const expCell = expEntry
        ? `已过期 · ${formatRelativeTime(expEntry.firstSeenExpiredAt)}`
        : "已连接"
      // Expired rows get a primary 重新扫码 affordance next to the (now
      // ghost) delete button — clicking 重新扫码 routes back into the
      // wizard's bind/QR step so the user can pair the same WeChat
      // account again. Non-expired rows keep the original danger-style
      // delete-only layout.
      const actCell = row.expired
        ? `<button class="mini-action" data-action="rebind">${icon("refresh", { size: 13 })}重新扫码</button>
           <button class="mini-action" data-action="ask-delete">${icon("delete-02", { size: 13 })}删除</button>`
        : `<button class="mini-action" data-action="ask-delete">${icon("delete-02", { size: 13 })}删除</button>`
      const conversation = conversationForAccount(report?.conversations || [], row)
      const currentProvider = providerFromMode(conversation?.mode) || report.checks.provider.provider || "claude"
      const chatId = conversation?.chat_id || row.userId || row.id
      return `
        <div class="sub-user-card" data-bot-id="${escapeHtml(row.id)}" data-chat-id="${escapeHtml(chatId)}" data-current-provider="${escapeHtml(currentProvider)}" data-name="${escapeHtml(row.name)}">
          <button class="card-menu" aria-haspopup="true" aria-label="选择 Agent">${icon("more-horizontal", { size: 18 })}</button>
          <div class="user-avatar">${avatarSvg(row.avatar ?? index, row.name)}</div>
          <div class="user-copy">
            <div class="user-name">${escapeHtml(row.name)}</div>
            <div class="user-sub">${escapeHtml(expCell)}</div>
          </div>
          <div class="act">${actCell}</div>
        </div>
      `
      }).join("")
    }
    const subExpiredCount = subRows.filter(row => row.expired).length
    document.getElementById("accounts-meta").textContent = subExpiredCount > 0
      ? `${subRows.length} 个 · ${subExpiredCount} 已过期`
      : `${subRows.length} 个`
  }
}

function conversationForAccount(conversations, row) {
  if (!Array.isArray(conversations)) return null
  return conversations.find(c =>
    c?.chat_id === row.userId
    || c?.user_id === row.userId
    || c?.chat_id === row.id
  ) || null
}

function providerFromMode(mode) {
  if (!mode || typeof mode !== "object") return null
  if (mode.kind === "solo") return mode.provider || null
  if (mode.kind === "primary_tool") return mode.primary || null
  if (Array.isArray(mode.providers)) return mode.providers[0] || null
  if (Array.isArray(mode.participants)) return mode.participants[0] || null
  return null
}

const AVATAR_LINE_ICONS = [
  `<path d="M24 33c-5 0-9-4-9-10s4-10 9-10 9 4 9 10-4 10-9 10Z"/><path d="M18 21c3-1 5-3 6-6 2 3 4 5 7 6"/><path d="M20 25h.1M28 25h.1"/><path d="M21 29c2 1 4 1 6 0"/>`,
  `<path d="M24 12l3.6 7.1 7.9 1.2-5.7 5.6 1.3 7.9L24 30l-7.1 3.8 1.3-7.9-5.7-5.6 7.9-1.2L24 12Z"/><path d="M18 16l-1.5-3M31 17l2-2.3M34 29l3 1.1M13 29l-3 1.2"/>`,
  `<path d="M16 20l-2-6 6 3M32 20l2-6-6 3"/><path d="M16 22c0-5 4-8 8-8s8 3 8 8v4c0 5-4 8-8 8s-8-3-8-8v-4Z"/><path d="M20 24h.1M28 24h.1M24 27v2M20 30c2 2 6 2 8 0"/>`,
  `<rect x="15" y="17" width="18" height="15" rx="5"/><path d="M24 17v-5M20 12h8"/><path d="M20 24h.1M28 24h.1"/><path d="M20 29h8"/><path d="M12 24h3M33 24h3"/>`,
  `<path d="M16 19h16c1 0 2 1 2 2v8c0 3-3 5-10 5s-10-2-10-5v-8c0-1 1-2 2-2Z"/><path d="M16 19c2-4 14-4 16 0"/><path d="M20 27c3-3 6-3 9 0-3 3-6 3-9 0Z"/><path d="M29 27l3-2v4l-3-2Z"/><path d="M19 15c0-2 2-3 5-3s5 1 5 3"/>`,
  `<path d="M16 30h17c3 0 5-2 5-5s-2-5-5-5c-1-5-5-8-10-8-6 0-10 4-10 10-3 1-5 3-5 6s3 5 8 5"/><path d="M20 25h.1M28 25h.1"/><path d="M22 29c2 1 4 1 6 0"/><path d="M34 13l1.4-2.4M37 17l2.6-.7"/>`,
]

// Hand-drawn default avatars. Real WeChat avatars can replace this later,
// but the fallback should already match the current illustrated UI.
function avatarSvg(seed, label) {
  const seedNum = Number(seed)
  const index = String(seed) === "admin"
    ? 0
    : Number.isFinite(seedNum)
      ? Math.abs(Math.trunc(seedNum)) % AVATAR_LINE_ICONS.length
      : Math.abs(String(label || seed).split("").reduce((h, ch) => ((h * 31 + ch.charCodeAt(0)) | 0), 7)) % AVATAR_LINE_ICONS.length
  return `<svg viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="22.5" fill="#f8f4ea" stroke="#ebe1d2" stroke-width="1"/><g fill="none" stroke="#593F2C" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">${AVATAR_LINE_ICONS[index]}</g></svg>`
}

// Mutate the dashboard's restart + stop buttons to reflect daemon+service
// state. Stored separately from renderDashboard so we can call it from
// places that don't re-render the whole hero (e.g. after account remove).
export function renderRestartButton(report) {
  const btn = document.getElementById("dash-restart")
  if (!btn) return
  const hero = reconnectHero(dashboardHero({
    daemonAlive: !!report.checks.daemon?.alive,
    accountCount: report.checks.accounts?.count ?? 0,
    expiredCount: (report.expiredBots || []).length,
    lastProbe: _lastProbe,
  }))
  const showOnlineControls = hero.state === "connected"
  const choice = restartButtonState(report.checks.daemon, report.checks.service)
  // Find the label text node (the one with non-whitespace content). The
  // button has whitespace text nodes between the icon span and the label,
  // so a naive `find(TEXT_NODE)` would replace the wrong node and leave
  // the original "重启 daemon" string sitting next to the new label.
  const labelNode = Array.from(btn.childNodes).find(
    n => n.nodeType === Node.TEXT_NODE && n.textContent.trim().length > 0,
  )
  const visibleLabel = _reconnectPhase === "connecting"
    ? "正在重新连接…"
    : _reconnectPhase === "failed"
      ? "再试一次"
      : "重新连接"
  if (labelNode) labelNode.textContent = ` ${visibleLabel}`
  else btn.appendChild(document.createTextNode(` ${visibleLabel}`))
  btn.dataset.action = choice.action
  btn.disabled = _reconnectPhase === "connecting"
  if (choice.helper) btn.title = choice.helper
  else btn.removeAttribute("title")

  // Stop button: meaningful only when the daemon is actually running. When
  // offline, disable to make "nothing to stop" the obvious affordance
  // (instead of clicking and getting an error toast).
  const stopBtn = document.getElementById("dash-stop")
  if (stopBtn) {
    stopBtn.hidden = !showOnlineControls
    stopBtn.disabled = false
    if (showOnlineControls) stopBtn.removeAttribute("title")
    else stopBtn.title = "daemon 未运行"
  }
  btn.hidden = hero.state !== "recovering"
  const detailsBtn = document.getElementById("dash-view-details")
  if (detailsBtn) detailsBtn.hidden = _reconnectPhase !== "failed"
}

export function setPending(msg) {
  const el = document.getElementById("dash-pending")
  if (el) el.textContent = msg
}

function setButtonLabel(button, label) {
  if (!button) return
  const labelNode = Array.from(button.childNodes).find(
    node => node.nodeType === Node.TEXT_NODE && node.textContent.trim().length > 0,
  )
  if (labelNode) labelNode.textContent = ` ${label}`
  else button.appendChild(document.createTextNode(` ${label}`))
}

function reconnectHero(hero) {
  if (hero.state === "taken_over") return hero
  if (_reconnectPhase === "connecting") {
    return {
      state: "recovering",
      tone: "warn",
      headline: "正在重新连接",
      meta: "请稍候…",
    }
  }
  if (_reconnectPhase === "failed") {
    return {
      state: "recovering",
      tone: "warn",
      headline: "CC 暂时失去连接",
      meta: _reconnectFailureMessage,
    }
  }
  return hero
}

function syncReconnectControls(hero) {
  const restartBtn = document.getElementById("dash-restart")
  const detailsBtn = document.getElementById("dash-view-details")
  if (restartBtn) {
    restartBtn.hidden = hero.state !== "recovering"
    restartBtn.disabled = _reconnectPhase === "connecting"
    setButtonLabel(
      restartBtn,
      _reconnectPhase === "connecting"
        ? "正在重新连接…"
        : _reconnectPhase === "failed"
          ? "再试一次"
          : "重新连接",
    )
  }
  if (detailsBtn) detailsBtn.hidden = _reconnectPhase !== "failed"
}

function setReconnectPhase(phase, message = "暂时无法恢复，请稍后再试") {
  _reconnectPhase = phase
  _reconnectFailureMessage = message
  const headline = document.getElementById("hero-headline")
  const meta = document.getElementById("hero-meta")
  if (phase === "connecting") {
    if (headline) headline.textContent = "正在重新连接"
    if (meta) meta.textContent = "请稍候…"
  } else if (phase === "failed") {
    if (headline) headline.textContent = "CC 暂时失去连接"
    if (meta) meta.textContent = message
  }
  syncReconnectControls({ state: phase === "idle" ? "connected" : "recovering" })
}

export function updateClock() {
  const el = document.getElementById("dash-rail-clock")
  if (!el) return
  const now = new Date()
  el.textContent = now.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })
}

// Stop the daemon via `service stop` + residual-kill. Mirrors restartDaemon's
// pending UX but only fires the stop steps. After this returns, restart-button
// state re-renders to show "启动" (since daemon is now offline).
export async function stopDaemon(deps) {
  setPending("停止…")
  let stopError = null
  try {
    await deps.invoke("wechat_cli_json", { args: ["service", "stop", "--json"] })
  } catch (err) {
    stopError = err
  }
  // Same residual-kill rationale as restartDaemon: launchctl/systemd doesn't
  // touch manual `wechat-cc run` instances, so without this step "停止" can
  // leave a daemon polling silently in the background.
  let killError = null
  try {
    await deps.invoke("wechat_cli_json", { args: ["daemon", "kill-residual", "--json"] })
  } catch (err) {
    killError = err
  }
  const report = await deps.doctorPoller.refresh()
  if (report && !report.checks.daemon?.alive) {
    deps.markDisconnected?.()
  }
  if (report?.checks.daemon?.alive) {
    setPending("断开失败：daemon 仍在运行")
    return
  }
  if (stopError || killError) {
    setPending("已断开；后台服务停止时有警告")
    setTimeout(() => setPending(""), 3000)
    return
  }
  setPending("已停止")
  setTimeout(() => setPending(""), 2000)
}

// The actual stop+kill+start chain used by the single-click reconnect flow.
export async function runRestartSequence(deps) {
  // Capture pid BEFORE the stop step. May be null on non-Windows.
  let beforePid = null
  try { beforePid = await deps.invoke("wechat_daemon_pid") } catch { /* not registered */ }

  setReconnectPhase("connecting")
  setPending("")
  try {
    await deps.invoke("wechat_cli_json", { args: ["service", "stop", "--json"] })
  } catch { /* tolerate */ }
  // Force-kill any process still holding server.pid. `service stop` only
  // terminates launchctl/systemd-managed processes — a manual `wechat-cc
  // run` started in a terminal is invisible to them and will refuse the
  // next `service start` with "another daemon already running", causing
  // a silent restart loop. This step closes that gap cross-platform.
  try {
    await deps.invoke("wechat_cli_json", { args: ["daemon", "kill-residual", "--json"] })
  } catch { /* best effort — start step will surface real failures */ }
  try {
    await deps.invoke("wechat_cli_json", { args: ["service", "start", "--json"] })
  } catch (err) {
    setReconnectPhase("failed")
    return false
  }

  // Wait for the daemon to register instead of trusting `service start`.
  // launchctl/schtasks/systemctl can report command success even when the
  // child exits immediately during bootstrap.
  const refreshed = typeof deps.doctorPoller.waitForCondition === "function"
    ? await deps.doctorPoller.waitForCondition(r => !!r.checks.daemon?.alive, 8000, 500)
    : await deps.doctorPoller.refresh()
  if (!refreshed?.checks?.daemon?.alive) {
    setReconnectPhase("failed")
    return false
  }

  // Verify pid changed when the platform can report it. Non-Windows returns
  // null from wechat_daemon_pid, so the alive doctor result above is the
  // source of truth there.
  let afterPid = null
  try { afterPid = await deps.invoke("wechat_daemon_pid") } catch { /* not registered */ }
  deps.markConnected?.()

  if (beforePid !== null && afterPid !== null && beforePid === afterPid) {
    // pid didn't change — Stop-Process likely got Access Denied.
    // Record for the next diagnose() call so code 8 can fire on win32.
    _lastRestart = { pidUnchanged: true }
    setReconnectPhase("failed", "系统权限不足，请重新打开应用后再试")
    return false
  }
  // Any other outcome: clear the signal so the next diagnose has a fresh read.
  _lastRestart = { pidUnchanged: false }
  if (beforePid !== null && afterPid === null) {
    setReconnectPhase("failed")
    return false
  }
  setReconnectPhase("idle")
  if (beforePid !== null && afterPid !== null) {
    setPending("连接已恢复")
    setTimeout(() => setPending(""), 3000)
    return true
  }

  // Non-Windows or daemon wasn't running before — existing path
  setPending("连接已恢复")
  setTimeout(() => setPending(""), 2000)
  return true
}

// Latest connection-probe verdict ({ state, detail } | null). Set by the
// 「测试本机连接」button handler (main.js, Task 7), read on the next
// renderDashboard so the hero keeps the probe result across the 5s doctor tick.
export let _lastProbe = null
export function setLastProbe(p) { _lastProbe = p }

// Carries the outcome of the most recent runRestartSequence call into the
// next restartDaemon (diagnose) invocation. Cleared after consumption so
// stale signals never linger across multiple clicks.
let _lastRestart = null
let _reconnectPhase = "idle"
let _reconnectFailureMessage = "暂时无法恢复，请稍后再试"

// Provider-switch dropdown state.
let _providerMenuOpen = false
let _providerSwitchInflight = false

// One-shot outside-click + Escape handler installed when menu opens.
// Stored so it can be removed precisely without leaking DOM listeners.
let _providerMenuOutsideHandler = null
let _providerMenuKeyHandler = null

/**
 * TEST-ONLY: Reset all module-level dashboard state.
 */
export function __resetDashboardState() {
  _lastRestart = null
  _lastProbe = null
  _reconnectPhase = "idle"
  _reconnectFailureMessage = "暂时无法恢复，请稍后再试"
  _providerMenuOpen = false
  _providerSwitchInflight = false
  _providerMenuOutsideHandler = null
  _providerMenuKeyHandler = null
}

// Smart reconnect: diagnose internally, then execute the matching recovery
// while keeping the overview hero as the only user-facing status surface.
export async function restartDaemon(deps) {
  if (_reconnectPhase === "connecting") return
  // If the user got here by explicitly clicking 断开连接, the daemon being
  // dead is the expected, self-inflicted state — not a fault to diagnose.
  // A user-requested disconnect should reconnect through the same one-click
  // recovery path as an unexpected interruption.
  if (deps.isDisconnectedIntent?.()) {
    return runRestartSequence(deps)
  }
  setReconnectPhase("connecting")
  setPending("")
  const report = await deps.doctorPoller.refresh() ?? deps.doctorPoller.current

  if (!report) {
    // No report at all — fall back to the direct restart sequence
    return runRestartSequence(deps)
  }

  const healthOk = deps.healthProbe ? await deps.healthProbe() : null
  const capturedLastRestart = _lastRestart
  _lastRestart = null  // consume: one observation per click, never lingers
  const diagnosis = diagnose({
    report,
    healthOk,
    lastError: deps.doctorPoller.lastError ?? null,
    lastRestart: capturedLastRestart,
    platform: typeof navigator !== "undefined" ? (navigator.platform || "linux") : "linux",
  })

  // Step 4 — RECONNECT_DIAGNOSE telemetry: fire-and-forget log write.
  // Must be placed AFTER diagnose() so we capture every click (code 0 + non-0).
  // The call is deliberately not awaited — a slow daemon or broken CLI must
  // NOT delay the reconnect UI response.
  const _fields = {
    code: diagnosis.code,
    daemon_alive: !!(report?.checks?.daemon?.alive),
    service_installed: !!(report?.checks?.service?.installed),
    provider: report?.checks?.provider?.provider ?? "unknown",
    lastError_present: deps.doctorPoller.lastError != null,
    health_ok: healthOk,
    platform: typeof navigator !== "undefined" ? (navigator.platform || "unknown") : "unknown",
  }
  Promise.resolve().then(() =>
    deps.invoke("wechat_cli_json", {
      args: [
        "log",
        "RECONNECT_DIAGNOSE",
        `code=${diagnosis.code} provider=${_fields.provider}`,
        "--fields",
        JSON.stringify(_fields),
        "--json",
      ],
    }).catch(() => {/* telemetry is best-effort; ignore failures */})
  )

  // Code 0: everything is fine — show a brief "all good" toast instead of card
  if (diagnosis.code === 0) {
    setReconnectPhase("idle")
    deps.markConnected?.()
    setPending("连接正常")
    setTimeout(() => setPending(""), 1500)
    return
  }

  // Keep diagnostics internal. The existing hero is the only user-facing
  // recovery surface, so the reconnect button performs the recommended
  // action immediately instead of asking for a second click in another card.
  switch (diagnosis.primary.action.kind) {
    case "run-restart-sequence":
      return runRestartSequence(deps)
    case "route-to-wizard":
      setReconnectPhase("idle")
      if (diagnosis.primary.action.step === "service") deps.routeToWizardService?.()
      else deps.routeToWizardBind?.()
      return
    case "show-fix":
      setReconnectPhase("failed", "AI 服务暂不可用，请检查设置")
      deps.routeToProviderSettings?.()
      return
    case "route-to-settings":
      setReconnectPhase("failed", "连接设置需要调整")
      if (diagnosis.primary.action.section === "access") deps.routeToAccessSettings?.()
      else deps.routeToProviderSettings?.()
      return
    case "restart-dashboard":
      setReconnectPhase("failed", "页面状态暂未更新，请重新打开应用")
      return
    case "show-platform-hint":
      setReconnectPhase("failed", "系统权限不足，请重新打开应用后再试")
      return
    default:
      setReconnectPhase("failed")
  }
}

// Close the provider-switch dropdown and remove its one-shot listeners.
export function closeProviderMenu() {
  const menu = document.getElementById("provider-menu")
  if (menu) menu.hidden = true
  _providerMenuOpen = false
  if (_providerMenuOutsideHandler) {
    document.removeEventListener("click", _providerMenuOutsideHandler, true)
    _providerMenuOutsideHandler = null
  }
  if (_providerMenuKeyHandler) {
    document.removeEventListener("keydown", _providerMenuKeyHandler)
    _providerMenuKeyHandler = null
  }
}

// Toggle the provider-switch dropdown.
// deps: the standard deps bag ({ invoke, doctorPoller, ... })
// report: the current doctor report (used to read the active provider)
export async function toggleProviderMenu(deps, report) {
  if (_providerMenuOpen) {
    closeProviderMenu()
    return
  }

  const menu = document.getElementById("provider-menu")
  if (!menu) return

  // Find the anchor (.provider-switch button) to position the menu below it.
  const anchor = document.querySelector(".provider-switch")
  if (!anchor) return

  const currentProvider = report?.checks?.provider?.provider || "codex"
  const providers = ["claude", "codex", "cursor"]

  // Build menu buttons
  menu.innerHTML = providers.map(p => {
    const active = p === currentProvider
    return `<button class="${active ? "provider-menu-active" : ""}" data-provider="${escapeHtml(p)}">${escapeHtml(p)}</button>`
  }).join("")

  // Position: fixed, anchored below the .provider-switch button.
  // Using getBoundingClientRect so it works regardless of scroll position.
  const rect = anchor.getBoundingClientRect()
  menu.style.top = `${rect.bottom + 4}px`
  menu.style.left = `${rect.left}px`
  menu.hidden = false
  _providerMenuOpen = true

  // Wire button clicks inside the menu
  menu.querySelectorAll("button[data-provider]").forEach(btn => {
    btn.addEventListener("click", async (ev) => {
      ev.stopPropagation()
      if (_providerSwitchInflight) return
      const name = btn.dataset.provider
      if (!name) return
      if (name === currentProvider) {
        closeProviderMenu()
        return
      }
      // Disable further clicks while switching
      _providerSwitchInflight = true
      menu.querySelectorAll("button").forEach(b => { b.disabled = true })
      try {
        // provider set doesn't emit JSON — use wechat_cli_text (same as
        // the wizard's commitProvider path in main.js).
        await deps.invoke("wechat_cli_text", { args: ["provider", "set", name] })
      } catch {
        setPending(`切换 provider 失败`)
        setTimeout(() => setPending(""), 3000)
        _providerSwitchInflight = false
        closeProviderMenu()
        return
      }
      closeProviderMenu()
      await runRestartSequence(deps)
      setPending(`已切换到 ${name}`)
      setTimeout(() => setPending(""), 2500)
      _providerSwitchInflight = false
    })
  })

  // Outside-click: close menu when clicking anywhere outside it
  _providerMenuOutsideHandler = (ev) => {
    if (!menu.contains(ev.target) && !(anchor.contains && anchor.contains(ev.target))) {
      closeProviderMenu()
    }
  }
  document.addEventListener("click", _providerMenuOutsideHandler, true)

  // Escape key: close menu
  _providerMenuKeyHandler = (ev) => {
    if (ev.key === "Escape") closeProviderMenu()
  }
  document.addEventListener("keydown", _providerMenuKeyHandler)
}

export async function toggleUserProviderMenu(deps, anchor, _report) {
  if (_providerMenuOpen) {
    closeProviderMenu()
    return
  }

  const menu = document.getElementById("provider-menu")
  if (!menu || !anchor) return

  const row = anchor.closest?.(".sub-user-card")
  if (!row) return

  const currentProvider = row.dataset.currentProvider || "claude"
  const chatId = row.dataset.chatId
  // No chat_id yet (freshly bound, no conversation) → switch provider UI-only.
  const noChat = !chatId

  menu.innerHTML = USER_CARD_PROVIDERS.map(p => {
    const active = p === currentProvider
    return `<button class="${active ? "provider-menu-active" : ""}" data-provider="${escapeHtml(p)}">${escapeHtml(p)}</button>`
  }).join("")

  const rect = anchor.getBoundingClientRect()
  menu.style.top = `${rect.bottom + 4}px`
  menu.style.left = `${Math.max(8, rect.right - 144)}px`
  menu.hidden = false
  _providerMenuOpen = true

  menu.querySelectorAll("button[data-provider]").forEach(btn => {
    btn.addEventListener("click", async (ev) => {
      ev.stopPropagation()
      if (_providerSwitchInflight) return
      const name = btn.dataset.provider
      if (!name) return
      if (name === currentProvider) {
        closeProviderMenu()
        return
      }
      if (noChat) {
        row.dataset.currentProvider = name
        closeProviderMenu()
        return
      }

      _providerSwitchInflight = true
      menu.querySelectorAll("button").forEach(b => { b.disabled = true })
      try {
        await deps.invoke("wechat_cli_json", {
          args: ["mode", "set", chatId, JSON.stringify({ kind: "solo", provider: name }), "--json"],
        })
      } catch (err) {
        setPending(`切换 ${name} 失败：${deps.formatInvokeError ? deps.formatInvokeError(err) : String(err)}`)
        setTimeout(() => setPending(""), 3000)
        _providerSwitchInflight = false
        closeProviderMenu()
        return
      }
      row.dataset.currentProvider = name
      closeProviderMenu()
      setPending(`已切换到 ${name}`)
      setTimeout(() => setPending(""), 2500)
      _providerSwitchInflight = false
      await deps.doctorPoller?.refresh?.()
    })
  })

  _providerMenuOutsideHandler = (ev) => {
    if (!menu.contains(ev.target) && !(anchor.contains && anchor.contains(ev.target))) {
      closeProviderMenu()
    }
  }
  document.addEventListener("click", _providerMenuOutsideHandler, true)

  _providerMenuKeyHandler = (ev) => {
    if (ev.key === "Escape") closeProviderMenu()
  }
  document.addEventListener("keydown", _providerMenuKeyHandler)
}

// Account row inline two-step confirm handler. Wired by main.js to the
// #accounts-body click event. Returns true if it handled the click.
export async function handleAccountRowClick(deps, ev) {
  const btn = ev.target.closest("button[data-action]")
  if (!btn) return false
  const row = btn.closest("[data-bot-id]")
  if (!row) return false
  const action = btn.dataset.action
  if (action === "rebind") {
    // Route to wizard bind step. Preferred: deps.routeToWizardBind (lands
    // on the QR/扫码 panel directly). Fallback: routeToWizardService —
    // not perfect targeting but at least pulls the user out of the
    // dashboard into the setup flow rather than no-op'ing the click.
    if (typeof deps.routeToWizardBind === "function") {
      deps.routeToWizardBind()
    } else if (typeof deps.routeToWizardService === "function") {
      deps.routeToWizardService()
    }
    return true
  }
  if (action === "ask-delete") {
    const actCell = row.querySelector("td.act") || row.querySelector(".act")
    if (!actCell) return false
    actCell.innerHTML = `
      <span class="confirm-inline">
        删除 <em>${escapeHtml(row.dataset.name)}</em>?
        <button class="btn ghost" data-action="cancel-delete">取消</button>
        <button class="btn danger-strong" data-action="confirm-delete">确定删除</button>
      </span>
    `
    return true
  }
  if (action === "cancel-delete") {
    const actCell = row.querySelector("td.act")
    const target = actCell || row.querySelector(".act")
    target.innerHTML = `<button class="mini-action" data-action="ask-delete">${icon("delete-02", { size: 13 })}删除</button>`
    return true
  }
  if (action === "confirm-delete") {
    const botId = row.dataset.botId
    const actCell = row.querySelector("td.act") || row.querySelector(".act")
    if (!actCell) return false
    actCell.innerHTML = `<span style="color: var(--ink-3); font-size: 11px;">删除中…</span>`
    row.classList.add("removing")
    setPending(`删除 ${row.dataset.name}…`)
    try {
      await deps.invoke("wechat_cli_json", { args: ["account", "remove", botId, "--json"] })
    } catch (err) {
      row.classList.remove("removing")
      actCell.innerHTML = `<button class="mini-action" data-action="ask-delete">删除</button>`
      setPending(`删除失败：${deps.formatInvokeError(err)}`)
      return true
    }
    setPending(deleteAccountConfirmCopy(row.dataset.name, deps.doctorPoller.current?.checks?.service))
    await deps.doctorPoller.refresh()
    return true
  }
  return false
}

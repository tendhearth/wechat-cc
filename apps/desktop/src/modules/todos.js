// @ts-check
/// <reference lib="dom" />
//
// todos.js — the 待办 workspace tab (2026-08-24, "客户回顾不如待办" feedback):
// a cross-contact view over the obligation facts the ingest pipeline already
// extracts from every 1:1 chat (facts.db, kind='obligation'). Unlike the
// per-run 客户回顾, this list maintains itself continuously and its dedup is
// the fact store's own: resolve/reject writes fact status, and a re-extracted
// identical promise merges into the resolved row instead of resurfacing.
//
// Same vanilla-module shape as converse.js: renderSkeleton once,
// refresh() re-fetches, actions call the admin internal-api routes.

import { escapeHtml, showToast } from "../view.js"
import { invokeApi } from "../api.js"
import { showPageError } from "./page-status.js"

/** @typedef {{ id: number, contact: string, kind: string|null, predicate: string, value: string, time_ref: string|null, confidence: string, updated_at: number }} ObligationRow */

let api = invokeApi
/** @type {(cmd: string, args: Record<string, unknown>) => Promise<unknown>} */
let invokeCli = async () => { throw new Error("not wired") }
let active = false
let generation = 0
/** @type {{ generation: number, queued: boolean }|null} */
let loading = null
// A late mutation must reconcile the current page without erasing a reminder draft.
let needsRefresh = false
/** One mutation per fact, shared by completion, correction and reminders.
 *  @type {Map<number, object>} */
const pendingFacts = new Map()
/** @typedef {{ pop: HTMLElement, factId: number, text: string, generation: number, posted: boolean, operation: object|null, cleanup: () => void }} ReminderPicker */
/** @type {ReminderPicker|null} */
let picker = null
/** @type {ReturnType<typeof setTimeout>|null} */
let outsideTimer = null
/** @type {ReturnType<typeof setTimeout>|null} */
let closeTimer = null

// ── pure helpers (unit-tested) ──────────────────────────────────────────

/** Group obligations by contact, newest activity first inside and across
 *  groups. @param {ObligationRow[]} rows @param {Map<string,string>} names */
export function groupObligations(rows, names) {
  /** @type {Map<string, { contact: string, display: string, items: ObligationRow[] }>} */
  const groups = new Map()
  for (const r of rows) {
    let g = groups.get(r.contact)
    if (!g) {
      g = { contact: r.contact, display: names.get(r.contact) ?? r.contact, items: [] }
      groups.set(r.contact, g)
    }
    g.items.push(r)
  }
  const out = [...groups.values()]
  for (const g of out) g.items.sort((a, b) => b.updated_at - a.updated_at)
  out.sort((a, b) => (b.items[0]?.updated_at ?? 0) - (a.items[0]?.updated_at ?? 0))
  return out
}

/** Recently settled obligations (auto or manual), for the 最近了结 block:
 *  last 7 days, newest first, capped. Exported for tests.
 *  @param {ObligationRow[]} rows @param {number} nowSec */
export function recentSettled(rows, nowSec) {
  const cutoff = nowSec - 7 * 86400
  return rows
    .filter(r => r.updated_at > cutoff)
    .sort((a, b) => b.updated_at - a.updated_at)
    .slice(0, 20)
}

/** Urgency badge from a fact's time_ref: the extractor writes a leading
 *  YYYY-MM-DD when the date was derivable (else a raw phrase like 「下周」,
 *  which gets no badge). Exported for tests.
 *  @param {string|null|undefined} timeRef @param {Date} now
 *  @returns {{ label: string, cls: string } | null} */
export function timeBadge(timeRef, now) {
  const m = timeRef?.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!m) return null
  const due = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const days = Math.round((due.getTime() - today.getTime()) / 86400000)
  if (days < 0) return { label: "逾期", cls: "overdue" }
  if (days === 0) return { label: "今天", cls: "today" }
  if (days === 1) return { label: "明天", cls: "soon" }
  return null
}

/** Quick reminder slots for the 提醒我 flow. Exported for tests.
 *  @param {Date} now */
export function reminderSlots(now) {
  const tonight = new Date(now); tonight.setHours(21, 0, 0, 0)
  const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(9, 30, 0, 0)
  const slots = []
  if (tonight.getTime() > now.getTime()) slots.push({ label: "今晚 21:00", at: tonight.toISOString() })
  slots.push({ label: "明早 9:30", at: tomorrow.toISOString() })
  return slots
}

// ── rendering ──────────────────────────────────────────────────────────

/** @param {ObligationRow} r */
function itemHtml(r) {
  const time = r.time_ref ? `<span class="todo-time">${escapeHtml(r.time_ref)}</span>` : ""
  const badge = timeBadge(r.time_ref, new Date())
  const badgeHtml = badge ? `<span class="todo-badge todo-badge-${badge.cls}">${badge.label}</span>` : ""
  return `<li class="todo-item" data-fact-id="${r.id}">
    <div class="todo-main">
      <p class="todo-text">${badgeHtml}<span class="todo-value">${escapeHtml(r.value)}</span></p>
      <div class="todo-meta">${escapeHtml(r.predicate)}${time ? " · " : ""}${time}</div>
    </div>
    <div class="todo-actions">
      <button class="btn todo-complete" type="button" data-todo-action="resolve" data-fact-id="${r.id}">完成</button>
      <details class="todo-more">
        <summary>更多</summary>
        <div class="todo-more-actions">
          <button class="btn ghost" type="button" data-todo-action="remind" data-fact-id="${r.id}">提醒我</button>
          <button class="btn ghost" type="button" data-todo-action="reject" data-fact-id="${r.id}">不是承诺</button>
        </div>
      </details>
    </div>
  </li>`
}

async function refresh() {
  const list = document.getElementById("todos-list")
  const meta = document.getElementById("todos-meta")
  if (!list || !active) return
  if (loading?.generation === generation) { loading.queued = true; return }
  needsRefresh = false
  const request = { generation, queued: false }
  loading = request
  // Reloading replaces the row that owns the reminder form.
  closeRemindPicker()
  try {
    const [factsResp, contactsResp, settledResp] = await Promise.all([
      /** @type {Promise<{ results?: ObligationRow[] }>} */ (api("POST", "/v1/knowledge/facts/find_facts", { kind: "obligation", status: "active", limit: 200 })),
      /** @type {Promise<{ contacts?: Array<{ username: string, display: string }> }>} */ (api("POST", "/v1/knowledge/graph/top_contacts", { by: "closeness", limit: 500 }).catch(() => ({ contacts: [] }))),
      /** @type {Promise<{ results?: ObligationRow[] }>} */ (api("POST", "/v1/knowledge/facts/find_facts", { kind: "obligation", status: "resolved", limit: 100 }).catch(() => ({ results: [] }))),
    ])
    if (!active || request.generation !== generation) return
    // A form may have been opened on the old rows while this read was pending.
    closeRemindPicker()
    const rows = factsResp.results ?? []
    const names = new Map((contactsResp.contacts ?? []).map(c => [c.username, c.display]))
    const settled = recentSettled(settledResp.results ?? [], Math.floor(Date.now() / 1000))
    if (meta) meta.textContent = rows.length ? `${rows.length === 200 ? "最近 " : ""}${rows.length} 条待办` : ""
    const settledHtml = settled.length === 0 ? "" : `
      <details class="todo-settled">
        <summary>最近了结 <span class="todo-count">${settled.length}</span></summary>
        <p class="todo-settled-note">聊天里说办好了会自动划掉，误划的可以恢复。</p>
        <ul>${settled.map(r => `<li class="todo-item todo-item-settled" data-fact-id="${r.id}">
          <div class="todo-main">
            <p class="todo-text">${escapeHtml(r.value)}</p>
            <div class="todo-meta">${escapeHtml(names.get(r.contact) ?? r.contact)}</div>
          </div>
          <div class="todo-actions">
            <button class="btn ghost" type="button" data-todo-action="revive" data-fact-id="${r.id}">恢复待办</button>
          </div>
        </li>`).join("")}</ul>
      </details>`
    if (rows.length === 0) {
      list.innerHTML = `<div class="todos-empty">
        <h2>还没有待办</h2>
        <p>聊天里整理出的约定会出现在这里。</p>
      </div>` + settledHtml
      syncPendingFacts()
      return
    }
    const groups = groupObligations(rows, names)
    list.innerHTML = groups.map(g => `
      <section class="todo-group">
        <h2>${escapeHtml(g.display)}<span class="todo-count">${g.items.length}</span></h2>
        <ul>${g.items.map(itemHtml).join("")}</ul>
      </section>
    `).join("") + settledHtml
    syncPendingFacts()
  } catch (err) {
    if (!active || request.generation !== generation) return
    closeRemindPicker()
    console.error("todos load failed", err)
    if (meta) meta.textContent = ""
    showPageError(list, {
      title: "暂时没能读取待办",
      description: "稍后再试一次，就能继续查看挂着的约定。",
      retry: refresh,
    })
  } finally {
    if (loading === request) loading = null
    if (active && request.generation === generation && request.queued) refresh().catch(() => {})
  }
}

async function resolveOwnerChatId() {
  // memory list is a contact array, not an ownership signal. Match the
  // daemon's resolveAdminChatId contract; a preferred chat must be an admin.
  const [status, access] = await Promise.all([
    /** @type {Promise<{ default_chat_id?: string|null }>} */ (api("GET", "/v1/companion/status")),
    /** @type {Promise<{ admins?: string[] }>} */ (invokeCli("wechat_cli_json", { args: ["access", "list", "--json"] })),
  ])
  const admins = (access.admins ?? []).filter(id => typeof id === "string" && id.length > 0)
  const preferred = status.default_chat_id
  return preferred && admins.includes(preferred) ? preferred : admins[0] ?? null
}

/** @param {number} factId @param {boolean} busy @param {Element|null} [item] */
function setFactBusy(factId, busy, item = document.querySelector(`.todo-item[data-fact-id="${factId}"]`)) {
  item?.querySelectorAll?.("button").forEach(button => {
    if (button instanceof HTMLButtonElement) button.disabled = busy
  })
  if (item instanceof HTMLElement) {
    if (busy) item.setAttribute?.("aria-busy", "true")
    else item.removeAttribute?.("aria-busy")
  }
}

function syncPendingFacts() {
  for (const id of pendingFacts.keys()) setFactBusy(id, true)
}

/** @param {number} factId @param {object} operation */
function finishFactOperation(factId, operation) {
  if (pendingFacts.get(factId) !== operation) return
  pendingFacts.delete(factId)
  if (active) setFactBusy(factId, false)
}

/** @param {ReminderPicker} current */
function isCurrentPicker(current) {
  return active && generation === current.generation && picker === current && current.pop.isConnected
}

function requestMutationRefresh() {
  if (!active) return
  if (picker) { needsRefresh = true; return }
  needsRefresh = false
  refresh().catch(() => {})
}

/** @param {ReminderPicker} current @param {string} message @param {boolean} [ok] */
function reminderFeedback(current, message, ok = false) {
  if (!isCurrentPicker(current)) return
  const status = current.pop.querySelector("[role=status]")
  if (status instanceof HTMLElement) {
    status.className = ok ? "todo-remind-ok" : "todo-remind-err"
    status.textContent = message
  }
}

/** @param {ReminderPicker} current @param {boolean} busy */
function setPickerBusy(current, busy) {
  current.pop.setAttribute("aria-busy", String(busy))
  current.pop.querySelectorAll("button,input").forEach(control => {
    if (control instanceof HTMLButtonElement || control instanceof HTMLInputElement) control.disabled = busy
  })
}

/** @param {HTMLElement} host @param {number} factId @param {string} text */
function openRemindPicker(host, factId, text) {
  closeRemindPicker()
  if (!active || pendingFacts.has(factId)) return
  const slots = reminderSlots(new Date())
  const pop = document.createElement("div")
  pop.className = "todo-remind-pop"
  pop.id = "todo-remind-pop"
  pop.innerHTML = `
    <div class="todo-remind-slots">${slots.map(s => `<button class="btn ghost" type="button" data-remind-at="${escapeHtml(s.at)}">${escapeHtml(s.label)}</button>`).join("")}</div>
    <div class="todo-remind-custom-row">
      <label class="todo-remind-custom" for="todo-remind-custom-input">自选时间 <input type="datetime-local" id="todo-remind-custom-input" /></label>
      <button class="btn ghost" type="button" id="todo-remind-custom-go">设定</button>
    </div>
    <p class="todo-remind-note" role="status" aria-live="polite"></p>
  `
  const more = host.closest("details")
  const onToggle = () => {
    if (more && !more.hasAttribute("open") && picker === current) closeRemindPicker()
  }
  const current = { pop, factId, text, generation, posted: false, operation: null,
    cleanup: () => { more?.removeEventListener("toggle", onToggle) } }
  more?.addEventListener("toggle", onToggle)
  picker = current
  host.appendChild(pop)
  pop.addEventListener("click", ev => {
    const target = ev.target
    if (!(target instanceof HTMLElement) || !isCurrentPicker(current)) return
    const button = target.closest("button")
    if (!(button instanceof HTMLButtonElement) || button.disabled) return
    let at = button.dataset.remindAt
    if (button.id === "todo-remind-custom-go") {
      const input = /** @type {HTMLInputElement|null} */ (pop.querySelector("#todo-remind-custom-input"))
      const date = new Date(input?.value ?? "")
      if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) {
        reminderFeedback(current, "请选择一个将来的时间。")
        return
      }
      at = date.toISOString()
    }
    if (at) scheduleReminder(current, at).catch(() => {})
  })
  // Attach after the opening click; the timer is owned by this picker.
  outsideTimer = setTimeout(() => {
    outsideTimer = null
    if (!isCurrentPicker(current)) return
    document.addEventListener("click", onOutsideRemindClick, true)
    document.addEventListener("keydown", onRemindKeydown, true)
  }, 0)
}

/** @param {Event} ev */
function onOutsideRemindClick(ev) {
  const pop = document.getElementById("todo-remind-pop")
  if (!pop) { closeRemindPicker(); return }
  const target = ev.target
  if (target instanceof Node && pop.contains(target)) return
  closeRemindPicker()
}

/** @param {KeyboardEvent} ev */
function onRemindKeydown(ev) {
  if (ev.key === "Escape") closeRemindPicker()
}

function closeRemindPicker() {
  if (outsideTimer !== null) clearTimeout(outsideTimer)
  if (closeTimer !== null) clearTimeout(closeTimer)
  outsideTimer = null
  closeTimer = null
  const current = picker
  picker = null
  current?.cleanup()
  if (current?.operation && !current.posted) finishFactOperation(current.factId, current.operation)
  document.getElementById("todo-remind-pop")?.remove()
  document.removeEventListener("click", onOutsideRemindClick, true)
  document.removeEventListener("keydown", onRemindKeydown, true)
  if (active && needsRefresh) {
    // Opening another picker also closes the old one. Let that synchronous
    // operation finish before deciding whether it is safe to replace the rows.
    queueMicrotask(() => {
      if (active && needsRefresh && !picker) requestMutationRefresh()
    })
  }
}

/** @param {ReminderPicker} current @param {string} atIso */
async function scheduleReminder(current, atIso) {
  if (!isCurrentPicker(current) || pendingFacts.has(current.factId)) return
  if (!Number.isFinite(Date.parse(atIso)) || Date.parse(atIso) <= Date.now()) {
    reminderFeedback(current, "请选择一个将来的时间。")
    return
  }
  const operation = {}
  current.operation = operation
  current.posted = false
  pendingFacts.set(current.factId, operation)
  setFactBusy(current.factId, true)
  setPickerBusy(current, true)
  reminderFeedback(current, "正在设定提醒…")
  let succeeded = false
  try {
    const chatId = await resolveOwnerChatId()
    // Leaving, refreshing or replacing the form while resolving the owner
    // must not create a reminder after the user has dismissed that form.
    if (!isCurrentPicker(current)) return
    if (!chatId) {
      reminderFeedback(current, "还没有确认接收提醒的微信，请先完成微信连接后再试。")
      return
    }
    current.posted = true
    const response = /** @type {{ ok?: boolean, error?: string }} */ (
      await api("POST", "/v1/reminders/schedule", { chat_id: chatId, text: `⏰ 待办：${current.text}`, due_at: atIso })
    )
    if (!isCurrentPicker(current)) return
    if (response.ok === false) {
      reminderFeedback(current, response.error === "too_many_pending"
        ? "待发送的提醒已满，请等已有提醒发出后再试。"
        : "这次没设上，请再试一次。")
      return
    }
    succeeded = true
    reminderFeedback(current, "到点会发微信提醒你。", true)
    closeTimer = setTimeout(() => {
      closeTimer = null
      if (isCurrentPicker(current)) closeRemindPicker()
    }, 1600)
  } catch {
    reminderFeedback(current, "暂时没能设定提醒，请再试一次。")
  } finally {
    finishFactOperation(current.factId, operation)
    if (current.operation === operation) current.operation = null
    if (isCurrentPicker(current)) setPickerBusy(current, succeeded)
  }
}

/** @param {MouseEvent} ev */
async function onListClick(ev) {
  const target = ev.target
  if (!(target instanceof HTMLElement)) return
  const btn = target.closest("[data-todo-action]")
  if (!(btn instanceof HTMLElement)) return
  if (btn instanceof HTMLButtonElement && btn.disabled) return
  const action = btn.dataset.todoAction
  const factId = Number(btn.dataset.factId)
  if (!Number.isFinite(factId) || pendingFacts.has(factId)) return
  const item = btn.closest(".todo-item")

  if (action === "remind") {
    const text = item?.querySelector(".todo-value")?.textContent ?? item?.querySelector(".todo-text")?.textContent ?? "跟进约定"
    const host = btn.closest(".todo-more-actions") ?? btn.closest(".todo-actions")
    if (host instanceof HTMLElement) openRemindPicker(host, factId, text)
    return
  }
  if (action !== "resolve" && action !== "reject" && action !== "revive") return
  const status = action === "resolve" ? "resolved" : action === "revive" ? "active" : "rejected"
  const operation = {}
  const actionGeneration = generation
  let refreshingItem = false
  pendingFacts.set(factId, operation)
  setFactBusy(factId, true, item)
  if (btn instanceof HTMLButtonElement) btn.disabled = true
  try {
    const response = /** @type {{ ok?: boolean }} */ (await api("POST", "/v1/knowledge/facts/set_fact_status", { id: factId, status }))
    if (actionGeneration !== generation) return
    if (response?.ok === false) {
      showToast("这条待办可能已经变了，请刷新后再试。")
      return
    }
    if (item instanceof HTMLElement) {
      refreshingItem = true
      item.classList.add("is-done")
      setTimeout(() => {
        if (active && actionGeneration === generation) requestMutationRefresh()
      }, 350)
    }
  } catch {
    if (actionGeneration === generation) showToast("暂时没能更新待办，请再试一次。")
  } finally {
    finishFactOperation(factId, operation)
    if (actionGeneration === generation) {
      setFactBusy(factId, refreshingItem, item)
      if (btn instanceof HTMLButtonElement) btn.disabled = refreshingItem
    } else if (active) {
      // The old row is gone, but the new page may still have read the fact
      // before the mutation finished. Keep it busy until an authoritative read.
      setFactBusy(factId, true)
      requestMutationRefresh()
    }
  }
}

/** Called by main when another pane is selected and on pagehide. */
export function deactivateTodosPage() {
  active = false
  generation++
  needsRefresh = false
  closeRemindPicker()
  loading = null
}

// Exported for tests — the ok:false-slips-through regression above is DOM-
// driven, so the test drives this handler with a stub event + api.
export { onListClick as __onListClick, onOutsideRemindClick as __onOutsideRemindClick }
/** @param {typeof invokeApi} fn */
export function __setApi(fn) { api = fn }

/**
 * Init the 待办 tab. Idempotent via dataset.ready (same shape as
 * converse.js).
 * @param {{ invoke: (cmd: string, args: Record<string, unknown>) => Promise<unknown> }} deps
 * @param {{ api?: typeof invokeApi }} [options]
 */
export function initTodosPage(deps, options) {
  if (options?.api) api = options.api
  invokeCli = deps.invoke
  const root = document.getElementById("todos-root")
  if (!root) return
  if (!active) { active = true; generation++ }
  if (root.dataset.ready !== "true") {
    root.dataset.ready = "true"
    root.innerHTML = `
      <header class="todos-head">
        <div>
          <h1>待办</h1>
          <p>聊天里约好的事，完成后划掉。</p>
          <p class="todos-meta" id="todos-meta"></p>
        </div>
        <button id="todos-refresh" class="btn ghost" type="button">刷新</button>
      </header>
      <div id="todos-list" class="todos-list"><p class="empty-state">加载中…</p></div>
    `
    root.querySelector("#todos-list")?.addEventListener("click", (ev) => {
      onListClick(/** @type {MouseEvent} */ (ev)).catch(err => console.error("todo action failed", err))
    })
    root.querySelector("#todos-refresh")?.addEventListener("click", () => { refresh().catch(() => {}) })
  }
  refresh().catch(() => {})
}

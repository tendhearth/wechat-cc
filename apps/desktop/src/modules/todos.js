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
// Same vanilla-module shape as customer-review.js: renderSkeleton once,
// refresh() re-fetches, actions call the admin internal-api routes.

import { escapeHtml, showToast } from "../view.js"
import { invokeApi } from "../api.js"

/** @typedef {{ id: number, contact: string, kind: string|null, predicate: string, value: string, time_ref: string|null, confidence: string, updated_at: number }} ObligationRow */

let api = invokeApi
/** @type {(cmd: string, args: Record<string, unknown>) => Promise<unknown>} */
let invokeCli = async () => { throw new Error("not wired") }
let loading = false
/** @type {string|null} */
let ownerChatId = null

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
      <p class="todo-text">${badgeHtml}${escapeHtml(r.value)}</p>
      <div class="todo-meta">${escapeHtml(r.predicate)}${time ? " · " : ""}${time}</div>
    </div>
    <div class="todo-actions">
      <button class="btn" data-todo-action="resolve" data-fact-id="${r.id}">完成</button>
      <button class="btn ghost" data-todo-action="remind" data-fact-id="${r.id}">提醒我</button>
      <button class="btn ghost" data-todo-action="reject" data-fact-id="${r.id}">不是承诺</button>
    </div>
  </li>`
}

async function refresh() {
  const list = document.getElementById("todos-list")
  const meta = document.getElementById("todos-meta")
  if (!list) return
  if (loading) return
  loading = true
  try {
    const [factsResp, contactsResp, settledResp] = await Promise.all([
      /** @type {Promise<{ results?: ObligationRow[] }>} */ (api("POST", "/v1/knowledge/facts/find_facts", { kind: "obligation", status: "active", limit: 200 })),
      /** @type {Promise<{ contacts?: Array<{ username: string, display: string }> }>} */ (api("POST", "/v1/knowledge/graph/top_contacts", { by: "closeness", limit: 500 }).catch(() => ({ contacts: [] }))),
      /** @type {Promise<{ results?: ObligationRow[] }>} */ (api("POST", "/v1/knowledge/facts/find_facts", { kind: "obligation", status: "resolved", limit: 100 }).catch(() => ({ results: [] }))),
    ])
    const rows = factsResp.results ?? []
    const names = new Map((contactsResp.contacts ?? []).map(c => [c.username, c.display]))
    const settled = recentSettled(settledResp.results ?? [], Math.floor(Date.now() / 1000))
    if (meta) meta.textContent = rows.length ? `${rows.length} 条没了结的承诺` : ""
    const settledHtml = settled.length === 0 ? "" : `
      <details class="todo-settled">
        <summary>最近了结 ${settled.length} 条 — 聊天里说办好了会自动划掉，误划可以捞回来</summary>
        <ul>${settled.map(r => `<li class="todo-item todo-item-settled" data-fact-id="${r.id}">
          <div class="todo-main">
            <p class="todo-text">${escapeHtml(r.value)}</p>
            <div class="todo-meta">${escapeHtml(names.get(r.contact) ?? r.contact)}</div>
          </div>
          <div class="todo-actions">
            <button class="btn ghost" data-todo-action="revive" data-fact-id="${r.id}">没办完，捞回</button>
          </div>
        </li>`).join("")}</ul>
      </details>`
    if (rows.length === 0) {
      list.innerHTML = `<div class="todos-empty">
        <h2>都了结了</h2>
        <p>你和朋友之间没有挂着的承诺。聊天里一旦出现新的约定，这里会自己长出来。</p>
      </div>` + settledHtml
      return
    }
    const groups = groupObligations(rows, names)
    list.innerHTML = groups.map(g => `
      <section class="todo-group">
        <h2>${escapeHtml(g.display)}<span class="todo-count">${g.items.length}</span></h2>
        <ul>${g.items.map(itemHtml).join("")}</ul>
      </section>
    `).join("") + settledHtml
  } catch (err) {
    list.innerHTML = `<p class="empty-state">待办读不出来：${escapeHtml(err instanceof Error ? err.message : String(err))}</p>`
  } finally {
    loading = false
  }
}

async function resolveOwnerChatId() {
  if (ownerChatId) return ownerChatId
  const resp = /** @type {{ users?: Array<{ userId: string }> }} */ (
    await invokeCli("wechat_cli_json", { args: ["memory", "list", "--json"] })
  )
  ownerChatId = resp.users?.[0]?.userId ?? null
  return ownerChatId
}

/** @param {HTMLElement} host @param {number} factId @param {string} text */
function openRemindPicker(host, factId, text) {
  closeRemindPicker()
  const slots = reminderSlots(new Date())
  const pop = document.createElement("div")
  pop.className = "todo-remind-pop"
  pop.id = "todo-remind-pop"
  pop.innerHTML = `
    ${slots.map(s => `<button class="btn ghost" data-remind-at="${escapeHtml(s.at)}">${escapeHtml(s.label)}</button>`).join("")}
    <label class="todo-remind-custom">自选 <input type="datetime-local" id="todo-remind-custom-input" /></label>
    <button class="btn" id="todo-remind-custom-go">定</button>
  `
  host.appendChild(pop)
  pop.addEventListener("click", async (ev) => {
    const t = ev.target
    if (!(t instanceof HTMLElement)) return
    const at = t.dataset.remindAt
      ?? (t.id === "todo-remind-custom-go"
        ? (() => {
            const input = /** @type {HTMLInputElement|null} */ (document.getElementById("todo-remind-custom-input"))
            return input?.value ? new Date(input.value).toISOString() : undefined
          })()
        : undefined)
    if (!at) return
    await scheduleReminder(factId, text, at, pop)
  })
  // 点选择器以外的地方 / 按 Esc → 自动关掉(改了主意时能收起来)。延到下一个
  // tick 再挂,免得把「提醒我」这次点击本身当成外部点击、刚开就被关掉。
  setTimeout(() => {
    document.addEventListener("click", onOutsideRemindClick, true)
    document.addEventListener("keydown", onRemindKeydown, true)
  }, 0)
}

/** @param {Event} ev */
function onOutsideRemindClick(ev) {
  const pop = document.getElementById("todo-remind-pop")
  if (!pop) { closeRemindPicker(); return }        // 已经没了,顺手摘监听
  const target = ev.target
  if (target instanceof Node && pop.contains(target)) return   // 点在选择器内,忽略
  closeRemindPicker()
}

/** @param {KeyboardEvent} ev */
function onRemindKeydown(ev) {
  if (ev.key === "Escape") closeRemindPicker()
}

function closeRemindPicker() {
  document.getElementById("todo-remind-pop")?.remove()
  document.removeEventListener("click", onOutsideRemindClick, true)
  document.removeEventListener("keydown", onRemindKeydown, true)
}

/** @param {number} factId @param {string} text @param {string} atIso @param {HTMLElement} pop */
async function scheduleReminder(factId, text, atIso, pop) {
  try {
    const chatId = await resolveOwnerChatId()
    if (!chatId) { pop.innerHTML = `<span class="todo-remind-err">找不到你的聊天 — 先在微信里跟 bot 说句话</span>`; return }
    const r = /** @type {{ ok?: boolean, error?: string }} */ (
      await api("POST", "/v1/reminders/schedule", { chat_id: chatId, text: `⏰ 待办：${text}`, due_at: atIso })
    )
    if (r.ok === false) { pop.innerHTML = `<span class="todo-remind-err">没定上：${escapeHtml(r.error ?? "unknown")}</span>`; return }
    pop.innerHTML = `<span class="todo-remind-ok">✓ 到点会发微信提醒你</span>`
    setTimeout(closeRemindPicker, 1600)
  } catch (err) {
    pop.innerHTML = `<span class="todo-remind-err">没定上：${escapeHtml(err instanceof Error ? err.message : String(err))}</span>`
  }
}

/** @param {MouseEvent} ev */
async function onListClick(ev) {
  const target = ev.target
  if (!(target instanceof HTMLElement)) return
  const btn = target.closest("[data-todo-action]")
  if (!(btn instanceof HTMLElement)) return
  const action = btn.dataset.todoAction
  const factId = Number(btn.dataset.factId)
  if (!Number.isFinite(factId)) return
  const item = btn.closest(".todo-item")

  if (action === "remind") {
    const text = item?.querySelector(".todo-text")?.textContent ?? "跟进承诺"
    const actions = btn.closest(".todo-actions")
    if (actions instanceof HTMLElement) openRemindPicker(actions, factId, text)
    return
  }
  // resolve / reject / revive — fact-status writes; the fact store's merge
  // semantics make resolve/reject permanent (an identical re-extraction
  // merges, never revives), while revive is the owner's undo for a
  // mis-settled promise (auto or manual) — back to active, back on the list.
  const status = action === "resolve" ? "resolved" : action === "revive" ? "active" : "rejected"
  if (btn instanceof HTMLButtonElement) btn.disabled = true
  try {
    const r = /** @type {{ ok?: boolean }} */ (await api("POST", "/v1/knowledge/facts/set_fact_status", { id: factId, status }))
    if (r && r.ok === false) {
      // 200 但底层没改成(这条 fact 可能已被合并/删除)—— 别假装划掉了,
      // 否则会「闪一下完成又弹回来」。和 scheduleReminder 一样检查 ok。
      if (btn instanceof HTMLButtonElement) btn.disabled = false
      showToast("没改成：这条可能已经变了,刷新看看")
      return
    }
    if (item instanceof HTMLElement) {
      item.classList.add("is-done")
      setTimeout(() => { refresh().catch(() => {}) }, 350)
    }
  } catch (err) {
    if (btn instanceof HTMLButtonElement) btn.disabled = false
    showToast(`没改成：${err instanceof Error ? err.message : String(err)}`)
  }
}

// Exported for tests — the ok:false-slips-through regression above is DOM-
// driven, so the test drives this handler with a stub event + api.
export { onListClick as __onListClick, onOutsideRemindClick as __onOutsideRemindClick }
/** @param {typeof invokeApi} fn */
export function __setApi(fn) { api = fn }

/**
 * Init the 待办 tab. Idempotent via dataset.ready (same shape as
 * customer-review.js / converse.js).
 * @param {{ invoke: (cmd: string, args: Record<string, unknown>) => Promise<unknown> }} deps
 * @param {{ api?: typeof invokeApi }} [options]
 */
export function initTodosPage(deps, options) {
  if (options?.api) api = options.api
  invokeCli = deps.invoke
  const root = document.getElementById("todos-root")
  if (!root) return
  if (root.dataset.ready !== "true") {
    root.dataset.ready = "true"
    root.innerHTML = `
      <header class="todos-head">
        <div>
          <h1>待办</h1>
          <p>聊天里答应过、约好过的事 — 自动整理，完成就划掉。<span class="meta" id="todos-meta"></span></p>
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

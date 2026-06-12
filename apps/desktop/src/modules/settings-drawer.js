// @ts-check
/// <reference lib="dom" />

// Settings drawer — slides in from the right; contains 后台服务 +
// 行为 + 项目管理 sections. Toggles in here previously lived in the
// wizard step 4. CSS uses .is-open (not the [hidden] attribute) because
// the global [hidden] { display: none !important } would defeat
// the transition.

import { escapeHtml } from "../view.js"
import { readFavorites, toggleFavorite, deleteProjectByAlias } from "./sessions.js"
import { icon } from "./icons.js"

let listenersAttached = false
/** @type {{ invoke: (cmd: string, args: Record<string, unknown>) => Promise<unknown> }|null} */
let projectsDeps = null
// Two-step inline delete confirm — alias armed on first click, committed on
// second click within 3s (no native confirm() popups, per design language).
/** @type {string|null} */
let pendingDeleteAlias = null
/** @type {ReturnType<typeof setTimeout>|null} */
let pendingDeleteTimer = null

export function openSettingsDrawer() {
  const drawer = document.getElementById("settings-drawer")
  if (!drawer) return
  drawer.classList.add("is-open")
  // Refresh the 项目管理 list each open so favorites / new projects show.
  if (projectsDeps) loadProjectsAdmin(projectsDeps).catch(err => console.error("projects admin load failed", err))
}

/**
 * @typedef {{ alias: string, last_used_at: string, summary?: string|null }} ProjectEntry
 */

/**
 * Render the 项目管理 list — one row per project with a favorite-star toggle
 * and a two-step delete button. Reuses sessions.js's favorites + delete.
 * @param {{ invoke: (cmd: string, args: Record<string, unknown>) => Promise<unknown> }} deps
 */
async function loadProjectsAdmin(deps) {
  const list = document.getElementById("projects-admin-list")
  if (!list) return
  try {
    const resp = /** @type {any} */ (await deps.invoke("wechat_cli_json", { args: ["sessions", "list-projects", "--json"] }))
    /** @type {ProjectEntry[]} */
    const projects = (resp && resp.projects) || []
    if (projects.length === 0) {
      list.innerHTML = `<p class="empty-state">还没有项目会话。</p>`
      return
    }
    const favorites = readFavorites()
    // Favorites first, then by recency.
    projects.sort((a, b) => {
      const fa = favorites.has(a.alias) ? 0 : 1
      const fb = favorites.has(b.alias) ? 0 : 1
      if (fa !== fb) return fa - fb
      return a.last_used_at < b.last_used_at ? 1 : -1
    })
    list.innerHTML = projects.map(p => projectAdminRow(p, favorites.has(p.alias))).join("")
  } catch (err) {
    list.innerHTML = `<p class="empty-state">读取失败：${escapeHtml(err instanceof Error ? err.message : String(err))}</p>`
  }
}

/** @param {ProjectEntry} p @param {boolean} isFav */
function projectAdminRow(p, isFav) {
  const alias = escapeHtml(p.alias)
  const armed = pendingDeleteAlias === p.alias
  return `<div class="project-admin-row${isFav ? " is-favorite" : ""}" data-alias="${alias}">
    <button class="project-admin-star" data-action="toggle-favorite" data-alias="${alias}" type="button" aria-label="${isFav ? "取消收藏" : "收藏"}" title="${isFav ? "取消收藏" : "收藏"}">${isFav ? "★" : "☆"}</button>
    <span class="project-admin-alias">${alias}</span>
    <button class="project-admin-del${armed ? " is-confirming" : ""}" data-action="delete-project" data-alias="${alias}" type="button" aria-label="删除">${armed ? "再点确认" : icon("delete-02", { size: 16 })}</button>
  </div>`
}

/**
 * Handle a click inside the 项目管理 list (delegated).
 * @param {{ invoke: (cmd: string, args: Record<string, unknown>) => Promise<unknown> }} deps
 * @param {Event} ev
 */
async function handleProjectsAdminClick(deps, ev) {
  // NB: use Element (not HTMLElement) — clicks can land on the inline <svg>
  // icon inside the delete button, and SVG nodes are SVGElement, not
  // HTMLElement. closest() is defined on Element, so it climbs to the button.
  const target = ev.target instanceof Element ? ev.target : null
  if (!target) return
  const favBtn = target.closest("[data-action='toggle-favorite']")
  if (favBtn instanceof HTMLElement && favBtn.dataset.alias) {
    toggleFavorite(favBtn.dataset.alias)
    await loadProjectsAdmin(deps)
    return
  }
  const delBtn = target.closest("[data-action='delete-project']")
  if (delBtn instanceof HTMLElement && delBtn.dataset.alias) {
    const alias = delBtn.dataset.alias
    if (pendingDeleteAlias === alias) {
      // Confirm.
      if (pendingDeleteTimer !== null) clearTimeout(pendingDeleteTimer)
      pendingDeleteAlias = null
      pendingDeleteTimer = null
      try {
        await deleteProjectByAlias(deps, alias)
      } catch (err) {
        console.error("delete project failed", err)
      }
      await loadProjectsAdmin(deps)
      return
    }
    // Arm.
    pendingDeleteAlias = alias
    if (pendingDeleteTimer !== null) clearTimeout(pendingDeleteTimer)
    pendingDeleteTimer = setTimeout(() => {
      pendingDeleteAlias = null
      pendingDeleteTimer = null
      loadProjectsAdmin(deps).catch(() => {})
    }, 3000)
    await loadProjectsAdmin(deps)
  }
}

export function closeSettingsDrawer() {
  const drawer = document.getElementById("settings-drawer")
  if (!drawer) return
  drawer.classList.remove("is-open")
}

/**
 * Attach drawer event handlers. Safe to call multiple times — only
 * the first call wires.
 *
 * @param {{ onToggleChange: (id: string, on: boolean) => void, deps?: { invoke: (cmd: string, args: Record<string, unknown>) => Promise<unknown> } }} opts
 */
export function wireSettingsDrawer(opts) {
  if (listenersAttached) return
  listenersAttached = true

  // Capture deps for the 项目管理 list (loaded lazily on drawer open).
  projectsDeps = opts.deps ?? null
  if (projectsDeps) {
    const d = projectsDeps
    document.getElementById("projects-admin-list")?.addEventListener("click", (ev) => {
      handleProjectsAdminClick(d, ev).catch(err => console.error("projects admin click failed", err))
    })
  }

  document.getElementById("settings-close")?.addEventListener("click", closeSettingsDrawer)

  // ESC closes drawer when open.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return
    const drawer = document.getElementById("settings-drawer")
    if (drawer && drawer.classList.contains("is-open")) closeSettingsDrawer()
  })

  // Outside-click closes drawer. The check excludes #settings-open
  // (otherwise opening the drawer immediately closes it).
  document.addEventListener("click", (e) => {
    const drawer = document.getElementById("settings-drawer")
    if (!drawer || !drawer.classList.contains("is-open")) return
    const target = /** @type {HTMLElement | null} */ (e.target instanceof HTMLElement ? e.target : null)
    if (!target) return
    if (drawer.contains(target)) return
    if (target.closest("#settings-open")) return
    closeSettingsDrawer()
  })

  // Toggle clicks inside the drawer — flip aria-pressed + .on, then
  // notify caller for persistence side effects.
  document.querySelectorAll("#settings-drawer [data-toggle]").forEach((el) => {
    el.addEventListener("click", () => {
      const pressed = el.getAttribute("aria-pressed") === "true"
      const next = !pressed
      el.setAttribute("aria-pressed", String(next))
      el.classList.toggle("on", next)
      opts.onToggleChange(el.id, next)
    })
  })
}

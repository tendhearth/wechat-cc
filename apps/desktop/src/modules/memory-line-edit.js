// @ts-check
/// <reference lib="dom" />

// 记忆改了就算数(设计稿 docs/superpowers/specs/2026-10-23-memory-edits-stick-design.md)—— 桌面这一半。
//
// 主人的 _overview.md / memory.md / owner.md 不再整份覆盖:`wechat-cc memory view` 给一份带键的行,
// 编辑器一行一个输入框(键跟着行走,不靠前端做文本比对),保存时把行原样带键交回 `wechat-cc memory edit`,
// daemon 按键判断哪行是删、是改、是新加的。别人对话里的记忆照旧走整份 `memory write`。
//
// 业务上的拒绝(view 之后被改过 / 键过期 / 一次删太多 / 太长)是 ok:false + code,CLI 在 --json 下照常退出 0。

import { escapeHtml } from "../view.js"

/** @typedef {{ correctionId: string, text: string }} Replaces */
/** @typedef {{ text: string, origin: 'generated'|'owner', lineKey?: string, assertionId?: string, editedAt?: string, replaces?: Replaces }} ViewLine */
/** @typedef {{ ok: true, chatId: string, path: string, baseHash: string, generatedAt: string|null, stale: boolean, lines: ViewLine[] }} MemoryView */
/** @typedef {{ text: string, lineKey?: string, assertionId?: string }} EditLine */
/** @typedef {{ status: 'saved'|'reload'|'confirm'|'bad', message: string }} SaveOutcome */

export const LINE_EDITABLE_PATHS = ["_overview.md", "memory.md", "owner.md"]

/**
 * 生成物:只由合成写,整份 `memory write` 一律被拒(记忆编辑第 4 步)。和 src/lib/memory-artifacts.ts 里 kind: 'derived' 那几份对齐。
 * @param {string} path
 */
export function isDerivedMemoryPath(path) {
  return DERIVED_MEMORY_PATHS.includes(path)
}
export const DERIVED_MEMORY_PATHS = ["_overview.md", "_profile.json", "portrait.svg", "portrait.json", "knowledge.md"]

/** @param {string} path */
export function isLineEditablePath(path) {
  return LINE_EDITABLE_PATHS.includes(path)
}

/**
 * view 只认主人那一份:它回的 chatId 和当前打开的对话对得上,才用逐行编辑。
 * @param {unknown} result
 * @param {string} userId
 * @returns {MemoryView|null}
 */
export function lineViewFor(result, userId) {
  const r = /** @type {Partial<MemoryView>|null} */ (result)
  if (!r || r.ok !== true || typeof r.chatId !== "string" || r.chatId !== userId) return null
  if (typeof r.baseHash !== "string" || !Array.isArray(r.lines)) return null
  return /** @type {MemoryView} */ (r)
}

/**
 * @param {string} path
 * @param {string} baseHash
 * @param {EditLine[]} lines
 * @param {boolean} confirmBulk
 */
export function memoryEditArgs(path, baseHash, lines, confirmBulk) {
  const json = JSON.stringify(lines)
  const b64 = btoa(unescape(encodeURIComponent(json)))
  return ["memory", "edit", path, "--base", baseHash, "--lines-base64", b64, ...(confirmBulk ? ["--confirm-bulk"] : []), "--json"]
}

/**
 * 只读时 memory.md 顶上那一块「你写的」。总览里那一节由 daemon 写进文件、owner.md 本身就是这些行,都不用再画。
 * @param {MemoryView} view
 */
export function renderOwnerBlock(view) {
  if (view.path !== "memory.md") return ""
  const own = view.lines.filter(l => l.origin === "owner")
  if (!own.length) return ""
  return `<section class="memory-owner-block"><h3>你写的</h3><ul>${own.map(l => `<li>${escapeHtml(l.text)} <span class="memory-owned-tag">你改过</span></li>`).join("")}</ul></section>`
}

/** @param {ViewLine} line */
function rowHtml(line) {
  const owned = line.origin === "owner"
  const keyAttr = line.assertionId ? ` data-assertion-id="${escapeHtml(line.assertionId)}"` : line.lineKey ? ` data-line-key="${escapeHtml(line.lineKey)}"` : ""
  const was = owned && line.replaces ? `<div class="memory-line-was">原来是:${escapeHtml(line.replaces.text)}</div>` : ""
  return `<li class="memory-line"${keyAttr}>
    <input class="memory-line-input" type="text" value="${escapeHtml(line.text)}" aria-label="一行记忆">
    ${owned ? `<span class="memory-owned-tag">你改过</span>` : ""}
    <button type="button" class="btn ghost memory-line-remove" aria-label="删掉这一行">删掉</button>
    ${was}
  </li>`
}

/**
 * @param {HTMLElement} root
 * @param {MemoryView} view
 */
export function renderLineEditor(root, view) {
  const hint = view.path === "_overview.md"
    ? "删掉或改掉的那一行,CC 会当成说错了,源头里的也一起清掉;新加的是你亲口说的,以后整理都不会改它。"
    : "删掉或改掉的那一行,CC 会当成说错了;新加的是你亲口说的,以后整理都不会改它。"
  root.innerHTML = `<p class="memory-line-hint">${hint}</p>
    <ul class="memory-lines">${view.lines.map(rowHtml).join("")}</ul>
    <button type="button" class="btn ghost memory-line-add">加一行</button>`
  // onclick 而不是 addEventListener:同一个容器每次打开都重画,别越挂越多。
  root.onclick = ev => {
    const target = /** @type {HTMLElement} */ (ev.target)
    if (target.closest(".memory-line-remove")) { target.closest(".memory-line")?.remove(); return }
    if (target.closest(".memory-line-add")) {
      const list = root.querySelector(".memory-lines")
      // 新行不带键、也还不标「你改过」:保存以后它才成为主人原话
      list?.insertAdjacentHTML("beforeend", rowHtml({ text: "", origin: "generated" }))
      const inputs = root.querySelectorAll(".memory-line-input")
      const last = /** @type {HTMLInputElement|undefined} */ (inputs[inputs.length - 1])
      last?.focus()
    }
  }
}

/**
 * 编辑器里剩下的行,原样带键交回;新加的空行不交。
 * @param {HTMLElement} root
 * @returns {EditLine[]}
 */
export function collectLines(root) {
  /** @type {EditLine[]} */
  const out = []
  root.querySelectorAll(".memory-line").forEach(el => {
    const li = /** @type {HTMLElement} */ (el)
    const input = /** @type {HTMLInputElement|null} */ (li.querySelector(".memory-line-input"))
    const text = input ? input.value : ""
    const lineKey = li.dataset.lineKey
    const assertionId = li.dataset.assertionId
    if (!lineKey && !assertionId && !text.trim()) return
    out.push({ text, ...(lineKey ? { lineKey } : {}), ...(assertionId ? { assertionId } : {}) })
  })
  return out
}

/**
 * @param {EditLine[]} lines
 * @param {MemoryView} view
 */
export function linesUnchanged(lines, view) {
  if (lines.length !== view.lines.length) return false
  return lines.every((l, i) => {
    const v = view.lines[i]
    return !!v && l.text === v.text && l.lineKey === v.lineKey && l.assertionId === v.assertionId
  })
}

/**
 * 大批确认只对提示时那组行有效:这次交的行和当时记下的一字不差,才带 --confirm-bulk;否则当成新的第一次。
 * @param {string|null} confirmedFor 上次提示时记下的那组行(JSON)
 * @param {EditLine[]} lines 这次要交的行
 */
export function bulkGate(confirmedFor, lines) {
  const snapshot = JSON.stringify(lines)
  return { snapshot, confirmBulk: confirmedFor !== null && confirmedFor === snapshot }
}

/** @param {{ deleted?: number, rewritten?: number, count?: number }} r */
export function bulkConfirmText(r) {
  const deleted = Number(r.deleted) || 0
  const rewritten = Number(r.rewritten) || 0
  const parts = [deleted ? `删掉 ${deleted} 条` : "", rewritten ? `改写 ${rewritten} 条` : ""].filter(Boolean)
  return `这次要${parts.join("、") || `改 ${Number(r.count) || 0} 条`}。CC 会把旧的当成说错了,源头里的也一起清掉。确定的话再点一次「保存」。`
}

/**
 * `memory edit` 的回包 ⇒ 桌面怎么办。
 * @param {unknown} result
 * @returns {SaveOutcome}
 */
export function editOutcome(result) {
  const r = /** @type {{ ok?: boolean, code?: string, corrections?: unknown[], assertions?: unknown[], limit?: { lines?: number, bytes?: number, lineChars?: number }, deleted?: number, rewritten?: number, count?: number }|null} */ (result)
  if (r && r.ok === true) {
    const c = Array.isArray(r.corrections) ? r.corrections.length : 0
    const a = Array.isArray(r.assertions) ? r.assertions.length : 0
    const parts = [c ? `${c} 条当成说错了` : "", a ? `${a} 条记成你说的` : ""].filter(Boolean)
    return { status: "saved", message: parts.length ? `已保存:${parts.join(",")}。总览会在下次整理时更新。` : "内容未改动" }
  }
  switch (r?.code) {
    case "memory_changed":
    case "memory_edit_stale_key":
      return { status: "reload", message: "CC 刚整理过这份记忆,你的改动没存上。内容已经刷新,再改一次。" }
    case "memory_edit_bulk":
      return { status: "confirm", message: bulkConfirmText(r) }
    case "memory_edit_too_large": {
      const lim = r.limit || {}
      return { status: "bad", message: `一次改得太多了(最多 ${lim.lines ?? 200} 行,每行 ${lim.lineChars ?? 500} 字以内),分几次改。` }
    }
    case "memory_no_owner":
      return { status: "bad", message: "还没绑定微信主人,这份记忆现在不能改。" }
    case "daemon_required":
    case "daemon_unreachable":
      return { status: "bad", message: "需要守护进程运行后才能保存" }
    default:
      return { status: "bad", message: `保存失败:${r?.code || "unknown"}` }
  }
}

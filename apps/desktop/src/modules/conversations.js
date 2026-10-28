// @ts-check
/// <reference lib="dom" />
// Conversations module — RFC 03 P5.2 mode display + programmatic switch.
// Owns the dashboard's per-chat mode table (#conversations-body,
// #conversations-meta). Mode can now be flipped from the console via
// the dropdown — POST /v1/conversation/set-mode (架构终态 F6;以前起 `wechat-cc mode set`,那条 CLI 本身也只是转发这一条)
// through the same coordinator.setMode path that /cc /codex use, plus a wechat
// reply "🎛 已切换到 X（来自控制台）".
//
// Rendering is driven by a periodic GET /v1/conversations/list
// poll (10s tick). Dropdown onChange fires immediately; poller picks up the
// new persisted mode on next tick.

import { conversationRows, escapeHtml } from "../view.js"
import { V1, v1 } from "../daemon-client.js"

/**
 * 下拉框的简写 ⇒ 完整的 Mode(搬自 `wechat-cc mode set` 的 SHORTHAND,一字不差;不认识的照旧当 JSON 解析)。
 * @param {string} shorthand
 * @returns {Record<string, unknown>}
 */
export function modeFromShorthand(shorthand) {
  /** @type {Record<string, Record<string, unknown>>} */
  const SHORTHAND = {
    cc: { kind: "solo", provider: "claude" },
    codex: { kind: "solo", provider: "codex" },
    solo: { kind: "solo", provider: "claude" },
    both: { kind: "parallel" },
    chat: { kind: "chatroom" },
  }
  const known = SHORTHAND[shorthand]
  if (known) return known
  const parsed = JSON.parse(shorthand)
  if (typeof parsed !== "object" || parsed === null) throw new Error(`unrecognised mode '${shorthand}'`)
  return parsed
}

// Map badge.tone → the closest shorthand for pre-selecting the dropdown.
// parallel → both, primary_tool → primary (no clean shorthand, use cc as fallback).
/** @param {any} mode */
function modeToShorthand(mode) {
  if (!mode || typeof mode !== "object") return "cc"
  if (mode.kind === "solo") return mode.provider === "codex" ? "codex" : "cc"
  if (mode.kind === "parallel") return "both"
  if (mode.kind === "chatroom") return "chat"
  if (mode.kind === "primary_tool") return mode.primary === "codex" ? "codex" : "cc"
  return "cc"
}

// Truncate long opaque ids (wxid_xxxx, gh_xxxx) so the table stays scannable.
// Full value is preserved in `title` attributes for hover-to-reveal.
/**
 * @param {string} s
 * @param {number} n
 */
function truncate(s, n) {
  if (!s) return ""
  return s.length > n ? `${s.slice(0, n)}…` : s
}

/**
 * @param {{ conversations?: any[] } | null | undefined} report
 * @param {{ invokeApi?: (method: 'GET' | 'POST', path: string, body?: Record<string, unknown>) => Promise<unknown> } | undefined} deps
 */
export function renderConversations(report, deps) {
  const tbody = document.getElementById("conversations-body")
  const meta = document.getElementById("conversations-meta")
  if (!tbody) return
  const rows = conversationRows(report?.conversations || [])
  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="2" style="padding: 16px; text-align: center; color: var(--ink-3);">暂无会话 — 用户首次发消息后会出现。</td></tr>`
    if (meta) meta.textContent = "0 个会话"
    return
  }
  const conversations = report?.conversations || []
  tbody.innerHTML = rows.map(row => {
    const conv = conversations.find((/** @type {any} */ c) => c.chat_id === row.chatId)
    const currentShorthand = conv ? modeToShorthand(conv.mode) : "cc"
    // 用户列 = 显示名 + 截短 wxid（hover 看完整）。账号列在 v0.5.6 删了：
    // 1-用户-1-bot 是常规设置，bot 路由对人来说是冗余信息。需要查 bot 账号
    // 时去上方"绑定账号"卡片看（按显示名排列，更友好）。
    const userIdShort = truncate(row.userId || "", 10)
    const userCell = row.userName
      ? `${escapeHtml(row.userName)} <span class="dim" title="${escapeHtml(row.userId || "")}">(${escapeHtml(userIdShort)})</span>`
      : `<span class="dim" title="${escapeHtml(row.userId || "")}">(等待识别) ${escapeHtml(userIdShort)}</span>`
    // 模式选项用人话,不写斜杠命令:多家同答 / 圆桌从 10-21 起只在桌面上开(微信去掉了 /both /chat)
    return `
    <tr title="chat: ${escapeHtml(row.chatId)}">
      <td class="name">${userCell}</td>
      <td>
        <select class="mode-select mode-${row.badge.tone}" data-chat-id="${escapeHtml(row.chatId)}" data-current="${escapeHtml(currentShorthand)}">
          <option value="cc"${currentShorthand === "cc" ? " selected" : ""}>Claude 单独回</option>
          <option value="codex"${currentShorthand === "codex" ? " selected" : ""}>Codex 单独回</option>
          <option value="both"${currentShorthand === "both" ? " selected" : ""}>两家同时回</option>
          <option value="chat"${currentShorthand === "chat" ? " selected" : ""}>几家一起讨论</option>
        </select>${row.badge.tone === "solo" ? "" : `
        <span class="mode-detail">${escapeHtml(row.badge.detail)}</span>`}
      </td>
    </tr>
  `
  }).join("")
  if (meta) meta.textContent = `${rows.length} 个会话`

  // Wire change handlers for mode-select dropdowns.
  tbody.querySelectorAll("select.mode-select").forEach(sel => {
    sel.addEventListener("change", async (ev) => {
      const select = /** @type {HTMLSelectElement} */ (ev.currentTarget)
      const chatId = select.dataset.chatId
      const newMode = select.value
      const prevMode = /** @type {string} */ (select.dataset.current)

      // Optimistic UI: update the select's tone class immediately.
      /** @type {Record<string, string>} */
      const toneMap = { cc: "solo", codex: "solo", both: "parallel", chat: "chatroom" }
      select.className = `mode-select mode-${toneMap[newMode] || "solo"}`

      if (!deps?.invokeApi || !chatId) return

      try {
        await v1(deps.invokeApi, V1.conversation.setMode, { body: { chatId, mode: modeFromShorthand(newMode) } })
        // Success: update current shorthand so next change event has a correct prev value.
        select.dataset.current = newMode
      } catch (err) {
        // Failure: revert to previous selection + show error border.
        select.value = prevMode
        select.className = `mode-select mode-${toneMap[prevMode] || "solo"} mode-select-error`
        // Clear error indication after 3s.
        setTimeout(() => {
          select.classList.remove("mode-select-error")
        }, 3000)
      }
    })
  })
}

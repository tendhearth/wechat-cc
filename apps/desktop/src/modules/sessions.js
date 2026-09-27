// @ts-check
/// <reference lib="dom" />
/** @typedef {import('../../../../src/cli/schema').SessionsDeleteOutputT} SessionsDelete */
/** @typedef {import('../../../../src/cli/schema').AvatarInfoOutputT} AvatarInfo */
/**
 * @typedef {{ invoke: (cmd: string, args: Record<string, unknown>) => Promise<unknown> }} Deps
 */

// Shared helpers left over from the old 「会话」 pane.
//
// 2026-09-27:旧「会话」pane 的 DOM(#sessions-detail / #sessions-body /
// #sessions-sidebar …)2026-06-04 bb47712e 就删了,对应的列表 / 详情 / 搜索 /
// turnHtml 渲染路径同日死,只是文件还留着(1404 行)。本次只留下还有人用的
// 六个导出:dialogue-page.js 用 attachmentUrl / avatarInitial / avatarInfo,
// settings-drawer.js 用 readFavorites / toggleFavorite / deleteProjectByAlias。
// 要找旧渲染代码看 git history。

const FAV_STORAGE_KEY = 'wechat-cc:favorite-sessions'

/**
 * Append `--chat <chatId>` to a sessions CLI arg list when chatId is set.
 * @param {string[]} args
 * @param {string|null|undefined} chatId
 * @returns {string[]}
 */
function withChat(args, chatId) {
  return chatId ? [...args, "--chat", chatId] : args
}

/**
 * Default-avatar initial — first non-whitespace char of the name,
 * uppercased for Latin scripts so "alice" → "A". CJK passes through.
 * @param {string|null|undefined} name
 * @returns {string}
 */
export function avatarInitial(name) {
  if (!name) return '?'
  const trimmed = String(name).trim()
  if (!trimmed) return '?'
  const ch = trimmed.charAt(0)
  return /[a-zA-Z]/.test(ch) ? ch.toUpperCase() : ch
}

export function readFavorites() {
  try {
    return new Set(JSON.parse(localStorage.getItem(FAV_STORAGE_KEY) || '[]'))
  } catch { return new Set() }
}

/** @param {string} alias */
export function toggleFavorite(alias) {
  const favs = readFavorites()
  if (favs.has(alias)) favs.delete(alias)
  else favs.add(alias)
  localStorage.setItem(FAV_STORAGE_KEY, JSON.stringify([...favs]))
}

/**
 * Look up a custom avatar for a contact key. Never throws — a missing or
 * failing avatar CLI just means the chat falls back to the letter avatar.
 * @param {Deps} deps
 * @param {string} key
 * @returns {Promise<{ exists: boolean, path: string }|null>}
 */
export async function avatarInfo(deps, key) {
  try {
    const r = /** @type {AvatarInfo} */ (await deps.invoke("wechat_cli_json", { args: ["avatar", "info", key, "--json"] }))
    if (r && r.ok) return { exists: !!r.exists, path: String(r.path || '') }
    return null
  } catch { return null }
}

// Resolve a local-fs path to a URL the browser can fetch. In Tauri the
// asset protocol does this via convertFileSrc; in the dev shim we route
// through a /attachment endpoint. Keep both paths stub-tolerant — if
// neither is available, the <img> fails gracefully (broken icon).
//
// Exported so dialogue-page.js shares the SAME implementation — production
// Tauri has NO /attachment HTTP handler, so a bare /attachment builder
// would silently break custom avatars in the packaged app.
/** @param {string} path @returns {string} */
export function attachmentUrl(path) {
  const safePath = String(path || '')
  const conv = typeof window !== 'undefined' && (/** @type {any} */ (window)).__TAURI__?.core?.convertFileSrc
  if (typeof conv === 'function') {
    try { return conv(safePath) } catch { /* fall through */ }
  }
  return '/attachment?path=' + encodeURIComponent(safePath)
}

/**
 * Delete a project session by alias. Used by the settings drawer's 项目管理 list.
 * @param {Deps} deps
 * @param {string} alias
 * @param {string|null} [chatId]
 * @returns {Promise<void>}
 */
export async function deleteProjectByAlias(deps, alias, chatId = null) {
  if (!alias) return
  await /** @type {Promise<SessionsDelete>} */ (
    deps.invoke("wechat_cli_json", { args: withChat(["sessions", "delete", alias, "--json"], chatId) })
  )
}

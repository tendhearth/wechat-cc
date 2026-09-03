// Logs pane module. Tails the daemon's channel.log via `wechat-cc logs
// --tail N --json`, renders one row per entry, and refreshes on user
// click + on a slow background tick (10s — log lines change less often
// than doctor state, and reading the whole file each tick is wasteful).
//
// Owns: #logs-body, #logs-meta, #logs-tail-select, #logs-refresh,
//       #logs-count
// Tag classification (info/warn/error) is heuristic — daemon log tags
// are free-form so we pattern-match well-known shapes; unknown tags
// render in the neutral default color.

import { escapeHtml } from "../view.js"

const TAG_TONES = {
  // error-tone: things that imply something broke
  ERROR: "error", FATAL: "error", PANIC: "error",
  CRASH: "error", FAIL: "error",
  // warn-tone: needs attention but not broken
  SESSION_EXPIRED: "warn", STREAM_DROP: "warn",
  POLL_ERROR: "warn", TIMEOUT: "warn",
  // info-tone: green-path lifecycle
  SESSION_INIT: "info", SESSION_RESUME: "info",
  POLL: "info", BOOT: "info", READY: "info",
}

function tagToneClass(tag) {
  const upper = String(tag || "").toUpperCase()
  if (TAG_TONES[upper]) return `tag-${TAG_TONES[upper]}`
  // Heuristic for tags we haven't enumerated: any tag containing FAIL,
  // ERROR, PANIC → error; EXPIRED, DROP, TIMEOUT → warn.
  if (/FAIL|ERROR|PANIC|CRASH/.test(upper)) return "tag-error"
  if (/EXPIRED|DROP|TIMEOUT|RETRY/.test(upper)) return "tag-warn"
  return ""
}

function formatLocalTime(iso) {
  if (!iso) return ""
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return iso
  const d = new Date(t)
  return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
}

function renderRows(entries) {
  if (!entries.length) return `<p class="empty-state">没有日志（daemon 还没产生事件）。</p>`
  return entries.map(e => {
    const isCont = !e.tag && !e.timestamp
    const cls = isCont ? "logs-row continuation" : "logs-row"
    const ts = e.timestamp ? formatLocalTime(e.timestamp) : ""
    const tag = e.tag || ""
    const tagClass = tagToneClass(e.tag)
    return `
      <div class="${cls}">
        <span class="ts">${escapeHtml(ts)}</span>
        <span class="tag ${tagClass}">${escapeHtml(tag)}</span>
        <span class="msg">${escapeHtml(e.message)}</span>
      </div>
    `
  }).join("")
}

/**
 * 按关键字筛日志行。**纯函数,可测** —— 面板里 200~500 行滚过去,
 * `tools=search_web` 混在里面等于没有;owner 要的「查一条回答是不是联网
 * 查来的」,就是在这里筛。
 *
 * 续行(没有 tag/时间戳的堆栈行)**跟着它上面那条走**:单独匹配会筛出
 * 没头没尾的半截堆栈,而它自己命中时反而该被丢掉(上下文没了)。
 *
 * @param {Array<{timestamp:number|null, tag:string|null, message:string}>} entries
 * @param {string} query
 */
export function filterLogEntries(entries, query) {
  const q = (query || "").trim().toLowerCase()
  if (!q) return entries
  const out = []
  let keepingCont = false
  for (const e of entries) {
    const isCont = !e.tag && !e.timestamp
    if (isCont) {
      if (keepingCont) out.push(e)
      continue
    }
    const hit = `${e.tag || ""} ${e.message || ""}`.toLowerCase().includes(q)
    keepingCont = hit
    if (hit) out.push(e)
  }
  return out
}

let logsState = { lastResult: null, busy: false, autoTimer: null }

/** 按当前筛选词渲染一次(不重新读日志 —— 那要走 CLI,几百 KB)。 */
function paintLogs(result) {
  const body = document.getElementById("logs-body")
  if (!body) return []
  const raw = document.getElementById("logs-filter")?.value || ""
  const q = raw.trim()
  const shown = filterLogEntries(result.entries, raw)
  body.innerHTML = renderRows(shown)
  const meta = document.getElementById("logs-meta")
  if (meta) {
    // 筛过之后要把「筛掉了多少」说出来 —— 否则用户会以为日志只有这几行。
    meta.textContent = q
      ? `${shown.length}/${result.entries.length} 行(筛选「${q}」)· ${result.logFile.split("/").pop()}`
      : `${result.entries.length}/${result.totalLines} 行 · ${result.logFile.split("/").pop()}`
  }
  return shown
}

/** 只重渲染已有结果 —— 输入框每敲一下都重读日志会很慢。 */
export function rerenderLogs() {
  if (logsState.lastResult) paintLogs(logsState.lastResult)
}

export async function loadLogsPane(deps) {
  if (logsState.busy) return
  logsState.busy = true
  const select = document.getElementById("logs-tail-select")
  const tail = Number.parseInt(select?.value || "50", 10) || 50
  const body = document.getElementById("logs-body")
  body.innerHTML = `<p class="empty-state">加载中…</p>`
  let result
  try {
    // Route through wechat_cli_json_via_file: 200/500-line tails produce
    // pretty-printed JSON in the hundreds-of-KB range, and bun --compile
    // pipes silently drop bytes at that size (see lib.rs:22-26). Sessions
    // already use this pattern; logs hit the same wall as soon as users pick
    // a non-trivial tail count. The CLI honours --out-file and writes the
    // payload to disk; lib.rs reads + parses + cleans up.
    result = await deps.invoke("wechat_cli_json_via_file", { args: ["logs", "--tail", String(tail), "--json"] })
  } catch (err) {
    logsState.busy = false
    body.innerHTML = `<p class="empty-state">读取失败：${escapeHtml(deps.formatInvokeError(err))}</p>`
    return
  }
  logsState.busy = false
  if (!result.ok) {
    body.innerHTML = `<p class="empty-state">读取失败：${escapeHtml(result.error || "unknown")}</p>`
    return
  }
  logsState.lastResult = result
  const shown = paintLogs(result)
  // Scroll to bottom — user expects to see the most recent entry without
  // reaching for the scrollbar. Skip if user scrolled up manually within
  // the last refresh (we don't track that yet; revisit if it gets noisy).
  body.scrollTop = body.scrollHeight
  const meta = document.getElementById("logs-meta")

  const navCount = document.getElementById("logs-count")
  if (navCount) navCount.textContent = result.entries.length > 0 ? String(result.entries.length) : ""
}

// Start a 10s auto-refresh tick while the logs pane is the active one.
// stopLogsAutoRefresh stops it. main.js wires these to switchPane.
export function startLogsAutoRefresh(deps, intervalMs = 10000) {
  if (logsState.autoTimer) return
  logsState.autoTimer = setInterval(() => loadLogsPane(deps), intervalMs)
}

export function stopLogsAutoRefresh() {
  if (logsState.autoTimer) {
    clearInterval(logsState.autoTimer)
    logsState.autoTimer = null
  }
}

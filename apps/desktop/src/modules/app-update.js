// @ts-check
/// <reference lib="dom" />
//
// app-update.js — Tauri updater 前端(2026-08-25, 更新机制方案 A)。
// 启动后延迟检查一次 + 每 24h 一次;有新版在窗口底部出一条暖纸横幅,
// 用户点「现在更新」才下载安装(下载进度就地显示),装完一键重启。
// 端点/签名在 tauri.conf.json 的 plugins.updater;检查失败(离线/
// 端点没配)一律静默 —— 更新提示永远不该变成骚扰。

const CHECK_DELAY_MS = 15_000
const CHECK_INTERVAL_MS = 24 * 3600_000

let bannerShownForVersion = ""

// ── updater IPC 走全局 Tauri 对象 ──
// 本 app 无 bundler(frontendDist 直指 ../src 原始文件),裸模块
// `import("@tauri-apps/plugin-updater")` 在 webview 里永远解析不了 ——
// 每次 check 都在 throw,又被静默 catch 吃掉,updater 自 1.6.1 起从未
// 工作过(owner 实测「好像也没有?」)。改为 __TAURI__.core.invoke 直调
// 插件命令(协议镜像 plugin-updater/dist-js/index.js)。
function tauriCore() {
  return /** @type {any} */ (window).__TAURI__?.core ?? null
}

async function checkOnce() {
  try {
    const core = tauriCore()
    if (!core) return   // mock/浏览器环境
    // metadata: { rid, currentVersion, version, date, body } | null
    const metadata = await core.invoke("plugin:updater|check", {})
    if (!metadata || !metadata.version) return
    if (bannerShownForVersion === metadata.version) return
    bannerShownForVersion = metadata.version
    showBanner(metadata)
  } catch {
    /* offline / endpoint unset / dev mode — stay silent */
  }
}

/** @param {{ rid: number, version: string, body?: string }} update */
function showBanner(update) {
  document.getElementById("app-update-banner")?.remove()
  const el = document.createElement("div")
  el.id = "app-update-banner"
  const notes = (update.body || "").trim().split("\n")[0]?.slice(0, 60) ?? ""
  el.innerHTML = `
    <span class="au-text">CC 有新版本 v${escapeText(update.version)}${notes ? ` — ${escapeText(notes)}` : ""}</span>
    <button class="au-btn au-primary" type="button" data-au="install">现在更新</button>
    <button class="au-btn" type="button" data-au="later">稍后</button>`
  el.addEventListener("click", async (ev) => {
    const t = ev.target instanceof HTMLElement ? ev.target.closest("[data-au]") : null
    if (!(t instanceof HTMLElement)) return
    if (t.dataset.au === "later") { el.remove(); return }
    if (t.dataset.au === "install") {
      const text = el.querySelector(".au-text")
      el.querySelectorAll("button").forEach(b => { /** @type {HTMLButtonElement} */ (b).disabled = true })
      try {
        let downloaded = 0
        let total = 0
        const core = tauriCore()
        const channel = new core.Channel()
        channel.onmessage = (/** @type {any} */ ev2) => {
          if (ev2.event === "Started") total = ev2.data.contentLength ?? 0
          else if (ev2.event === "Progress") {
            downloaded += ev2.data.chunkLength
            if (text) text.textContent = total
              ? `正在下载新版本… ${Math.round(downloaded / total * 100)}%`
              : `正在下载新版本… ${(downloaded / 1048576).toFixed(1)}MB`
          } else if (ev2.event === "Finished") {
            if (text) text.textContent = "安装中…"
          }
        }
        await core.invoke("plugin:updater|download_and_install", { onEvent: channel, rid: update.rid })
        if (text) text.textContent = "装好了,重启后就是新版本"
        const btn = el.querySelector('[data-au="install"]')
        if (btn instanceof HTMLButtonElement) {
          btn.disabled = false
          btn.textContent = "重启 CC"
          btn.dataset.au = "relaunch"
        }
      } catch (err) {
        if (text) text.textContent = `更新没成功:${err instanceof Error ? err.message : err} — 稍后会再试`
        // 让「稍后会再试」成真:清掉去重标记,下次 focus/24h 检查会重新拉取
        // (拿到新的 rid)并再出横幅。否则本次会话内 checkOnce 一直被挡住,
        // 得等重启 app 才会再提示,承诺就成了空话。
        bannerShownForVersion = ""
        setTimeout(() => el.remove(), 5000)
      }
      return
    }
    if (t.dataset.au === "relaunch") {
      await tauriCore()?.invoke("plugin:process|restart", {})
    }
  })
  document.body.appendChild(el)
}

/** @param {string} s */
function escapeText(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

const FOCUS_RECHECK_MIN_MS = 60 * 60_000
let _lastCheckAt = 0

export function startAppUpdateChecks() {
  setTimeout(() => { _lastCheckAt = Date.now(); checkOnce() }, CHECK_DELAY_MS)
  setInterval(() => { _lastCheckAt = Date.now(); checkOnce() }, CHECK_INTERVAL_MS)
  // 常驻 app 只靠 24h 定时会错过发布窗口一整天(owner 实测「没看到升级」)。
  // 窗口获得焦点时补查,1 小时节流 —— 用户回到 app 的那一刻最该看到横幅。
  window.addEventListener("focus", () => {
    if (Date.now() - _lastCheckAt < FOCUS_RECHECK_MIN_MS) return
    _lastCheckAt = Date.now()
    checkOnce()
  })
}

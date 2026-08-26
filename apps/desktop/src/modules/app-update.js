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

async function checkOnce() {
  try {
    const { check } = await import("@tauri-apps/plugin-updater")
    const update = await check()
    if (!update || !update.available) return
    if (bannerShownForVersion === update.version) return
    bannerShownForVersion = update.version
    showBanner(update)
  } catch {
    /* offline / endpoint unset / dev mode — stay silent */
  }
}

/** @param {import("@tauri-apps/plugin-updater").Update} update */
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
        await update.downloadAndInstall((ev2) => {
          if (ev2.event === "Started") total = ev2.data.contentLength ?? 0
          else if (ev2.event === "Progress") {
            downloaded += ev2.data.chunkLength
            if (text) text.textContent = total
              ? `正在下载新版本… ${Math.round(downloaded / total * 100)}%`
              : `正在下载新版本… ${(downloaded / 1048576).toFixed(1)}MB`
          } else if (ev2.event === "Finished") {
            if (text) text.textContent = "安装中…"
          }
        })
        if (text) text.textContent = "装好了,重启后就是新版本"
        const btn = el.querySelector('[data-au="install"]')
        if (btn instanceof HTMLButtonElement) {
          btn.disabled = false
          btn.textContent = "重启 CC"
          btn.dataset.au = "relaunch"
        }
      } catch (err) {
        if (text) text.textContent = `更新没成功:${err instanceof Error ? err.message : err} — 稍后会再试`
        setTimeout(() => el.remove(), 5000)
      }
      return
    }
    if (t.dataset.au === "relaunch") {
      const { relaunch } = await import("@tauri-apps/plugin-process")
      await relaunch()
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

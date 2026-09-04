// Read-only local CC Atelier gallery for the overview pane.
import { escapeHtml } from "../view.js"

// Paint-set download status → label (mirrors daemon formatAtelierModelStatus).
// The download runs on this Mac; the gallery is its durable home to check on it.
function atelierModelLabel(st) {
  if (!st) return { label: "", done: false, failed: false }
  if (st.state === "checking") return { label: "正在检查画笔…", done: false, failed: false }
  if (st.state === "downloading") {
    if (!(st.total > 0)) return { label: "正在下载画笔…", done: false, failed: false }
    const pct = Math.min(100, Math.round((st.received / st.total) * 100))
    return { label: `正在下载画笔… ${pct}%`, done: false, failed: false }
  }
  if (st.state === "ready") return { label: "画笔就绪 ✓", done: true, failed: false }
  if (st.state === "failed") return { label: "准备失败,稍后会自动重试", done: false, failed: true }
  return { label: "", done: false, failed: false }
}

async function apiGet(deps, path) {
  try {
    return await deps.invokeApi("GET", path)
  } catch {
    const response = await fetch(path)
    if (!response.ok) throw new Error("atelier_unavailable")
    return await response.json()
  }
}

let atelierStatusTimer = null
async function loadAtelierModelStatus(deps) {
  const el = document.getElementById("atelier-model-status")
  if (!el) return
  let st = null
  try { st = (await apiGet(deps, "/v1/atelier/model-status"))?.status ?? null } catch { st = null }
  const r = atelierModelLabel(st)
  el.hidden = !r.label
  el.textContent = r.label
  el.classList.toggle("is-failed", r.failed)
  el.classList.toggle("is-ready", r.done)
  // Keep the bar live while the download is in progress.
  if (atelierStatusTimer) { clearTimeout(atelierStatusTimer); atelierStatusTimer = null }
  if (st && (st.state === "checking" || st.state === "downloading")) {
    atelierStatusTimer = setTimeout(() => loadAtelierModelStatus(deps), 2000)
  }
}

export function buildAtelierShareRequest(id, includeBackground, fields) {
  return {
    id,
    background: includeBackground ? {
      title: String(fields.title || "").trim(),
      origin: String(fields.origin || "").trim(),
      approach: String(fields.approach || "").trim(),
    } : null,
  }
}

export function atelierShareErrorLabel(error) {
  const text = String(error?.message || error || "")
  if (text.includes("owner_chat_not_configured")) return "还没有默认微信会话，先和 CC 说句话再试。"
  if (text.includes("already_shared")) return "这幅作品已经分享过了。"
  if (text.includes("share_in_progress")) return "这幅作品正在发送，请稍等。"
  if (text.includes("prepare failed") || text.includes("errcode=-2")) return "当前微信发送窗口已过期，先给 CC 发条消息再试。"
  return "暂时没发出去，作品仍安全地留在画室里。"
}

function bindAtelierSharing(box, deps) {
  if (box.dataset.shareBound === "1") return
  box.dataset.shareBound = "1"
  box.addEventListener("click", async (event) => {
    const target = event.target instanceof Element ? event.target : null
    const open = target?.closest("[data-atelier-share-open]")
    const cancel = target?.closest("[data-atelier-share-cancel]")
    const send = target?.closest("[data-atelier-share-send]")
    if (!open && !cancel && !send) return
    event.preventDefault()
    const work = target.closest(".atelier-work")
    const panel = work?.querySelector(".atelier-share-panel")
    if (!work || !panel) return
    if (open) {
      panel.hidden = false
      open.hidden = true
      panel.querySelector("input")?.focus()
      return
    }
    if (cancel) {
      panel.hidden = true
      const opener = work.querySelector("[data-atelier-share-open]")
      if (opener) opener.hidden = false
      return
    }
    const include = panel.querySelector("[data-atelier-share-background]")?.checked !== false
    const title = panel.querySelector("[data-atelier-share-title]")?.value || ""
    const origin = panel.querySelector("[data-atelier-share-origin]")?.value || ""
    const approach = panel.querySelector("[data-atelier-share-approach]")?.value || ""
    const status = panel.querySelector("[data-atelier-share-status]")
    if (include && (!title.trim() || !origin.trim() || !approach.trim())) {
      if (status) status.textContent = "要附上手记时，这三段都需要保留一点内容。"
      return
    }
    send.disabled = true
    send.textContent = "正在发…"
    if (status) status.textContent = ""
    try {
      const response = await deps.invokeApi("POST", "/v1/atelier/share", buildAtelierShareRequest(work.dataset.workId, include, { title, origin, approach }), { timeoutMs: 30_000 })
      if (!response?.ok) throw new Error(response?.error || "share_failed")
      panel.classList.add("is-done")
      send.textContent = "已分享"
      const opener = work.querySelector("[data-atelier-share-open]")
      if (opener) { opener.hidden = false; opener.disabled = true; opener.textContent = "已分享" }
      if (status) status.textContent = response.warning === "background_send_failed"
        ? "画已经发出，手记没有发成功。"
        : response.warning
          ? "画已经发出，发送状态稍后再确认。"
          : include ? "作品和手记已发到你的微信。" : "作品已发到你的微信，没有附手记。"
    } catch (error) {
      send.disabled = false
      send.textContent = "发到我的微信"
      if (status) status.textContent = atelierShareErrorLabel(error)
    }
  })
  box.addEventListener("change", (event) => {
    const toggle = event.target instanceof Element ? event.target.closest("[data-atelier-share-background]") : null
    if (!toggle) return
    const panel = toggle.closest(".atelier-share-panel")
    panel?.querySelectorAll("input[type=text], textarea").forEach(field => { field.disabled = !toggle.checked })
    const hint = panel?.querySelector("[data-atelier-share-hint]")
    if (hint) hint.textContent = toggle.checked ? "发送前可以改成你愿意分享的说法。" : "这次只发作品，不附创作手记。"
  })
}

export async function loadAtelierGallery(deps) {
  const box = document.getElementById("atelier-gallery")
  if (!box) return
  bindAtelierSharing(box, deps)
  loadAtelierModelStatus(deps)
  const toggle = document.getElementById("atelier-gallery-toggle")
  if (toggle && toggle.dataset.bound !== "1") {
    toggle.dataset.bound = "1"
    toggle.addEventListener("click", () => {
      const open = box.hidden
      box.hidden = !open
      toggle.setAttribute("aria-expanded", String(open))
      toggle.textContent = open ? "收起画室" : "打开画室"
    })
  }
  try {
    let result
    try {
      result = await deps.invokeApi("GET", "/v1/atelier/works?limit=6")
    } catch {
      // Source-based Tauri development may discover an older installed daemon;
      // ask the same-origin shim, which can read the workspace state directly.
      const response = await fetch("/v1/atelier/works?limit=6")
      if (!response.ok) throw new Error("atelier_unavailable")
      result = await response.json()
    }
    const works = Array.isArray(result?.works) ? result.works : []
    if (!works.length) {
      box.innerHTML = '<p class="atelier-empty">还没有作品。等 CC 有了创作冲动，它会把画留在这里。</p>'
      return
    }
    box.innerHTML = works.map((work) => {
      const image = typeof work.image_data === "string" ? `<img src="${work.image_data}" alt="CC Atelier 作品" loading="lazy" />` : ""
      const medium = escapeHtml(work.impulse?.medium || "自由表达")
      const date = escapeHtml(String(work.createdAt || "").slice(0, 10))
      const title = escapeHtml(work.background?.title || work.caption || work.impulse?.subject || "未命名作品")
      const origin = escapeHtml(work.background?.origin || "这幅作品还没有留下创作手记。")
      const approach = escapeHtml(work.background?.approach || `CC 选择了${medium}来完成这次表达。`)
      const kind = work.background?.kind === "test" ? "本地测试样本" : "私人作品"
      const renderer = escapeHtml(work.rendererId || "未知")
      const size = `${Number(work.width) || 0} × ${Number(work.height) || 0}`
      const id = escapeHtml(work.id || "")
      const shareState = work.shareState === "shared" ? "shared" : work.shareState === "pending" ? "pending" : "private"
      const shareLabel = shareState === "shared" ? "已分享" : shareState === "pending" ? "发送中" : "分享…"
      const shareDisabled = shareState === "private" ? "" : " disabled"
      return `<details class="atelier-work" data-work-id="${id}">
        <summary>${image}<span class="atelier-work-meta"><strong>${title}</strong><span>${medium} · ${date}</span></span></summary>
        <div class="atelier-story">
          <span class="atelier-kind">${kind}</span>
          <h3>这幅画从哪里来</h3><p>${origin}</p>
          <h3>为什么这样画</h3><p>${approach}</p>
          <details class="atelier-tech"><summary>作品信息</summary><p>${size} · ${renderer}</p></details>
          <button class="atelier-share-open" type="button" data-atelier-share-open${shareDisabled}>${shareLabel}</button>
          <div class="atelier-share-panel" hidden>
            <div class="atelier-share-head"><strong>发给我的微信</strong><span data-atelier-share-hint>发送前可以改成你愿意分享的说法。</span></div>
            <label><span>作品标题</span><input type="text" maxlength="120" value="${title}" data-atelier-share-title /></label>
            <label><span>这幅画从哪里来</span><textarea maxlength="800" rows="3" data-atelier-share-origin>${origin}</textarea></label>
            <label><span>为什么这样画</span><textarea maxlength="500" rows="3" data-atelier-share-approach>${approach}</textarea></label>
            <label class="atelier-share-toggle"><input type="checkbox" checked data-atelier-share-background /><span>附上创作手记</span></label>
            <div class="atelier-share-actions"><button type="button" data-atelier-share-cancel>取消</button><button class="is-primary" type="button" data-atelier-share-send>发到我的微信</button></div>
            <p class="atelier-share-status" role="status" data-atelier-share-status></p>
          </div>
        </div>
      </details>`
    }).join("")
  } catch {
    box.innerHTML = '<p class="atelier-empty">作品集暂时不可用。</p>'
  }
}

const invoke = /** @type {any} */ window.__TAURI__?.core?.invoke
const closeButton = document.getElementById("companion-window-close")
const dragRegions = document.querySelectorAll("[data-tauri-drag-region]")
const zoomOutButton = document.getElementById("companion-window-zoom-out")
const zoomInButton = document.getElementById("companion-window-zoom-in")
const stage = document.querySelector(".companion-window-stage")

function fitStage() {
  const shell = stage?.parentElement
  if (!stage || !shell) return
  const width = Math.max(1, Math.min(shell.clientWidth - 24, (shell.clientHeight - 24) * 1.5))
  stage.style.width = `${width}px`
  stage.style.height = `${width / 1.5}px`
}

fitStage()
if (typeof ResizeObserver !== "undefined" && stage?.parentElement) {
  new ResizeObserver(fitStage).observe(stage.parentElement)
}

closeButton?.addEventListener("click", () => {
  if (invoke) invoke("close_companion_window").catch(console.warn)
  else window.close()
})

dragRegions.forEach(region => region.addEventListener("mousedown", event => {
  if (!(event instanceof MouseEvent) || event.button !== 0 || !invoke) return
  event.preventDefault()
  invoke("start_companion_drag").catch(console.warn)
}))

zoomOutButton?.addEventListener("click", () => invoke?.("resize_companion_window", { direction: "out" }).catch(console.warn))
zoomInButton?.addEventListener("click", () => invoke?.("resize_companion_window", { direction: "in" }).catch(console.warn))

window.addEventListener("keydown", event => {
  if (event.key === "Escape") closeButton?.click()
})

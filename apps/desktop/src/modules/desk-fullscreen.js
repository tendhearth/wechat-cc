// @ts-check

/**
 * @param {{isFullscreen: () => Promise<boolean>, onResized: (read: () => void) => Promise<() => void>} | undefined} nativeWindow
 * @param {(fullscreen: boolean) => void} reflect
 */
export function watchDeskFullscreen(nativeWindow, reflect) {
  if (!nativeWindow?.isFullscreen || !nativeWindow.onResized) return () => {}
  let disposed = false, generation = 0
  /** @type {(() => void) | undefined} */ let unlisten
  async function read() {
    const current = ++generation
    let fullscreen = false
    try { fullscreen = await nativeWindow?.isFullscreen() === true }
    catch { /* Fall back to the windowed titlebar. */ }
    if (!disposed && generation === current) reflect(fullscreen)
  }
  void read()
  async function listen() {
    try {
      const cleanup = await nativeWindow?.onResized(() => { void read() })
      if (disposed) cleanup?.()
      else unlisten = cleanup
    } catch { /* Keep the initial reading if resize events are unavailable. */ }
  }
  void listen()
  return () => { disposed = true; unlisten?.() }
}

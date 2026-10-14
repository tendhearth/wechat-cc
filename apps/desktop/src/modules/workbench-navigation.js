// @ts-check

/**
 * 一起做和其他页一样挂在主导航下(2026-10-05):窗口够宽时主导航一直在,一起做的任务列表是第二栏;
 * 只有窗口窄到放不下两栏(没到 wideQuery)时才把主导航收起,由左上角按钮叫出来。
 *
 * @param {{shell:HTMLElement,rail:HTMLElement,toggle:HTMLElement,scrim:HTMLElement,documentTarget?:Document,wideQuery?:MediaQueryList|null}} elements
 */
export function createWorkbenchNavigation({ shell, rail, toggle, scrim, documentTarget = document, wideQuery = null }) {
  let workbenchActive = false
  let open = false
  const focused = () => workbenchActive && !wideQuery?.matches

  const render = () => {
    const visible = focused() && open
    shell.classList.toggle('is-workbench-focused', focused())
    shell.classList.toggle('is-workbench-nav-open', visible)
    toggle.setAttribute('aria-expanded', String(visible))
    const label = visible ? '关闭主导航' : '打开主导航'
    toggle.setAttribute('aria-label', label)
    toggle.setAttribute('title', label)
    scrim.hidden = !focused()
    rail.inert = focused() && !visible
    if (rail.inert) rail.setAttribute('aria-hidden', 'true')
    else rail.removeAttribute('aria-hidden')
  }

  /** @param {boolean} returnFocus */
  const close = returnFocus => {
    if (!open) return
    open = false
    render()
    if (returnFocus && focused()) toggle.focus({ preventScroll: true })
  }

  const onToggle = () => {
    if (!focused()) return
    if (open) {
      close(true)
      return
    }
    open = true
    render()
    const target = /** @type {HTMLElement|null} */ (
      rail.querySelector('.dash-nav-link.active:not(.disabled)')
      ?? rail.querySelector('.dash-nav-link:not(.disabled)')
    )
    target?.focus({ preventScroll: true })
  }
  const onScrim = () => close(true)
  /** @param {KeyboardEvent} event */
  const onKeydown = event => {
    if (event.defaultPrevented || event.key !== 'Escape' || !focused() || !open) return
    event.preventDefault()
    close(true)
  }

  const onWidth = () => { open = false; render() }

  toggle.addEventListener('click', onToggle)
  scrim.addEventListener('click', onScrim)
  documentTarget.addEventListener('keydown', onKeydown)
  wideQuery?.addEventListener('change', onWidth)
  render()

  return {
    /**
     * Sync navigation after the target pane's visibility has been updated.
     * @param {boolean} active
     */
    setWorkbenchActive(active) {
      if (active && workbenchActive && open) {
        close(true)
        return
      }
      const entering = active && !workbenchActive
      workbenchActive = active
      open = false
      render()
      if (entering && focused()) toggle.focus({ preventScroll: true })
    },
    destroy() {
      toggle.removeEventListener('click', onToggle)
      scrim.removeEventListener('click', onScrim)
      documentTarget.removeEventListener('keydown', onKeydown)
      wideQuery?.removeEventListener('change', onWidth)
    },
  }
}

/** @param {string} requestedPane @param {HTMLElement|null} currentPane */
export function isCurrentWorkbenchPane(requestedPane, currentPane) {
  return requestedPane === 'workbench' && currentPane?.dataset.pane === 'workbench' && !currentPane.hidden
}

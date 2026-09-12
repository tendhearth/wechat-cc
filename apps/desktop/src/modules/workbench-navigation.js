// @ts-check

/**
 * Keep the global dashboard rail out of the workbench until it is requested.
 * The workbench task sidebar remains part of the page and is unaffected.
 *
 * @param {{shell:HTMLElement,rail:HTMLElement,toggle:HTMLElement,scrim:HTMLElement,documentTarget?:Document}} elements
 */
export function createWorkbenchNavigation({ shell, rail, toggle, scrim, documentTarget = document }) {
  let workbenchActive = false
  let open = false

  const render = () => {
    const visible = workbenchActive && open
    shell.classList.toggle('is-workbench-focused', workbenchActive)
    shell.classList.toggle('is-workbench-nav-open', visible)
    toggle.setAttribute('aria-expanded', String(visible))
    toggle.setAttribute('aria-label', visible ? '关闭主导航' : '打开主导航')
    scrim.hidden = !visible
    rail.inert = workbenchActive && !visible
    if (rail.inert) rail.setAttribute('aria-hidden', 'true')
    else rail.removeAttribute('aria-hidden')
  }

  /** @param {boolean} returnFocus */
  const close = returnFocus => {
    if (!open) return
    open = false
    render()
    if (returnFocus && workbenchActive) toggle.focus({ preventScroll: true })
  }

  const onToggle = () => {
    if (!workbenchActive) return
    if (open) {
      close(true)
      return
    }
    open = true
    render()
    const target = /** @type {HTMLElement|null} */ (rail.querySelector('.dash-nav-link.active:not(.disabled), .dash-nav-link:not(.disabled)'))
    target?.focus({ preventScroll: true })
  }
  const onScrim = () => close(true)
  /** @param {KeyboardEvent} event */
  const onKeydown = event => {
    if (event.key !== 'Escape' || !workbenchActive || !open) return
    event.preventDefault()
    close(true)
  }

  toggle.addEventListener('click', onToggle)
  scrim.addEventListener('click', onScrim)
  documentTarget.addEventListener('keydown', onKeydown)
  render()

  return {
    /** @param {boolean} active */
    setWorkbenchActive(active) {
      if (active && workbenchActive && open) {
        close(true)
        return
      }
      workbenchActive = active
      open = false
      render()
    },
    destroy() {
      toggle.removeEventListener('click', onToggle)
      scrim.removeEventListener('click', onScrim)
      documentTarget.removeEventListener('keydown', onKeydown)
    },
  }
}

/** @param {string} requestedPane @param {HTMLElement|null} currentPane */
export function isCurrentWorkbenchPane(requestedPane, currentPane) {
  return requestedPane === 'workbench' && currentPane?.dataset.pane === 'workbench' && !currentPane.hidden
}

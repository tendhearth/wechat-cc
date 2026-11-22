// @ts-check

/** Dismiss the wide desktop pop-up menus and return focus to their trigger.
 * @param {HTMLDetailsElement} menu
 * @param {AbortSignal} [signal]
 */
export function wireDeskDisclosure(menu, signal) {
  const doc = menu.ownerDocument
  const active = () => menu.open && doc.documentElement.hasAttribute('data-desk-wide') && menu.getClientRects().length > 0
  const dismiss = () => {
    menu.open = false
    menu.querySelector('summary')?.focus({ preventScroll: true })
  }
  doc.addEventListener('click', event => {
    if (active() && event.target instanceof Node && !menu.contains(event.target)) dismiss()
  }, { capture: true, signal })
  doc.addEventListener('keydown', event => {
    if (!active() || event.key !== 'Escape' || event.isComposing || doc.querySelector('dialog[open]')) return
    event.preventDefault()
    event.stopImmediatePropagation()
    dismiss()
  }, { capture: true, signal })
  menu.addEventListener('click', event => {
    if (active() && event.target instanceof Element && event.target.closest('button, a[href]')) dismiss()
  }, { capture: true, signal })
}

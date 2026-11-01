// @ts-check
// Native navigate events and pending navigation are untrusted input.
/** @param {unknown} page @returns {'overview' | 'a2a-agents' | 'converse' | null} */
export const mainDestination = page => page === 'overview' || page === 'a2a-agents' || page === 'converse' ? page : null

/** Keep native entry requests until their destination can actually receive focus.
 * @param {(page: 'overview' | 'a2a-agents' | 'converse') => void} navigate
 */
export function createMainNavigation(navigate) {
  let ready = false
  let generation = 0
  /** @type {ReturnType<typeof mainDestination>} */ let queued = null
  const request = (/** @type {unknown} */ page) => {
    const destination = mainDestination(page)
    if (!destination) return false
    generation++
    if (ready) navigate(destination)
    else queued = destination
    return true
  }
  return {
    request,
    /** @param {boolean} value */
    setReady(value) {
      ready = value
      if (ready && queued) { const destination = queued; queued = null; navigate(destination) }
    },
    /** A newer live event must win over an older asynchronous boot response.
     * @param {Promise<unknown>} pending
     */
    restore(pending) {
      return pending.then(page => generation === 0 ? request(page) : false).catch(() => false)
    },
  }
}

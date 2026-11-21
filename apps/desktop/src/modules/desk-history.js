// @ts-check

/** @typedef {{kind:'matter'|'terminal', id:string}} DeskDetail */
/** @typedef {{pane:string, place:string|null, detail:DeskDetail|null}} DeskLocation */
/** @typedef {-1|1} Direction */

/** @param {DeskLocation} initial */
export function createDeskHistory(initial) {
  const entries = [initial]
  let index = 0, revision = 0
  return {
    /** @param {DeskLocation} next */
    push(next) {
      revision++
      const current = entries[index]
      if (current && current.pane === next.pane && current.place === next.place
        && current.detail?.kind === next.detail?.kind && current.detail?.id === next.detail?.id) return
      entries.splice(index + 1, entries.length, next)
      if (entries.length > 50) entries.shift()
      index = entries.length - 1
    },
    /** @param {Direction} direction */
    canMove(direction) {
      return entries[index + direction] !== undefined
    },
    /** @param {Direction} direction @param {(entry:DeskLocation, current:() => boolean) => boolean|undefined|Promise<boolean|undefined>} restore */
    async move(direction, restore) {
      const attempt = ++revision
      const current = () => revision === attempt
      for (let entry = entries[index + direction]; entry; entry = entries[index + direction]) {
        const candidate = index + direction
        const restored = await restore(entry, current)
        if (!current() || restored === undefined) return false
        if (restored) {
          index = candidate
          return true
        }
        entries.splice(candidate, 1)
        if (direction < 0) index--
      }
      return false
    },
  }
}

/** @param {KeyboardEvent} event @param {boolean} mac @returns {Direction|undefined} */
export function deskHistoryShortcut(event, mac) {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.shiftKey || event.ctrlKey
    || event.metaKey !== mac || event.altKey === mac) return
  if (event.key === (mac ? '[' : 'ArrowLeft')) return -1
  if (event.key === (mac ? ']' : 'ArrowRight')) return 1
}

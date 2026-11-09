// @ts-check
/** Only authorized approval details may produce an actionable card. The
 * presence feed supplies an identifier, never the card's prompt or script.
 * @param {{read:()=>Promise<import('./permission-card.js').PermissionItem[]>,show:(item:import('./permission-card.js').PermissionItem,count:number)=>void,hide:()=>void}} options */
export function createPermissionLoader({ read, show, hide }) {
  let version = 0, count = 0, busy = false
  /** @type {string|null} */ let hash = null
  /** @type {import('./permission-card.js').PermissionItem|null} */ let detail = null
  return {
    /** @param {{hash:string}|null} summary @param {number} n */
    update(summary, n) {
      count = n
      if (hash !== (summary?.hash ?? null)) { version++; hash = summary?.hash ?? null; detail = null; busy = false; hide() }
      if (!hash) { hide(); return }
      if (detail) { show(detail, count); return }
      if (busy) return
      busy = true
      const current = version, target = hash
      void (async () => {
        try {
          const items = await read()
          if (current !== version) return
          detail = items.find(item => item.hash === target && typeof item.prompt === 'string') ?? null
          if (detail) show(detail, count)
          else hide()
        } catch { if (current === version) hide() }
        finally { if (current === version) busy = false }
      })()
    },
  }
}

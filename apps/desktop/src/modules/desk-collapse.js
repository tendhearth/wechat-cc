// @ts-check
const storageKey = 'wechat-cc:desk-left-collapsed'

/** @param {Window} host */
export function readDeskCollapsed(host) {
  try { return host.localStorage.getItem(storageKey) === 'true' }
  catch { return false }
}

/** @param {Window} host @param {boolean} collapsed */
export function writeDeskCollapsed(host, collapsed) {
  try { host.localStorage.setItem(storageKey, String(collapsed)) }
  catch { /* The current window still keeps its selection. */ }
}

/** @param {KeyboardEvent} event @param {boolean} mac */
export function isDeskCollapseShortcut(event, mac) {
  return event.key.toLowerCase() === 'b' && !event.defaultPrevented && !event.repeat
    && !event.isComposing && event.keyCode !== 229 && !event.altKey && !event.shiftKey
    && event.metaKey === mac && event.ctrlKey !== mac
}

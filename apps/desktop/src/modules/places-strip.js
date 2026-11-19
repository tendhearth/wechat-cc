// @ts-check
/// <reference lib="dom" />
// places-strip.js —— 正面上半:「现在」。一个地方(项目)一行,位置由主人定,不按状态重排
// (设计稿 docs/superpowers/specs/2026-11-18-cc-two-sides-design.md §3)。
//
// 一行三样:名字、一句现状、时间。不给状态起名字,只用三样人人会读的:
//   圆点 = 它在等你;加粗 = 它说了话你还没看;时间「现在」= 在干。
// 等你批准的,在行上直接答;要回答问题 / 终端停着问的,「去回答」打开那一件。
// 点一行 = 把下面的说话筛成这个地方;再点一次回到全部。
import {V1,v1} from '../daemon-client.js'
import {escapeHtml} from '../view.js'

/** @typedef {import('../../../../packages/protocol/src/places').PlaceT} Place */

const MIN = 60_000
const WEEK = ['周日','周一','周二','周三','周四','周五','周六']

/** 时间:在干 = 现在;一小时内按分钟;今天按钟点;昨天;一周内按星期;更早按日子。
 * @param {Place} place @param {number} now */
export function placeTime(place, now) {
  if (place.moving) return '现在'
  const at = place.updatedAt
  if (at == null) return ''
  const d = now - at
  if (d < MIN) return '刚刚'
  if (d < 60 * MIN) return `${Math.floor(d / MIN)} 分钟前`
  const a = new Date(at), n = new Date(now)
  const day = (/** @type {Date} */ x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const days = Math.round((day(n) - day(a)) / 86_400_000)
  if (days === 0) return `${String(a.getHours()).padStart(2,'0')}:${String(a.getMinutes()).padStart(2,'0')}`
  if (days === 1) return '昨天'
  if (days < 7) return WEEK[a.getDay()] ?? ''
  return `${a.getMonth() + 1} 月 ${a.getDate()} 日`
}

/** 现状那一句:原料是 daemon 给的 line,按状态补一点人话(不用状态词)。 @param {Place} place */
export function placeLine(place) {
  const line = place.line?.trim() ?? ''
  if (!line) return ''
  if (place.waiting) return line
  if (place.status === 'working') return line.endsWith('…') ? line : `${line}…`
  if (place.status === 'failed') return `${line}(没做成)`
  if (place.status === 'stopped') return `${line}(停了)`
  return line
}

/** @param {Place} p */
function askHtml(p) {
  const w = p.waiting
  if (!w) return ''
  const more = w.count > 1 ? `<small>还有 ${w.count - 1} 件</small>` : ''
  if (w.kind === 'permission' && w.matterId && w.requestId) {
    return `<div class="place-ask"><button type="button" class="place-allow" data-place-decision="allow">允许</button><button type="button" data-place-decision="deny">不允许</button>${more}</div>`
  }
  return `<div class="place-ask"><button type="button" data-place-open>去回答</button>${more}</div>`
}

/** @param {Place[]} places @param {{selected:string|null,stale:boolean,now:number,popover?:boolean}} o */
export function renderPlacesHtml(places, { selected, stale, now, popover = true }) {
  const notice = stale ? '<p class="places-stale" role="status">家里的电脑暂时连不上,下面是上一次的样子</p>' : ''
  if (!places.length) return `${notice}<p class="places-empty">交代给 CC 的事,会按项目一行一行排在这里。</p>`
  const rows = places.map((p, i) => {
    const time = placeTime(p, now)
    const actionsId = `place-actions-${i}`
    const control = popover ? `popovertarget="${actionsId}"` : `aria-controls="${actionsId}" aria-expanded="false"`
    return `<li class="place" data-place-key="${escapeHtml(p.key)}" data-waiting="${!!p.waiting}" data-unseen="${p.unseen}" data-moving="${p.moving}" data-selected="${p.key === selected}">
      <button type="button" class="place-row" aria-pressed="${p.key === selected}">
        <span class="place-dot" aria-hidden="true"></span>
        <span class="place-name">${escapeHtml(p.name)}</span>
        <span class="place-line">${escapeHtml(placeLine(p))}</span>
        <span class="place-time">${escapeHtml(time)}</span>
      </button>
      <button class="place-more" type="button" ${control} aria-label="${escapeHtml(p.name)} 的更多操作">⋯</button>
      <div class="place-actions" id="${actionsId}" ${popover ? "popover" : "hidden"}>
        ${i > 0 ? '<button type="button" data-place-move="up">往上挪</button>' : ''}
        ${i < places.length - 1 ? '<button type="button" data-place-move="down">往下挪</button>' : ''}
        <button type="button" data-place-hide>收起这一行</button>
      </div>
      ${askHtml(p)}
    </li>`
  }).join('')
  return `${notice}<ol class="places-list" aria-label="现在">${rows}</ol>`
}

/**
 * @param {{
 *   root: HTMLElement,
 *   call: (method:any, path:string, body?:any, opts?:any) => Promise<any>,
 *   onSelect: (place: Place | null) => void,
 *   onOpen: (target: {kind:'matter'|'terminal', id:string}) => unknown,
 *   onPlaces?: (places: Place[]) => void,
 *   now?: () => number,
 *   intervalMs?: number,
 * }} o
 */
export function mountPlacesStrip({ root, call, onSelect, onOpen, onPlaces, now = Date.now, intervalMs = 3000 }) {
  /** @type {Place[]} */ let places = []
  /** @type {string|null} */ let selected = null
  const supportsPopover = typeof root.showPopover === 'function'
  const openActions = supportsPopover ? '.place-actions:popover-open' : '.place-actions[data-open]'
  let version = '', alive = true, busy = false, stale = false, acting = false, notified = ''
  const reflectOverflow = () => {
    const moreBelow = root.scrollHeight - root.clientHeight - root.scrollTop > 1
    root.toggleAttribute('data-more-below', moreBelow)
    if (root.parentElement?.classList.contains('places-strip')) root.parentElement.toggleAttribute('data-more-below', moreBelow)
  }
  const draw = () => {
    root.innerHTML = renderPlacesHtml(places, { selected, stale, now: now(), popover: supportsPopover })
    reflectOverflow()
  }
  const placeOf = (/** @type {Element|null} */ el) => places.find(p => p.key === el?.closest('[data-place-key]')?.getAttribute('data-place-key'))

  async function refresh() {
    if (!alive || busy || root.ownerDocument.visibilityState !== 'visible') return
    busy = true
    try {
      const data = await v1(call, V1.places.get, undefined, version ? { ifNoneMatch: version } : undefined)
      if (!alive) return
      if (data?.notModified) { if (stale) { stale = false; draw() } return }
      if (!Array.isArray(data?.places) || typeof data.version !== 'string') throw Error('invalid_places')
      const changed = data.version !== version || stale
      places = data.places; version = data.version; stale = false
      const current = selected ? places.find(p => p.key === selected) ?? null : null
      if (selected && !current) selected = null
      if (changed) { draw(); onPlaces?.(places) }
      // 只在选中的那个地方变了(换了一个 / 它带的 id 变了 / 它没了)时告诉说话,别每次刷新都重画说话。
      const ids = current ? JSON.stringify([current.key, current.name, current.matterIds, current.messageIds, current.sessionIds]) : ''
      if (ids !== notified) { notified = ids; onSelect(current) }
    } catch { if (alive) { stale = true; draw() } } finally { busy = false }
  }

  /** @param {Place|null} place */
  function select(place) {
    selected = place && place.key !== selected ? place.key : null
    const current = selected ? place : null
    for (const row of root.querySelectorAll('.place')) {
      const active = String(row.getAttribute('data-place-key') === selected)
      row.setAttribute('data-selected', active)
      row.querySelector('.place-row')?.setAttribute('aria-pressed', active)
    }
    notified = current ? JSON.stringify([current.key, current.name, current.matterIds, current.messageIds, current.sessionIds]) : ''
    onSelect(current)
    // 主人看了这个地方的说话,就算看过了:没看过的那几件记一下(加粗跟着消失)。
    if (current?.unseen) for (const id of current.matterIds.slice(0, 20)) void v1(call, V1.matter.seen, { body: { id, surface: 'desktop' } }).catch(() => {})
  }

  /** @param {Event} event */
  async function click(event) {
    const target = event.target instanceof Element ? event.target : null
    if (!target) return
    const place = placeOf(target)
    if (!place) return
    if (target.closest('.place-row')) { select(place); return }
    const more = target.closest('.place-more')
    const actions = more?.nextElementSibling
    if (!supportsPopover && actions instanceof HTMLElement) {
      const wasOpen = actions.hasAttribute('data-open')
      closeActions()
      if (!wasOpen) {
        actions.hidden = false
        actions.setAttribute('data-open', '')
        more?.setAttribute('aria-expanded', 'true')
        positionActions()
      }
      return
    }
    const decision = target.closest('[data-place-decision]')?.getAttribute('data-place-decision')
    if (decision && place.waiting?.matterId && place.waiting.requestId && !acting) {
      acting = true
      root.querySelectorAll(`[data-place-key="${CSS.escape(place.key)}"] [data-place-decision]`).forEach(b => b.setAttribute('disabled', ''))
      try { await v1(call, V1.workbench.permission, { body: { id: place.waiting.matterId, requestId: place.waiting.requestId, decision } }) }
      catch { stale = false } finally { acting = false; version = ''; await refresh() }
      return
    }
    if (target.closest('[data-place-open]') && place.waiting) {
      const w = place.waiting
      if (w.matterId) await onOpen({ kind: 'matter', id: w.matterId })
      else if (w.sessionId) await onOpen({ kind: 'terminal', id: w.sessionId })
      return
    }
    const move = target.closest('[data-place-move]')?.getAttribute('data-place-move')
    if (move) {
      closeActions()
      const at = places.findIndex(p => p.key === place.key)
      const to = move === 'up' ? Math.max(0, at - 1) : at + 1
      try { await v1(call, V1.places.move, { body: { key: place.key, to } }) } catch { /* 下次刷新照旧 */ }
      version = ''; await refresh(); return
    }
    if (target.closest('[data-place-hide]')) {
      closeActions()
      try { await v1(call, V1.places.hide, { body: { key: place.key, hidden: true } }) } catch { /* 下次刷新照旧 */ }
      if (selected === place.key) select(null)
      version = ''; await refresh()
    }
  }

  function closeActions() {
    const actions = root.querySelector(openActions)
    if (!(actions instanceof HTMLElement)) return
    if (supportsPopover) actions.hidePopover()
    else {
      const button = actions.previousElementSibling
      if (actions.contains(root.ownerDocument.activeElement) && button instanceof HTMLElement) button.focus()
      button?.setAttribute('aria-expanded', 'false')
      actions.removeAttribute('data-open')
      actions.hidden = true
    }
  }

  function positionActions() {
    const actions = root.querySelector(openActions)
    if (!(actions instanceof HTMLElement)) return
    const button = actions.previousElementSibling
    if (!button) return
    const anchor = button.getBoundingClientRect()
    const viewport = root.ownerDocument.documentElement
    const edge = 8, gap = 4
    const height = actions.offsetHeight
    const above = anchor.top - gap - edge
    const below = viewport.clientHeight - anchor.bottom - gap - edge
    const flip = height > below && above > below
    actions.style.left = `${Math.max(edge, anchor.right - actions.offsetWidth)}px`
    actions.style.top = `${Math.max(edge, flip ? anchor.top - gap - height : Math.min(anchor.bottom + gap, viewport.clientHeight - edge - height))}px`
  }

  const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(reflectOverflow) : null
  resize?.observe(root)
  const scroll = () => { reflectOverflow(); positionActions() }
  root.addEventListener('scroll', scroll)
  root.addEventListener('toggle', positionActions, true)
  root.ownerDocument.defaultView?.addEventListener('resize', scroll)
  const dismissOutside = (/** @type {Event} */ event) => {
    const actions = root.querySelector(openActions)
    const target = event.target
    if (actions && target instanceof Node && !actions.contains(target) && !actions.previousElementSibling?.contains(target)) closeActions()
  }
  const dismissOnEscape = (/** @type {KeyboardEvent} */ event) => {
    if (event.key === 'Escape') closeActions()
  }
  if (!supportsPopover) {
    root.ownerDocument.addEventListener('click', dismissOutside, true)
    root.ownerDocument.addEventListener('keydown', dismissOnEscape)
  }
  const visibility = () => { if (root.ownerDocument.visibilityState === 'visible') void refresh() }
  root.addEventListener('click', click)
  root.ownerDocument.addEventListener('visibilitychange', visibility)
  draw(); void refresh()
  const timer = setInterval(() => void refresh(), intervalMs)
  return {
    refresh,
    places: () => places.slice(),
    selected: () => selected,
    clear: () => { if (selected) select(null) },
    /** @param {string} key */
    selectKey(key) {
      const place = places.find(p => p.key === key)
      if (!place || key === selected) return
      select(place)
      root.querySelector(`[data-place-key="${CSS.escape(key)}"]`)?.scrollIntoView({ block: 'nearest' })
    },
    destroy() {
      alive = false
      clearInterval(timer)
      resize?.disconnect()
      closeActions()
      root.ownerDocument.removeEventListener('click', dismissOutside, true)
      root.ownerDocument.removeEventListener('keydown', dismissOnEscape)
      root.removeEventListener('scroll', scroll)
      root.removeEventListener('toggle', positionActions, true)
      root.ownerDocument.defaultView?.removeEventListener('resize', scroll)
      root.removeEventListener('click', click)
      root.ownerDocument.removeEventListener('visibilitychange', visibility)
    },
  }
}

// @ts-check
/// <reference lib="dom" />
// places-strip.js —— 正面上半:「现在」。一个地方(项目)一行,位置由主人定,不按状态重排
// (设计稿 docs/superpowers/specs/2026-11-18-cc-two-sides-design.md §3)。
//
// 一行三样:名字、一句现状、时间。不给状态起名字,只用三样人人会读的:
//   圆点 = 它在等你;没看过的那一句用墨色,看过后用次墨色;时间「现在」= 在干。
// 等你批准的,窄窗在行上答,宽窗在置顶卡片答;「去回答」打开那一件。
// 点一行 = 把下面的说话筛成这个地方;再点一次回到全部。
import {V1,v1} from '../daemon-client.js'
import {escapeHtml} from '../view.js'
import {deskSituation, deskSpeakerHtml} from './desk-page.js'

/** @typedef {import('../../../../packages/protocol/src/places').PlaceT} Place */

const MIN = 60_000
const WEEK_MS = 7 * 24 * 60 * MIN
const WEEK = ['周日','周一','周二','周三','周四','周五','周六']

/** 时间:在干 = 现在;一小时内按分钟;今天按钟点;昨天;一周内按星期;更早按日子。
 * @param {Pick<Place,'moving'|'updatedAt'>} place @param {number} now */
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
  // 坐回来:你上次看过这一行以后,除了这一句,还有几件也动过。
  const also = place.alsoChanged ? `,另有 ${place.alsoChanged} 件也动过` : ''
  if (place.waiting) return line + also
  if (place.status === 'working') return (line.endsWith('…') ? line : `${line}…`) + also
  if (place.status === 'failed') return `${line}(没做成)${also}`
  if (place.status === 'stopped') return `${line}(停了)${also}`
  return line + also
}

/** @param {Place} p */
function askHtml(p, card = false) {
  const w = p.waiting
  if (!w) return ''
  const more = w.count > 1 ? `<small>还有 ${w.count - 1} 件</small>` : ''
  if (w.kind === 'permission' && w.matterId && w.requestId) {
    return `<div class="place-ask"><button type="button" class="place-allow" data-place-decision="allow">允许</button><button type="button" data-place-decision="deny">不允许</button>${more}</div>`
  }
  return `<div class="place-ask"><button type="button" ${card ? 'class="place-allow" ' : ''}data-place-open>去回答</button>${more}</div>`
}

/** @param {Place} place @param {string|null} selected @param {number} now */
function isQuiet(place, selected, now) {
  return place.key !== selected && !place.waiting && !place.unseen && !place.alsoChanged && !place.moving
    && (place.updatedAt == null || now - place.updatedAt >= WEEK_MS)
}

/** @param {Place[]} places @param {{selected:string|null,stale:boolean,now:number,popover?:boolean,wide?:boolean}} o */
export function renderPlacesHtml(places, { selected, stale, now, popover = true, wide = false }) {
  const notice = stale ? '<p class="places-stale" role="status">家里的电脑暂时连不上,下面是上一次的样子</p>' : ''
  if (!places.length) return `${notice}<p class="places-empty">交代给 CC 的事,会按项目一行一行排在这里。</p>`
  const rows = places.map((p, i) => {
    const time = placeTime(p, now)
    const quiet = isQuiet(p, selected, now)
    const recap = wide ? p.recap : undefined
    const actionsId = `place-actions-${i}`
    const control = popover ? `popovertarget="${actionsId}"` : `aria-controls="${actionsId}" aria-expanded="false"`
    return `<li class="place" data-place-key="${escapeHtml(p.key)}" data-quiet="${quiet}" data-waiting="${!!p.waiting}" data-unseen="${p.unseen}" data-moving="${p.moving}"${wide && p.status === 'working' ? ' data-working' : ''} data-selected="${p.key === selected}">
      <button type="button" class="place-row" aria-pressed="${p.key === selected}">
        <span class="place-dot" aria-hidden="true"></span>
        <span class="place-name">${escapeHtml(p.name)}</span>
        <span class="place-line"${recap ? ` data-recap-source="${recap.source === 'cc' ? 'cc' : 'claude'}"` : ''}>${escapeHtml(recap?.text ?? placeLine(p))}</span>
        <span class="place-time">${escapeHtml(time)}</span>
      </button>
      <button class="place-more" type="button" ${control} aria-label="${escapeHtml(p.name)} 的更多操作">⋯</button>
      <div class="place-actions" id="${actionsId}" ${popover ? "popover" : "hidden"}>
        ${i > 0 ? '<button type="button" data-place-move="up">往上挪</button>' : ''}
        ${i < places.length - 1 ? '<button type="button" data-place-move="down">往下挪</button>' : ''}
        <button type="button" data-place-hide>收起这一行</button>
      </div>
      ${wide ? '' : askHtml(p)}
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
 *   onSituation?: (text:string, stale:boolean) => void,
 *   onPlaceMap?: (enabled: boolean) => void,
 *   onPlaces?: (places: Place[]) => void,
 *   waitingRoot?: HTMLElement,
 *   onCurrent?: (place: Place | null) => void,
 *   now?: () => number,
 *   intervalMs?: number,
 * }} o
 */
export function mountPlacesStrip({ root, call, onSelect, onOpen, onPlaces, onPlaceMap, onSituation, waitingRoot, onCurrent, now = Date.now, intervalMs = 3000 }) {
  /** @type {Place[]} */ let places = []
  /** @type {Pick<Place, 'key' | 'name'>[]} */ let hidden = []
  let hiddenOpen = false
  let writingHidden = false
  /** @type {string|null} */ let selected = null
  const supportsPopover = typeof root.showPopover === 'function'
  const openActions = supportsPopover ? '.place-actions:popover-open' : '.place-actions[data-open]'
  let wide = false, quietOpen = false, waitingOpen = false
  let readEpoch = 0
  let version = '', alive = true, stale = false, acting = false, notified = '', seenMark = ''
  /** @type {{key:string,request?:string}|null} */ let inlineWaiting = null
  let waitingMarkup = ''
  /** @type {Promise<void>|null} */ let inFlight = null
  const reflectOverflow = () => {
    const moreBelow = root.scrollHeight - root.clientHeight - root.scrollTop > 1
    root.toggleAttribute('data-more-below', moreBelow)
    if (root.parentElement?.classList.contains('places-strip')) root.parentElement.toggleAttribute('data-more-below', moreBelow)
  }
  function drawWaiting() {
    if (!waitingRoot) return
    // 在一件事的页面里(宽窗口选着一个地方):顶上只留这件事自己的纸条;别的地方的看左栏的圆点和 CC 那一句,不压在正文上面。
    const waiting = wide ? places.filter(p => p.waiting && (!selected || selected === p.key) && !(inlineWaiting?.key === p.waiting.itemKey
      && (!inlineWaiting.request || !p.waiting.requestId || p.waiting.requestId === inlineWaiting.request))) : []
    const more = waiting.length - 2
    const toggle = more > 0 ? `<button class="desk-text-button" type="button" data-waiting-toggle aria-expanded="${waitingOpen}">${waitingOpen ? '收起其余等你定的' : `还有 ${more} 件等你定`}</button>` : ''
    const visibleWaiting = waiting.slice(0, waitingOpen ? waiting.length : 2)
    const cards = visibleWaiting.map(p => {
      const note = p.waiting
      return `<div class="desk-waiting-row">
        ${deskSpeakerHtml('cc')}
        <div class="desk-waiting-card" data-place-key="${escapeHtml(p.key)}" data-item-key="${escapeHtml(note?.itemKey ?? '')}" data-request-id="${escapeHtml(note?.requestId ?? '')}">
          <div class="desk-waiting-label">这件要你定 · ${escapeHtml(p.name)}</div>
          <div class="desk-waiting-question">${escapeHtml(note?.summary ?? '')}</div>
          ${askHtml(p, true)}
        </div>
      </div>`
    }).join('')
    waitingRoot.hidden = waiting.length === 0
    if (waitingMarkup !== cards + toggle) {
      waitingMarkup = cards + toggle
      waitingRoot.innerHTML = waitingMarkup
    }
    // Opinions can arrive on a later poll. Keep the card controls mounted.
    waitingRoot.querySelectorAll('.desk-waiting-card').forEach((card, index) => {
      const note = visibleWaiting[index]?.waiting
      for (const [className, text] of Object.entries({
        'desk-waiting-opinion': note?.ccOpinion && `我的意见(只看了这条请求)：${note.ccOpinion}`,
        'desk-waiting-reason': note?.questionReason && `为什么来问你：${note.questionReason}`,
      })) {
        let line = card.querySelector(`.${className}`)
        if (!text) {
          line?.remove()
        } else if (!line) {
          line = card.ownerDocument.createElement('div')
          line.className = className
          line.textContent = text
          if (className === 'desk-waiting-opinion') card.querySelector('.desk-waiting-question')?.after(line)
          else card.querySelector('.place-ask')?.before(line)
        } else if (line.textContent !== text) {
          line.textContent = text
        }
      }
    })
    waitingRoot.querySelectorAll('[data-place-decision]').forEach(b => b.toggleAttribute('disabled', acting))
  }

  const draw = () => {
    const active = root.ownerDocument.activeElement
    const focused = active?.closest('.place-row, .place-more')
    const focusKey = focused?.closest('[data-place-key]')?.getAttribute('data-place-key')
    const at = now()
    root.innerHTML = renderPlacesHtml(places, { selected, stale, now: at, popover: supportsPopover, wide })
    const count = root.querySelectorAll('[data-quiet="true"]').length
    root.toggleAttribute('data-quiet-expanded', quietOpen)
    if (wide && count) root.insertAdjacentHTML('beforeend', `<button class="desk-text-button desk-quiet-toggle" type="button" data-quiet-toggle aria-expanded="${quietOpen}">${quietOpen ? '收起这周没动的' : `这周没动的 ${count} 处`}</button>`)
    if (hidden.length) {
      root.insertAdjacentHTML('beforeend', `<button class="desk-text-button places-hidden-toggle" type="button" data-hidden-toggle aria-expanded="${hiddenOpen}">收起的 ${hidden.length} 处</button>
        <ul class="places-hidden-list" ${hiddenOpen ? '' : 'hidden'}>${hidden.map(({key, name}) =>
          `<li><span>${escapeHtml(name)}</span><button class="desk-text-button" type="button" data-place-restore="${escapeHtml(key)}">放回来</button></li>`).join('')}</ul>`)
    }
    if (wide && focusKey) {
      const control = focused?.classList.contains('place-more') ? '.place-more' : '.place-row'
      root.querySelector(`[data-place-key="${CSS.escape(focusKey)}"] ${control}`)?.closest('button')?.focus({ preventScroll: true })
    }
    if (acting) root.querySelectorAll('[data-place-decision]').forEach(b => b.setAttribute('disabled', ''))
    drawWaiting()
    const waitingCount = places.reduce((sum, p) => sum + (p.waiting?.count ?? 0), 0)
    const movingCount = places.filter(p => p.moving || p.status === 'working').length
    onSituation?.(version && !stale ? deskSituation(waitingCount, movingCount) : '', stale)
    onCurrent?.(places.find(p => p.key === selected) ?? null)
    reflectOverflow()
  }
  const placeOf = (/** @type {Element|null} */ el) => places.find(p => p.key === el?.closest('[data-place-key]')?.getAttribute('data-place-key'))

  async function refresh() {
    if (!alive || root.ownerDocument.visibilityState !== 'visible') return
    if (!inFlight) inFlight = readPlaces().finally(() => { inFlight = null })
    await inFlight
  }

  async function refreshAfterWrite() {
    ++readEpoch
    await inFlight
    version = ''
    await refresh()
  }

  async function readPlaces() {
    const epoch = readEpoch
    try {
      const data = await v1(call, V1.places.get, undefined, version ? { ifNoneMatch: version } : undefined)
      if (!alive || epoch !== readEpoch) return
      if (data?.notModified) {
        if (stale) { stale = false; draw() }
        else if (wide) {
          const at = now()
          const list = root.querySelectorAll('.place')
          if (places.some((p, i) => isQuiet(p, selected, at) && list[i]?.getAttribute('data-quiet') === 'false')) draw()
        }
        return
      }
      if (!Array.isArray(data?.places) || typeof data.version !== 'string') throw Error('invalid_places')
      const changed = data.version !== version || stale
      hidden = data.hidden ?? []
      if (!hidden.length) hiddenOpen = false
      places = data.places; version = data.version; stale = false
      onPlaceMap?.(data.labs?.placeMap === true)
      const current = selected ? places.find(p => p.key === selected) ?? null : null
      if (selected && !current) selected = null
      if (changed) { draw(); onPlaces?.(places) }
      // 只在选中的那个地方变了(换了一个 / 它带的 id 变了 / 它没了)时告诉说话,别每次刷新都重画说话。
      const ids = current ? JSON.stringify([current.key, current.name, current.matterIds, current.messageIds, current.sessionIds]) : ''
      if (ids !== notified) { notified = ids; onSelect(current) }
      // 选着这一行时它又动了:主人正看着,也算看过。
      if (current) markSeen(current)
    } catch { if (alive && epoch === readEpoch && !stale) { stale = true; draw() } }
  }

  /** 主人看了这一行(点开 / 选着时又动了 / 从这一行打开一件):daemon 记下时刻,下次那一句从这以后说起。 @param {Place} place */
  function markSeen(place, opened = false) {
    const mark = `${place.key}@${place.updatedAt ?? ''}`
    // Polls are deduplicated; coming back to an unchanged place is still the owner looking.
    if (mark === seenMark && !opened) return
    seenMark = mark
    void v1(call, V1.places.seen, { body: { key: place.key } }).catch(() => { seenMark = '' })
  }

  /** @param {Place|null} place */
  function select(place) {
    if (wide && place?.key === selected) { onSelect(place); return }
    selected = place && place.key !== selected ? place.key : null
    const current = selected ? place : null
    if (wide) {
      waitingOpen = false
      draw()
    } else for (const row of root.querySelectorAll('.place')) {
      const active = String(row.getAttribute('data-place-key') === selected)
      row.setAttribute('data-selected', active)
      row.querySelector('.place-row')?.setAttribute('aria-pressed', active)
    }
    notified = current ? JSON.stringify([current.key, current.name, current.matterIds, current.messageIds, current.sessionIds]) : ''
    onSelect(current)
    if (current) markSeen(current, true)
    // 主人看了这个地方的说话,就算看过了:没看过的那几件记一下(那一句恢复次墨色)。
    if (current?.unseen) for (const id of current.matterIds.slice(0, 20)) void v1(call, V1.matter.seen, { body: { id, surface: 'desktop' } }).catch(() => {})
  }

  /** @param {Event} event */
  async function click(event) {
    const target = event.target instanceof Element ? event.target : null
    if (!target) return
    const hiddenToggle = target.closest('[data-hidden-toggle]')
    if (hiddenToggle) {
      hiddenOpen = !hiddenOpen
      hiddenToggle.setAttribute('aria-expanded', String(hiddenOpen))
      const list = root.querySelector('.places-hidden-list')
      list?.toggleAttribute('hidden', !hiddenOpen)
      // 入口在名单最底下:展开出来的清单不滚进视野,看着就像点了没反应。
      if (hiddenOpen) list?.scrollIntoView?.({ block: 'nearest' })
      reflectOverflow()
      return
    }
    const restore = target.closest('[data-place-restore]')?.getAttribute('data-place-restore')
    if (restore) {
      await setHidden(restore, false)
      return
    }
    if (target.closest('[data-quiet-toggle]')) {
      quietOpen = !quietOpen
      root.toggleAttribute('data-quiet-expanded', quietOpen)
      const button = target.closest('[data-quiet-toggle]')
      button?.setAttribute('aria-expanded', String(quietOpen))
      if (button) button.textContent = quietOpen ? '收起这周没动的' : `这周没动的 ${root.querySelectorAll('[data-quiet="true"]').length} 处`
      reflectOverflow()
      return
    }
    if (target.closest('[data-waiting-toggle]')) {
      waitingOpen = !waitingOpen
      drawWaiting()
    const waitingCount = places.reduce((sum, p) => sum + (p.waiting?.count ?? 0), 0)
    const movingCount = places.filter(p => p.moving || p.status === 'working').length
    onSituation?.(version && !stale ? deskSituation(waitingCount, movingCount) : '', stale)
      const toggle = waitingRoot?.querySelector('button[data-waiting-toggle]')
      if (toggle instanceof HTMLButtonElement) toggle.focus()
      return
    }
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
      for (const host of [root, waitingRoot]) host?.querySelectorAll('[data-place-decision]').forEach(b => b.setAttribute('disabled', ''))
      try { await v1(call, V1.workbench.permission, { body: { id: place.waiting.matterId, requestId: place.waiting.requestId, decision } }) }
      catch { /* 下次刷新照旧 */ } finally {
        await refreshAfterWrite()
        acting = false
        for (const host of [root, waitingRoot]) host?.querySelectorAll('[data-place-decision]').forEach(b => b.removeAttribute('disabled'))
      }
      return
    }
    if (target.closest('[data-place-open]') && place.waiting) {
      markSeen(place)
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
      await refreshAfterWrite(); return
    }
    if (target.closest('[data-place-hide]')) {
      closeActions()
      await setHidden(place.key, true)
    }
  }

  /** @param {string} key @param {boolean} hide */
  async function setHidden(key, hide) {
    if (writingHidden) return
    writingHidden = true
    try {
      await v1(call, V1.places.hide, { body: { key, hidden: hide } })
      if (hide && selected === key) select(null)
      await refreshAfterWrite()
      if (hide && hidden.some(place => place.key === key)) {
        root.querySelector('[data-hidden-toggle]')?.scrollIntoView?.({ block: 'nearest' })
      }
    } catch { /* 下次刷新照旧 */ }
    finally { writingHidden = false }
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
  waitingRoot?.addEventListener('click', click)
  root.ownerDocument.addEventListener('visibilitychange', visibility)
  draw(); void refresh()
  const timer = setInterval(() => void refresh(), intervalMs)
  return {
    refresh,
    refreshAfterWrite,
    closeActions,
    /** @param {boolean} enabled */
    setWide(enabled) {
      if (wide === enabled) return
      wide = enabled
      draw()
    },
    places: () => places.slice(),
    selected: () => selected,
    /** @param {{key:string,request?:string}|null} value */
    setInlineWaiting(value) {
      if (inlineWaiting?.key === value?.key && inlineWaiting?.request === value?.request) return
      inlineWaiting = value
      drawWaiting()
    },
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
      waitingRoot?.removeEventListener('click', click)
      root.ownerDocument.removeEventListener('visibilitychange', visibility)
    },
  }
}

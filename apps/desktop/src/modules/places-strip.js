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

/** @param {Place[]} places @param {{selected:string|null,stale:boolean,now:number}} o */
export function renderPlacesHtml(places, { selected, stale, now }) {
  const notice = stale ? '<p class="places-stale" role="status">家里的电脑暂时连不上,下面是上一次的样子</p>' : ''
  if (!places.length) return `${notice}<p class="places-empty">交代给 CC 的事,会按项目一行一行排在这里。</p>`
  const rows = places.map((p, i) => {
    const time = placeTime(p, now)
    return `<li class="place" data-place-key="${escapeHtml(p.key)}" data-waiting="${!!p.waiting}" data-unseen="${p.unseen}" data-moving="${p.moving}" data-selected="${p.key === selected}">
      <button type="button" class="place-row" aria-pressed="${p.key === selected}">
        <span class="place-dot" aria-hidden="true"></span>
        <span class="place-name">${escapeHtml(p.name)}</span>
        <span class="place-line">${escapeHtml(placeLine(p))}</span>
        <span class="place-time">${escapeHtml(time)}</span>
      </button>
      <details class="place-more"><summary aria-label="${escapeHtml(p.name)} 的更多操作">⋯</summary><div>
        ${i > 0 ? '<button type="button" data-place-move="up">往上挪</button>' : ''}
        ${i < places.length - 1 ? '<button type="button" data-place-move="down">往下挪</button>' : ''}
        <button type="button" data-place-hide>收起这一行</button>
      </div></details>
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
 *   now?: () => number,
 *   intervalMs?: number,
 * }} o
 */
export function mountPlacesStrip({ root, call, onSelect, onOpen, now = Date.now, intervalMs = 3000 }) {
  /** @type {Place[]} */ let places = []
  /** @type {string|null} */ let selected = null
  let version = '', alive = true, busy = false, stale = false, acting = false, notified = ''
  const draw = () => { root.innerHTML = renderPlacesHtml(places, { selected, stale, now: now() }) }
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
      if (changed) draw()
      // 只在选中的那个地方变了(换了一个 / 它带的 id 变了 / 它没了)时告诉说话,别每次刷新都重画说话。
      const ids = current ? JSON.stringify([current.key, current.matterIds, current.messageIds, current.sessionIds]) : ''
      if (ids !== notified) { notified = ids; onSelect(current) }
    } catch { if (alive) { stale = true; draw() } } finally { busy = false }
  }

  /** @param {Place|null} place */
  function select(place) {
    selected = place && place.key !== selected ? place.key : null
    const current = selected ? place : null
    draw()
    notified = current ? JSON.stringify([current.key, current.matterIds, current.messageIds, current.sessionIds]) : ''
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
      const at = places.findIndex(p => p.key === place.key)
      const to = move === 'up' ? Math.max(0, at - 1) : at + 1
      try { await v1(call, V1.places.move, { body: { key: place.key, to } }) } catch { /* 下次刷新照旧 */ }
      version = ''; await refresh(); return
    }
    if (target.closest('[data-place-hide]')) {
      try { await v1(call, V1.places.hide, { body: { key: place.key, hidden: true } }) } catch { /* 下次刷新照旧 */ }
      if (selected === place.key) select(null)
      version = ''; await refresh()
    }
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
    destroy() { alive = false; clearInterval(timer); root.removeEventListener('click', click); root.ownerDocument.removeEventListener('visibilitychange', visibility) },
  }
}

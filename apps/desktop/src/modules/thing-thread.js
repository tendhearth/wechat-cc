// @ts-check
import { wireDeskDisclosure } from './desk-disclosure.js'
import { executorName } from './executor-names.js'
import { mountLabMap } from './lab-map.js'
import { V1, v1 } from '../daemon-client.js'
import { createAgentAvatars } from '../shared/agent-avatars.js'
import { placeTime } from './places-strip.js'
import { showWorkDetail } from './conversation-work-detail.js'
import { mountTerminalThread } from './terminal-thread.js'
import { initialSession, placeSessions, splitSessions } from './thing-thread-model.js'
import { escapeWorkbenchHtml as esc } from './workbench-markdown.js'

const { agentAvatarsHtml, agentName } = createAgentAvatars()
/** @typedef {import('./thing-thread-model.js').Place} Place */
/** @typedef {import('./thing-thread-model.js').RosterItem} Item */
/** @typedef {import('./desk-history.js').DeskDetail} Target */
/** @typedef {import('./terminal-thread.js').Call} Call */

/** @param {Item} item */
function agentOf(item) {
  return item.agents.find(agent => agent.current) ?? item.agents[0]
}

/** @param {Item} item */
function stateOf(item) {
  if (item.group === 'waiting') return '等你定'
  if (item.group === 'working') return '正在做'
  return item.endedAt != null || !(item.kind === 'terminal' || item.terminal) ? '已经结束' : '停着'
}

/**
 * @param {{root:HTMLElement,call:Call,openTask:(id:string,host:HTMLElement)=>Promise<void>,closeTask:()=>void,
 * home:()=>void,onLabWrite?:()=>void,onSession:()=>void,onWaiting:(value:{key:string,request?:string}|null)=>void}} options
 */
export function mountThingThread({root,call,openTask,closeTask,home,onLabWrite,onSession,onWaiting}) {
  const heading = /** @type {HTMLElement} */ (root.querySelector('.thing-name'))
  const status = /** @type {HTMLElement} */ (root.querySelector('.thing-status'))
  const agentLabel = /** @type {HTMLElement} */ (status.querySelector('.thing-agent'))
  const stateLabel = /** @type {HTMLElement} */ (status.querySelector('.thing-state'))
  const tabs = /** @type {HTMLElement} */ (root.querySelector('.thing-sessions'))
  const tray = /** @type {HTMLElement} */ (root.querySelector('.thing-content'))
  const mapHost = /** @type {HTMLElement|null} */ (root.querySelector('.lab-map'))
  const switcher = /** @type {HTMLElement|null} */ (root.querySelector('.lab-map-seg'))
  const toggle = /** @type {HTMLButtonElement|null} */ (document.getElementById('desk-lab-map'))
  const note = document.getElementById('desk-lab-map-note')
  const labDescription = note?.textContent ?? ''
  /** @type {Set<string>} */ const maps = new Set()
  /** @type {Set<string>} */ const aspectMaps = new Set()
  let experiment = false, alive = true
  /** @type {(()=>void)|undefined} */ let stopMap
  /** @type {{element:Element,top:number}|undefined} */ let reading
  /** @type {Map<string,{host:HTMLElement,thread:ReturnType<typeof mountTerminalThread>}>} */
  const terminals = new Map()
  /** @type {Map<string,string>} */ const remembered = new Map()
  /** @type {Place|null} */ let place = null
  /** @type {Item[]} */ let roster = []
  /** @type {Item|undefined} */ let selected
  /** @type {(()=>void)|undefined} */ let dispose
  /** @type {Item|undefined} */ let linked
  let generation = 0, tabsMarkup = ''
  /** @type {AbortController|undefined} */ let menuListeners
  /** @param {Place} where */
  const rowsFor = where => placeSessions(where, roster)
  /** @type {{key:string,request?:string}|null} */ let inlineWaiting = null

  // 在图上时线是藏着的,那张就地的卡看不见:这时不拦顶上的纸条。
  function tellWaiting() { onWaiting(stopMap ? null : inlineWaiting) }

  /** @param {import('./lab-map-model.js').MapItem} item */
  function mapTarget(item) {
    if (!place) return undefined
    const { matterId, sessionId } = item.from
    const items = rowsFor(place)
    return items.find(row => matterId && row.kind === 'matter' && row.id === matterId)
      ?? items.find(row => sessionId && (row.terminal?.sessionId === sessionId || row.kind === 'terminal' && row.id === sessionId))
  }

  /** @param {import('./lab-map-model.js').MapItem} item */
  function mapLink(item) {
    if (!place) return undefined
    const { matterId, sessionId } = item.from
    return (matterId ? linkedItem(place,{kind:'matter',id:matterId}) : undefined)
      ?? (sessionId ? linkedItem(place,{kind:'terminal',id:sessionId}) : undefined)
  }

  /** @param {import('@wechat-cc/protocol').PlaceOutlineSourceT} source */
  function outlineTarget(source) {
    if (!place || source.kind !== 'session' || !source.sessionId) return undefined
    const id = source.sessionId
    const matches = (/** @type {Item} */ row) => (row.terminal?.sessionId ?? (row.kind === 'terminal' ? row.id : undefined)) === id
    return rowsFor(place).find(matches)
      ?? placeSessions({...place,sessions:undefined}, roster).find(matches)
      ?? linkedItem(place,{kind:'terminal',id})
  }

  /** @param {Item} target @param {Item|undefined} [link] */
  function returnToLine(target, link) {
    if (!place) return
    maps.delete(place.key)
    open(place, target.key, link)
    onSession()
    const tab = tabs.hidden ? null : /** @type {HTMLElement|null} */ (tabs.querySelector('[aria-pressed="true"]'))
    const focus = tab ?? heading
    focus.focus({ preventScroll: true })
  }

  function stopGraph() {
    if (!stopMap || !mapHost) return
    stopMap()
    stopMap = undefined
    mapHost.hidden = true
    tray.hidden = false
    root.removeAttribute('data-lab-map')
    drawTabs()
    tellWaiting()
    if (reading?.element.isConnected) reading.element.scrollTop = reading.top
    reading = undefined
  }

  function reflectGraph() {
    if (!mapHost || !switcher) return
    const enabled = experiment && !!place
    switcher.hidden = !enabled
    if (enabled && place && maps.has(place.key)) {
      if (!stopMap) {
        const element = tray.querySelector('.thing-terminal:not([hidden]) .thing-scroll')
        reading = element ? {element, top:element.scrollTop} : undefined
        tray.hidden = tabs.hidden = true
        root.setAttribute('data-lab-map', '')
        mapHost.hidden = false
        const { key } = place
        stopMap = mountLabMap({host:mapHost,key,call,
          aspects:aspectMaps.has(key),
          remember:aspects => { if (aspects) aspectMaps.add(key); else aspectMaps.delete(key) },
          canJumpSource:source => !!outlineTarget(source),
          jumpSource:source => {
            const target = outlineTarget(source)
            if (target && place) returnToLine(target, rowsFor(place).some(row => row.key === target.key) ? undefined : target)
          },
          agent:item => {
            const row = mapTarget(item)
            const agent = row && agentOf(row)
            return agent ? agentName(agent.id, () => agent.name || executorName(agent.id)) : ''
          },
          canJump:item => !!mapTarget(item) || !!mapLink(item),
          jump:item => {
            const row = mapTarget(item)
            const target = row ?? mapLink(item)
            if (target) returnToLine(target, row ? undefined : target)
          },
        })
        tellWaiting()
      }
    } else stopGraph()
    for (const button of switcher.querySelectorAll('button')) {
      button.setAttribute('aria-pressed', String((button.dataset.mapView === 'map') === !!stopMap))
    }
  }

  /** @param {boolean} enabled */
  function setPlaceMap(enabled) {
    if (enabled === experiment) return
    experiment = enabled
    toggle?.setAttribute('aria-checked', String(enabled))
    if (!enabled) maps.clear()
    reflectGraph()
  }

  async function togglePlaceMap() {
    if (!toggle || toggle.disabled) return
    toggle.disabled = true
    if (note) note.textContent = labDescription
    try {
      const result = await v1(call, V1.places.labs, { body: { placeMap: !experiment } })
      if (result?.ok !== true || typeof result.placeMap !== 'boolean') throw Error('invalid_labs')
      if (!alive) return
      setPlaceMap(result.placeMap)
      onLabWrite?.()
    } catch {
      if (alive && note) note.textContent = '没改成，再试一次。'
    } finally {
      toggle.disabled = false
    }
  }
  toggle?.addEventListener('click', togglePlaceMap)
  switcher?.addEventListener('click', event => {
    const button = event.target instanceof HTMLButtonElement ? event.target : null
    if (!button || !place || !experiment) return
    if (button.dataset.mapView === 'map') maps.add(place.key)
    else maps.delete(place.key)
    reflectGraph()
  })

  /** @param {string} name @param {string} state */
  function showStatus(name, state) {
    if (agentLabel.textContent !== name) agentLabel.textContent = name
    if (stateLabel.textContent === state) return
    stateLabel.textContent = state
    stateLabel.hidden = !state
    stateLabel.dataset.tone = state === '等你定' ? 'waiting' : state === '正在做' ? 'working' : 'idle'
  }

  // A tab needs room for a readable first sentence, so how many sit side by side follows the width.
  let slots = 0
  const tabSlots = () => Math.max(2, Math.min(6, Math.floor(((tabs.clientWidth || 880) - 96) / 190)))
  const tabSize = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { if (alive && place && !tabs.hidden && tabSlots() !== slots) drawTabs() }) : null
  tabSize?.observe(tabs)

  function drawTabs() {
    if (!place) return
    const items = rowsFor(place)
    if (linked && selected?.key === linked.key && !items.some(item => item.key === linked?.key)) items.push(linked)
    tabs.hidden = !!stopMap || items.length < (items[0]?.endedAt != null ? 1 : 2)
    if (tabs.hidden) return
    const now = Date.now()
    slots = tabSlots()
    const {visible, earlier} = splitSessions(items, selected?.key, slots)
    const button = (/** @type {Item} */ item, inMenu = false) => {
      const agent = agentOf(item)
      const name = agentName(agent?.id ?? '', () => agent?.name || executorName(agent?.id ?? ''))
      const time = placeTime({ moving:false, updatedAt:item.updatedAt }, now)
      const terminal = item.kind === 'terminal' || item.terminal
      const title = terminal ? [item.sessionTitle || name, time].filter(Boolean).join(' · ') : item.title
      const ended = item.endedAt != null
      const state = ended ? '已经结束' : item.status === 'waiting' ? '等你定' : item.status === 'working' ? '正在做' : '停着'
      const label = terminal ? `${title} · ${state}` : title
      const accessible = terminal ? [name, item.sessionTitle, time, state].filter(Boolean).join('，') : ''
      const tooltip = terminal ? [name, item.sessionTitle, time].filter(Boolean).join(' · ') : ''
      // The first sentence may be cut short; the time (and, in the menu, the state) beside it is not.
      const lead = item.sessionTitle || name
      const body = terminal && lead && time
        ? `<span>${esc(lead)}</span><small class="thing-session-time"> · ${esc(inMenu ? `${time} · ${state}` : time)}</small>`
        : `<span>${esc(inMenu ? label : title)}</span>`
      return `<button type="button" data-thread-session="${esc(item.key)}" data-group="${item.group}"${ended ? ' data-ended' : ''}${accessible ? ` aria-label="${esc(accessible)}"` : ''}${tooltip ? ` title="${esc(tooltip)}"` : ''} aria-pressed="${selected?.key === item.key}">${agentAvatarsHtml([agent?.id])}${body}${ended ? '' : '<i aria-hidden="true"></i>'}</button>`
    }
    const markup = visible.map(item => button(item)).join('') + (earlier.length
      ? `<details class="thing-session-menu"><summary data-thread-more>更早的 ${earlier.length} 次</summary><div>${earlier.map(item => button(item, true)).join('')}</div></details>`
      : '')
    if (tabsMarkup === markup) return
    const focus = document.activeElement
    const key = focus instanceof HTMLElement && tabs.contains(focus) ? focus.dataset.threadSession ?? '' : null
    const menuWasOpen = !!tabs.querySelector('.thing-session-menu[open]')
    menuListeners?.abort()
    tabsMarkup = markup
    tabs.innerHTML = markup
    const menu = tabs.querySelector('details')
    if (menu) {
      menu.open = menuWasOpen
      menuListeners = new AbortController()
      wireDeskDisclosure(menu, menuListeners.signal)
    }
    if (key !== null) {
      const next = /** @type {HTMLElement|null} */ (tabs.querySelector(key ? `[data-thread-session="${CSS.escape(key)}"]` : '[data-thread-more]'))
      next?.focus({preventScroll:true})
    }
  }

  /** @param {Item} item @param {string} id */
  function showTerminal(item, id) {
    const key = item.key
    const homePlace = place
    let cached = terminals.get(key)
    if (!cached) {
      const host = document.createElement('section')
      host.className = 'thing-terminal'
      tray.append(host)
      const thread = mountTerminalThread({host,call,id,agent:agentOf(item)?.id ?? '',ended:() => selected?.key === key && selected.endedAt != null,place:() => place?.key === homePlace?.key && place ? place : /** @type {Place} */ (homePlace),
        onStatus: (name,state) => {if (selected?.key === key && place) showStatus(name,state)},
        onWaiting: request => {
          if (selected?.key !== key || !place) return
          inlineWaiting = request ? {key,request} : null
          tellWaiting()
        },
      })
      cached = {host,thread}
      terminals.set(key,cached)
    }
    cached.host.hidden = false
    cached.thread.reflect()
    void cached.thread.refresh()
  }

  function leaveContent() {
    generation++
    dispose?.()
    dispose = undefined
    for (const child of [...tray.children]) {
      if (child instanceof HTMLElement && child.classList.contains('thing-terminal')) child.hidden = true
      else child.remove()
    }
    inlineWaiting = null
    tellWaiting()
  }

  /** @param {Item|undefined} item */
  function choose(item) {
    leaveContent()
    selected = item
    if (!place) return
    if (!item) {
      showStatus('','')
      const empty = document.createElement('div')
      empty.className = 'thing-empty'
      empty.innerHTML = '<p>这里还没有动过。对 CC 说一声就能开始。</p><button type="button" class="desk-text-button">去和 CC 说</button>'
      empty.querySelector('button')?.addEventListener('click',home)
      tray.append(empty)
      return
    }
    const agent = agentOf(item)
    showStatus(agentName(agent?.id ?? '', () => agent?.name || executorName(agent?.id ?? '')), stateOf(item))
    remembered.set(place.key,item.key)
    if (item.endedAt != null && item.terminal) { showTerminal(item,item.terminal.sessionId); return }
    if (item.kind === 'terminal') { showTerminal(item,item.id); return }
    if (terminals.has(item.key) && item.terminal) { showTerminal(item,item.terminal.sessionId); return }
    const attempt = generation
    const detailHost = document.createElement('section')
    detailHost.className = 'thing-detail'
    const loading = document.createElement('p')
    loading.className = 'thing-detail-note'
    loading.textContent = '正在读取…'
    detailHost.append(loading)
    tray.append(detailHost)
    void (async () => {
      try {
        const detail = await v1(call,V1.matter.get,{query:{id:item.id}})
        if (attempt !== generation) return
        if (detail.matter?.id !== item.id) throw Error('matter_not_found')
        const bindings = (detail.bindings ?? []).filter((/** @type {{surface:string}} */ binding) => binding.surface === 'cli')
        const terminalId = bindings[0]?.surfaceKey ?? item.terminal?.sessionId
        if (detail.matter.kind === 'terminal' && terminalId && bindings.length <= 1 && !detail.terminalParticipants?.length) {
          detailHost.remove()
          showTerminal(item,terminalId)
        } else if (detail.matter.kind === 'task') {
          loading.remove()
          dispose = closeTask
          inlineWaiting = {key:item.key}
          tellWaiting()
          await openTask(item.id,detailHost)
        } else {
          loading.remove()
          const cleanup = await showWorkDetail(call,detail,detailHost)
          if (attempt === generation) dispose = cleanup
          else cleanup?.()
        }
      } catch {
        if (attempt !== generation) return
        dispose?.()
        dispose = undefined
        inlineWaiting = null
        tellWaiting()
        loading.textContent = '这件事暂时读不到。'
        detailHost.replaceChildren(loading)
      }
    })()
  }

  /** @param {Place} next @param {string} [key] @param {Item} [direct] */
  function open(next,key,direct) {
    const changed = place?.key !== next.key
    if (changed) { stopGraph(); linked = undefined }
    if (direct) linked = direct
    else if (key) linked = undefined
    place = next
    if (heading.textContent !== next.name) heading.textContent = next.name
    const items = rowsFor(next)
    const wanted = key ?? (changed ? remembered.get(next.key) : selected?.key)
    const item = items.find(candidate => candidate.key === wanted)
      ?? (linked?.key === wanted ? linked : undefined) ?? initialSession(items,wanted)
    if (changed || selected?.key !== item?.key) {
      choose(item)
    } else {
      selected = item
      const terminal = item && terminals.get(item.key)
      if (terminal) terminal.thread.reflect()
      else if (item?.endedAt != null) choose(item)
      else if (item) showStatus(executorName(agentOf(item)?.id ?? ''),stateOf(item))
    }
    drawTabs()
    reflectGraph()
  }

  tabs.addEventListener('click',event => {
    const button = event.target instanceof Element ? event.target.closest('button') : null
    if (!button || !place) return
    const key = button.dataset.threadSession
    if (!key || key === selected?.key) return
    open(place,key)
    const tab = /** @type {HTMLElement|null} */ (tabs.querySelector(`[data-thread-session="${CSS.escape(key)}"]`))
    tab?.focus({preventScroll:true})
    onSession()
  })

  /** @param {Place} where @param {Target} target @returns {Item|undefined} */
  function linkedItem(where, target) {
    const belongs = target.kind === 'matter' ? where.matterIds.includes(target.id) : where.sessionIds.includes(target.id)
    if (!belongs) return
    const key = `${target.kind}:${target.id}`
    const waiting = where.waiting?.itemKey === key
    return {...target,key,title:where.name,group:waiting ? 'waiting' : 'back',
      status:waiting ? 'waiting' : 'replied',agents:[],quiet:false,unseen:where.unseen,updatedAt:where.updatedAt ?? 0}
  }

  return {
    open,
    /** @param {string} key */
    forgetView(key) { maps.delete(key); reflectGraph() },
    close() {
      if (!place) return
      stopGraph()
      leaveContent()
      place = null
      selected = undefined
      linked = undefined
      reflectGraph()
    },
    /** @param {Item[]} next */
    setRoster(next) {
      roster = next
      if (place) {
        const canonical = linked?.kind === 'terminal' && rowsFor(place).find(item => item.terminal?.sessionId === linked?.id && item.key !== linked?.key)
        open(place,canonical ? canonical.key : undefined)
      }
      const active = new Set([...next, ...(place ? rowsFor(place) : [])].map(item => item.key))
      if (selected && linked?.key === selected.key) active.add(selected.key)
      for (const [key,entry] of terminals) {
        if (active.has(key)) continue
        entry.thread.destroy()
        entry.host.remove()
        terminals.delete(key)
      }
    },
    refreshRecap() {
      for (const entry of terminals.values()) entry.thread.refreshRecap()
    },
    setPlaceMap,
    current: () => selected,
    /** @param {Place} where @param {Target} target */
    find(where, target) {
      return rowsFor(where).find(item => target.kind === item.kind && target.id === item.id
        || target.kind === 'terminal' && item.terminal?.sessionId === target.id)
    },
    linkedItem,
    destroy() {
      alive = false
      tabSize?.disconnect()
      menuListeners?.abort()
      toggle?.removeEventListener('click', togglePlaceMap)
      stopGraph()
      leaveContent()
      for (const entry of terminals.values()) entry.thread.destroy()
      terminals.clear()
    },
  }
}
